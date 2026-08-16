// /twitch command group.
// Component routing uses the persistent twitch:verify button prefix.
//
// Handles Twitch account verification and broadcaster role-sync setup. The
// command starts device-code flows, saves role mappings, posts verification
// panels, and triggers manual syncs.
const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require(`discord.js`);
const {
	Servers,
	TwitchRoleConfigs,
	TwitchRoleLinks,
	TwitchVerificationPanels,
} = require(`../../../database/dbObjects.js`);
const {
	BROADCASTER_SCOPES,
	MEMBER_SCOPES,
	canManageTwitchRoleSync,
	revokeToken,
	saveBroadcasterAuthorization,
	saveMemberLink,
	startDeviceAuthorization,
	syncGuildTwitchRoles,
	syncMemberTwitchRoles,
	validateToken,
	waitForDeviceAuthorization,
} = require(`../../../modules/twitchRoles.js`);
const { roleIsAssignable } = require(`../../../utils/reactionRoles.js`);
const {
	removeVerificationPanel,
	repairVerificationPanel,
	setVerificationPanel,
} = require(`../../../utils/twitchVerificationPanels.js`);
const { error: logError, warn } = require(`../../../utils/writeLog.js`);
const TWITCH_VERIFY_CUSTOM_ID = `twitch:verify`;

// Formatting helpers keep the status panel focused on setup state rather than
// leaking raw database nulls or provider IDs into user-facing text.
function formatRole(id) {
	return id ? `<@&${id}>` : `Not set`;
}

function formatBroadcaster(config) {
	if (!config?.broadcasterTwitchUserId) {
		return `Not connected`;
	}

	return `${config.broadcasterDisplayName || config.broadcasterLogin || config.broadcasterTwitchUserId} (${config.broadcasterTwitchUserId})`;
}

function formatLastSync(config) {
	if (!config?.lastSyncAt) {
		return `Never`;
	}

	return `<t:${Math.floor(new Date(config.lastSyncAt).getTime() / 1000)}:R>`;
}

function buildOpenTwitchComponents(device) {
	return [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setLabel(`Open Twitch`)
				.setStyle(ButtonStyle.Link)
				.setURL(device.verification_uri),
		),
	];
}

function buildDeviceContent(title, device) {
	return `${title}
Open Twitch and approve Hachi.

Activation code: \`${device.user_code}\`

This request expires in about ${Math.floor((Number(device.expires_in) || 0) / 60)} minutes.`;
}

async function safeFollowUp(interaction, payload) {
	try {
		await interaction.followUp({
			flags: MessageFlags.Ephemeral,
			...payload,
		});
	} catch (err) {
		warn(`Failed to send Twitch role verification follow-up: ${err.message}`);
	}
}

// The device-code flow is asynchronous after Discord receives the initial reply.
// This helper waits in the background and reports completion/failure with a
// follow-up instead of holding the interaction open.
function startPollingDeviceFlow(interaction, device, scopes, handler) {
	waitForDeviceAuthorization(device, scopes)
		.then(token => handler(token))
		.catch(err => safeFollowUp(interaction, {
			content: `Twitch authorization did not finish: ${err.message}`,
		}));
}

async function startBroadcasterConnect(interaction) {
	if (!canManageTwitchRoleSync(interaction, PermissionFlagsBits.ManageGuild)) {
		await interaction.reply({
			content: `You need Manage Server to connect the Twitch broadcaster for this server.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const device = await startDeviceAuthorization(BROADCASTER_SCOPES);

	await interaction.editReply({
		content: buildDeviceContent(`## Connect Twitch Broadcaster`, device),
		components: buildOpenTwitchComponents(device),
	});

	startPollingDeviceFlow(interaction, device, BROADCASTER_SCOPES, async (token) => {
		const validation = await validateToken(token.access_token);
		const config = await saveBroadcasterAuthorization({
			guildId: interaction.guild.id,
			requestedBy: interaction.user.id,
			token,
			validation,
		});

		interaction.client.twitchRoleEventSub?.restart();

		const syncResult = await syncGuildTwitchRoles(interaction.client, interaction.guild.id);
		const syncLine = syncResult.reason ?
			`Role sync skipped: ${syncResult.reason}` :
			`Role sync complete.`;

		await safeFollowUp(interaction, {
			content: `Connected Twitch broadcaster **${config.broadcasterLogin}** to this server.\n${syncLine}`,
		});
	});
}

async function startMemberVerification(interaction) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const device = await startDeviceAuthorization(MEMBER_SCOPES);

	await interaction.editReply({
		content: buildDeviceContent(`## Verify Twitch Account`, device),
		components: buildOpenTwitchComponents(device),
	});

	startPollingDeviceFlow(interaction, device, MEMBER_SCOPES, async (token) => {
		const validation = await validateToken(token.access_token);
		const link = await saveMemberLink({
			guildId: interaction.guild.id,
			discordUserId: interaction.user.id,
			validation,
		});

		await Promise.allSettled([
			revokeToken(token.access_token),
			revokeToken(token.refresh_token),
		]);

		const syncResult = await syncMemberTwitchRoles(interaction.client, interaction.guild.id, interaction.user.id);
		const syncLine = syncResult.reason ?
			`Role sync skipped: ${syncResult.reason}` :
			`Role sync complete.`;

		await safeFollowUp(interaction, {
			content: `Verified Twitch account **${link.twitchLogin}** for this server.\n${syncLine}`,
		});
	});
}

