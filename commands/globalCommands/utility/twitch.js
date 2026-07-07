const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require(`discord.js`);
const { Servers, TwitchRoleConfigs, TwitchRoleLinks } = require(`../../../database/dbObjects.js`);
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
const { error: logError, warn } = require(`../../../utils/writeLog.js`);

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

function buildPanelComponents() {
	return [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`twitch:verify`)
				.setLabel(`Verify Twitch`)
				.setStyle(ButtonStyle.Primary),
		),
	];
}

function buildPanelContent() {
	return `## Twitch Verification
Click the button to verify your Twitch account with Hachi. If your Twitch account is a VIP or Moderator for the connected channel, Hachi will update your Discord roles.`;
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
	const moderatorRole = interaction.options.getRole(`moderator`);

	if (!vipRole && !moderatorRole) {
		await interaction.reply({
			content: `Choose at least one Discord role to map.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const existing = await TwitchRoleConfigs.findByPk(interaction.guild.id);
	const nextVipRoleId = vipRole?.id || existing?.vipRoleId || null;
	const nextModeratorRoleId = moderatorRole?.id || existing?.moderatorRoleId || null;

	if (nextVipRoleId && nextModeratorRoleId && nextVipRoleId === nextModeratorRoleId) {
		await interaction.reply({
			content: `VIP and Moderator must use different Discord roles so remove events stay safe.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		await ensureRoleIsAssignable(interaction, vipRole, `VIP`);
		await ensureRoleIsAssignable(interaction, moderatorRole, `Moderator`);
	} catch (err) {
		await interaction.reply({
			content: err.message,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await Servers.upsert({ guildId: interaction.guild.id });
	await TwitchRoleConfigs.upsert({
		guildId: interaction.guild.id,
		vipRoleId: nextVipRoleId,
		moderatorRoleId: nextModeratorRoleId,
	});

	interaction.client.twitchRoleEventSub?.restart();

	await interaction.reply({
		content: `Twitch role mappings saved.\nVIP: ${formatRole(nextVipRoleId)}\nModerator: ${formatRole(nextModeratorRoleId)}`,
		flags: MessageFlags.Ephemeral,
	});
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
			content: `You need Manage Server to post the Twitch verification panel.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.channel.send({
		content: buildPanelContent(),
		components: buildPanelComponents(),
	});

	await interaction.reply({
		content: `Twitch verification panel posted.`,
		flags: MessageFlags.Ephemeral,
	});
}

async function showStatus(interaction) {
	const [config, linkCount] = await Promise.all([
		TwitchRoleConfigs.findByPk(interaction.guild.id),
		TwitchRoleLinks.count({ where: { guildId: interaction.guild.id } }),
	]);

	await interaction.reply({
		content: `## Twitch Role Sync
- Broadcaster: ${formatBroadcaster(config)}
- VIP role: ${formatRole(config?.vipRoleId)}
- Moderator role: ${formatRole(config?.moderatorRoleId)}
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
		.setDescription(`Sync Twitch VIP and Moderator status to Discord roles.`)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`connect`)
				.setDescription(`Connect this server's Twitch broadcaster.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`roles`)
				.setDescription(`Map Twitch VIP and Moderator to Discord roles.`)
				.addRoleOption(option =>
					option
						.setName(`vip`)
						.setDescription(`Discord role for Twitch VIPs.`),
				)
				.addRoleOption(option =>
					option
						.setName(`moderator`)
						.setDescription(`Discord role for Twitch Moderators.`),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`verify`)
				.setDescription(`Verify your Twitch account for VIP/Moderator role sync.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`panel`)
				.setDescription(`Post a public Twitch verification button in this channel.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`sync`)
				.setDescription(`Reconcile linked users against Twitch VIP/Moderator lists now.`),
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
				description: `verify your Twitch account for VIP/Moderator role sync.`,
			},
			{
				command: `/twitch connect/roles/panel/sync`,
				description: `configure Twitch VIP and Moderator role sync.`,
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
		const [, action] = interaction.customId.split(`:`);

		if (action === `verify`) {
			await startMemberVerification(interaction);
		}
	},
};