async function ensureRoleIsAssignable(interaction, role, label) {
	if (!role) {
		return;
	}

	await interaction.guild.roles.fetch().catch(() => null);
	await interaction.guild.members.fetchMe().catch(() => null);

	if (!roleIsAssignable(interaction.guild, role, interaction.member)) {
		throw new Error(`${label} role ${role} is not assignable. Move Hachi above it and make sure Hachi has Manage Roles.`);
	}
}

async function setRoleMappings(interaction) {
	if (!canManageTwitchRoleSync(interaction, PermissionFlagsBits.ManageRoles)) {
		await interaction.reply({
			content: `You need Manage Roles to configure Twitch role mappings.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const vipRole = interaction.options.getRole(`vip`);
	if (!vipRole) {
		await interaction.reply({
			content: `Choose at least one Discord role to map.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const existing = await TwitchRoleConfigs.findByPk(interaction.guild.id);
	const nextVipRoleId = vipRole?.id || existing?.vipRoleId || null;

	try {
		await ensureRoleIsAssignable(interaction, vipRole, `VIP`);
	} catch (err) {
		await interaction.reply({
			content: err.message,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	await Servers.upsert({ guildId: interaction.guild.id });
	await TwitchRoleConfigs.upsert({
		guildId: interaction.guild.id,
		vipRoleId: nextVipRoleId,
	});

	interaction.client.twitchRoleEventSub?.restart();
	const syncResult = await syncGuildTwitchRoles(interaction.client, interaction.guild.id);
	const cleanupWarning = syncResult.legacyModeratorCleanupPending ?
		`\nThe former Moderator role mapping could not be fully cleaned up yet; check Hachi's role hierarchy and run /twitch sync again.` :
		``;

	await interaction.editReply(`Twitch VIP role mapping saved.\nVIP: ${formatRole(nextVipRoleId)}${cleanupWarning}`);
}

async function syncNow(interaction) {
	if (!canManageTwitchRoleSync(interaction, PermissionFlagsBits.ManageRoles)) {
		await interaction.reply({
			content: `You need Manage Roles to sync Twitch roles.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const result = await syncGuildTwitchRoles(interaction.client, interaction.guild.id);

	if (result.reason) {
		await interaction.editReply(`Twitch role sync skipped: ${result.reason}`);
		return;
	}

	await interaction.editReply(`Role sync complete.`);
}

async function postVerificationPanel(interaction) {
	if (!canManageTwitchRoleSync(interaction, PermissionFlagsBits.ManageGuild)) {
		await interaction.reply({
			content: `You need Manage Server to manage the Twitch verification panel.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const action = interaction.options.getString?.(`action`) || `set`;
	if (action === `remove`) {
		const removed = await removeVerificationPanel(interaction.guild);
		await interaction.editReply(removed ? `Managed Twitch verification panel removed.` : `No managed Twitch verification panel is configured.`);
		return;
	}
	if (action === `refresh`) {
		const result = await repairVerificationPanel(interaction.client, interaction.guild.id, { force: true });
		await interaction.editReply(result.ok ? `Twitch verification panel refreshed.` : `Twitch verification panel could not be refreshed: ${result.reason}`);
		return;
	}
	const channel = interaction.options.getChannel?.(`channel`) || interaction.channel;
	await setVerificationPanel(interaction.guild, channel);
	await interaction.editReply(`Managed Twitch verification panel is now in <#${channel.id}>.`);
}

async function showStatus(interaction) {
	const [config, linkCount] = await Promise.all([
		TwitchRoleConfigs.findByPk(interaction.guild.id),
		TwitchRoleLinks.count({ where: { guildId: interaction.guild.id } }),
	]);
	const panel = await TwitchVerificationPanels.findByPk(interaction.guild.id);
	const panelStatus = panel ? `<#${panel.channelId}> — ${panel.failureCode ? `Needs attention (${panel.failureCode})` : `Healthy`}` : `Not configured`;

	await interaction.reply({
		content: `## Twitch Role Sync
- Broadcaster: ${formatBroadcaster(config)}
- VIP role: ${formatRole(config?.vipRoleId)}
- Verification panel: ${panelStatus}
- Verified users: ${linkCount}
- Last sync: ${formatLastSync(config)}`,
		flags: MessageFlags.Ephemeral,
	});
}

async function disconnectBroadcaster(interaction) {
	if (!canManageTwitchRoleSync(interaction, PermissionFlagsBits.ManageGuild)) {
		await interaction.reply({
			content: `You need Manage Server to disconnect Twitch role sync.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const config = await TwitchRoleConfigs.findByPk(interaction.guild.id);

	if (!config?.broadcasterTwitchUserId) {
		await interaction.reply({
			content: `No Twitch broadcaster is connected for this server.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await Promise.allSettled([
		revokeToken(config.accessToken),
		revokeToken(config.refreshToken),
	]);

	await config.update({
		broadcasterTwitchUserId: null,
		broadcasterLogin: null,
		broadcasterDisplayName: null,
		accessToken: null,
		refreshToken: null,
		tokenExpiresAt: null,
		scopes: null,
		connectedBy: null,
		connectedAt: null,
		lastSyncAt: null,
	});

	interaction.client.twitchRoleEventSub?.restart();

	await interaction.reply({
		content: `Twitch broadcaster disconnected. Existing verified user links and role mappings were kept.`,
		flags: MessageFlags.Ephemeral,
	});
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`twitch`)
		.setDescription(`Sync Twitch VIP status to a Discord role.`)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`connect`)
				.setDescription(`Connect this server's Twitch broadcaster.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`roles`)
				.setDescription(`Map Twitch VIP status to a Discord role.`)
				.addRoleOption(option =>
					option
						.setName(`vip`)
						.setDescription(`Discord role for Twitch VIPs.`)
						.setRequired(true),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`verify`)
				.setDescription(`Verify your Twitch account for VIP role sync.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`panel`)
				.setDescription(`Create, move, refresh, or remove the managed verification panel.`)
				.addChannelOption(option => option
					.setName(`channel`)
					.setDescription(`Channel for the managed panel; defaults to this channel.`)
					.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
				.addStringOption(option => option
					.setName(`action`)
					.setDescription(`Manage the existing panel.`)
					.addChoices(
						{ name: `Create or move`, value: `set` },
						{ name: `Refresh`, value: `refresh` },
						{ name: `Remove`, value: `remove` },
					)),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`sync`)
				.setDescription(`Reconcile linked users against the Twitch VIP list now.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`status`)
				.setDescription(`Show Twitch role sync setup for this server.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`disconnect`)
				.setDescription(`Disconnect the Twitch broadcaster for this server.`),
		)
		.setContexts(InteractionContextType.Guild),

	help: {
		category: `streams`,
		entries: [
			{
				command: `/twitch verify`,
				description: `verify your Twitch account for VIP role sync.`,
			},
			{
				command: `/twitch connect/roles/panel/sync`,
				description: `configure Twitch VIP role sync.`,
				permissions: [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.ManageRoles],
			},
		],
	},

	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();

		try {
			if (subcommand === `connect`) {
				await startBroadcasterConnect(interaction);
			} else if (subcommand === `roles`) {
				await setRoleMappings(interaction);
			} else if (subcommand === `verify`) {
				await startMemberVerification(interaction);
			} else if (subcommand === `panel`) {
				await postVerificationPanel(interaction);
			} else if (subcommand === `sync`) {
				await syncNow(interaction);
			} else if (subcommand === `status`) {
				await showStatus(interaction);
			} else if (subcommand === `disconnect`) {
				await disconnectBroadcaster(interaction);
			}
		} catch (err) {
			logError(`Failed to execute twitch ${subcommand}:`, err);

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({
					content: `Failed to run Twitch role command: ${err.message}`,
					flags: MessageFlags.Ephemeral,
				});
			} else {
				await interaction.reply({
					content: `Failed to run Twitch role command: ${err.message}`,
					flags: MessageFlags.Ephemeral,
				});
			}
		}
	},

	async handleComponent(interaction) {
		if (interaction.customId !== TWITCH_VERIFY_CUSTOM_ID) {
			return;
		}
		const [, action] = interaction.customId.split(`:`);

		if (action === `verify`) {
			await startMemberVerification(interaction);
		}
	},
};
