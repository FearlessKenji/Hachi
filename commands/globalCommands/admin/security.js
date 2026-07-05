const {
	ActionRowBuilder,
	ChannelSelectMenuBuilder,
	ChannelType,
	EmbedBuilder,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	ButtonBuilder,
	ButtonStyle,
} = require(`discord.js`);
const { CommandMonitorWhitelists, Servers } = require(`../../../database/dbObjects.js`);
const { error: logError } = require(`../../../utils/writeLog.js`);

const SECURITY_COLOR = 0xffb020;
const textChannelTypes = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
];
const pendingSecuritySetups = new Map();
const WHITELIST_TYPES = {
	APPLICATION: `application`,
	CHANNEL: `channel`,
};

async function getSecuritySettings(guildId) {
	const server = await Servers.findOne({
		raw: true,
		where: { guildId },
	});

	return {
		guildId,
		commandMonitoringEnabled: Boolean(server?.commandMonitoringEnabled),
		commandMonitoringChannelId: server?.commandMonitoringChannelId || null,
	};
}

async function getPendingSetup(interaction, setupId) {
	const pendingSetup = pendingSecuritySetups.get(setupId);

	if (!pendingSetup || pendingSetup.userId !== interaction.user.id || pendingSetup.guildId !== interaction.guild.id) {
		await interaction.update({
			content: `This security setup request is no longer available. Run \`/security setup\` again.`,
			components: [],
		});
		return null;
	}

	return pendingSetup;
}

function formatChannel(id) {
	return id ? `<#${id}>` : `Not set`;
}

function isSnowflake(value) {
	return /^\d{17,20}$/u.test(value);
}

function formatWhitelistTarget(entry) {
	if (entry.type === WHITELIST_TYPES.CHANNEL) {
		return `${formatChannel(entry.targetId)} (${entry.targetId})`;
	}

	return entry.label ? `${entry.label} (${entry.targetId})` : entry.targetId;
}

function buildSecurityContent(settings) {
	const status = settings.statusMessage ? `\n### ${settings.statusMessage}` : ``;

	return `## Security Reporting
### Application Command Reporting
- Monitor commands: ${settings.commandMonitoringEnabled ? `Yes` : `No`}
- Reporting channel: ${formatChannel(settings.commandMonitoringChannelId)}
${status}`;
}

function buildEnabledSelect(setupId) {
	return new ActionRowBuilder().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(`security:${setupId}:enabled`)
			.setPlaceholder(`Monitor commands?`)
			.addOptions(
				new StringSelectMenuOptionBuilder()
					.setLabel(`Yes`)
					.setValue(`yes`),
				new StringSelectMenuOptionBuilder()
					.setLabel(`No`)
					.setValue(`no`),
			),
	);
}

function buildChannelSelect(setupId) {
	return new ActionRowBuilder().addComponents(
		new ChannelSelectMenuBuilder()
			.setCustomId(`security:${setupId}:channel`)
			.setPlaceholder(`Reporting channel:`)
			.setChannelTypes(textChannelTypes),
	);
}

function buildButtonRow(setupId, parentSetupId = null) {
	const buttons = [
		new ButtonBuilder()
			.setCustomId(`security:${setupId}:submit`)
			.setLabel(`Submit`)
			.setStyle(ButtonStyle.Success),
	];

	if (parentSetupId) {
		buttons.push(
			new ButtonBuilder()
				.setCustomId(`setup:${parentSetupId}:home`)
				.setLabel(`Back to Setup`)
				.setStyle(ButtonStyle.Secondary),
		);
	}

	return new ActionRowBuilder().addComponents(buttons);
}

function buildSetupComponents(setupId, settings) {
	const components = [buildEnabledSelect(setupId)];

	if (settings.commandMonitoringEnabled) {
		components.push(buildChannelSelect(setupId));
	}

	components.push(buildButtonRow(setupId, settings.parentSetupId));

	return components;
}

async function openSetupPanel(interaction, { parentSetupId = null, update = false } = {}) {
	const setupId = interaction.id;
	const settings = await getSecuritySettings(interaction.guild.id);
	const pendingSetup = {
		...settings,
		parentSetupId,
		userId: interaction.user.id,
	};

	pendingSecuritySetups.set(setupId, pendingSetup);

	const payload = {
		content: buildSecurityContent(pendingSetup),
		components: buildSetupComponents(setupId, pendingSetup),
	};

	if (update) {
		await interaction.update({
			...payload,
			embeds: [],
		});
		return;
	}

	await interaction.reply({
		...payload,
		flags: MessageFlags.Ephemeral,
	});
}

async function submitSetup(interaction, setupId, pendingSetup) {
	if (pendingSetup.commandMonitoringEnabled && !pendingSetup.commandMonitoringChannelId) {
		pendingSetup.statusMessage = `Select a reporting channel before submitting.`;
		await interaction.update({
			content: buildSecurityContent(pendingSetup),
			components: buildSetupComponents(setupId, pendingSetup),
		});
		return;
	}

	await Servers.upsert({
		guildId: pendingSetup.guildId,
		commandMonitoringEnabled: pendingSetup.commandMonitoringEnabled,
		commandMonitoringChannelId: pendingSetup.commandMonitoringChannelId,
	});

	pendingSecuritySetups.delete(setupId);

	await interaction.update({
		content: `${buildSecurityContent(pendingSetup)}\n### Settings saved.`,
		components: [],
	});
}

async function handleSetupComponent(interaction, setupId, action) {
	const pendingSetup = await getPendingSetup(interaction, setupId);

	if (!pendingSetup) {
		return;
	}

	pendingSetup.statusMessage = null;

	if (action === `enabled`) {
		pendingSetup.commandMonitoringEnabled = interaction.values[0] === `yes`;

		if (!pendingSetup.commandMonitoringEnabled) {
			pendingSetup.commandMonitoringChannelId = null;
		}
	} else if (action === `channel`) {
		pendingSetup.commandMonitoringChannelId = interaction.values[0] || null;
	} else if (action === `submit`) {
		await submitSetup(interaction, setupId, pendingSetup);
		return;
	}

	await interaction.update({
		content: buildSecurityContent(pendingSetup),
		components: buildSetupComponents(setupId, pendingSetup),
	});
}

function buildStatusEmbed(settings) {
	return new EmbedBuilder()
		.setColor(SECURITY_COLOR)
		.setTitle(`Security Reporting`)
		.addFields(
			{ name: `Application Command Reporting`, value: settings.commandMonitoringEnabled ? `Enabled` : `Disabled`, inline: true },
			{ name: `Reporting Channel`, value: formatChannel(settings.commandMonitoringChannelId), inline: true },
		);
}

async function auditSecurity(interaction) {
	const settings = await getSecuritySettings(interaction.guild.id);
	const lines = [];

	if (!settings.commandMonitoringEnabled) {
		lines.push(`- Application command reporting is disabled.`);
	} else if (!settings.commandMonitoringChannelId) {
		lines.push(`- Reporting is enabled, but no channel is configured.`);
	} else {
		const channel = await interaction.guild.channels.fetch(settings.commandMonitoringChannelId).catch(() => null);
		const permissions = channel?.permissionsFor(interaction.guild.members.me);

		if (!channel?.send) {
			lines.push(`- Reporting channel could not be fetched or is not writable.`);
		} else if (!permissions?.has([
			PermissionFlagsBits.ViewChannel,
			PermissionFlagsBits.SendMessages,
			PermissionFlagsBits.EmbedLinks,
		])) {
			lines.push(`- Hachi cannot send embeds in ${formatChannel(settings.commandMonitoringChannelId)}.`);
		} else {
			lines.push(`- Reporting channel is reachable.`);
		}
	}

	return new EmbedBuilder()
		.setColor(SECURITY_COLOR)
		.setTitle(`Security Audit`)
		.setDescription(lines.join(`\n`));
}

async function addWhitelistEntry(interaction, type, targetId, label = null) {
	await Servers.upsert({ guildId: interaction.guild.id });

	const [entry, created] = await CommandMonitorWhitelists.findOrCreate({
		defaults: {
			guildId: interaction.guild.id,
			type,
			targetId,
			label,
			createdBy: interaction.user.id,
			createdAt: new Date(),
		},
		where: {
			guildId: interaction.guild.id,
			type,
			targetId,
		},
	});

	if (!created && label && entry.label !== label) {
		await entry.update({ label });
	}

	return { created, entry };
}

async function removeWhitelistEntry(interaction, type, targetId) {
	return CommandMonitorWhitelists.destroy({
		where: {
			guildId: interaction.guild.id,
			type,
			targetId,
		},
	});
}

function buildWhitelistListEmbed(entries) {
	const appEntries = entries.filter(entry => entry.type === WHITELIST_TYPES.APPLICATION);
	const channelEntries = entries.filter(entry => entry.type === WHITELIST_TYPES.CHANNEL);
	const formatEntries = list => list.length ?
		list.map(entry => `- ${formatWhitelistTarget(entry)}`).join(`\n`) :
		`None`;

	return new EmbedBuilder()
		.setColor(SECURITY_COLOR)
		.setTitle(`Command Monitoring Whitelist`)
		.setDescription(`Whitelisted apps and channels suppress application-command monitoring reports only.`)
		.addFields(
			{ name: `Applications`, value: formatEntries(appEntries).slice(0, 1024), inline: false },
			{ name: `Channels`, value: formatEntries(channelEntries).slice(0, 1024), inline: false },
		);
}

async function handleWhitelistApp(interaction) {
	const action = interaction.options.getString(`action`, true);
	const applicationId = interaction.options.getString(`application_id`, true).trim();
	const label = interaction.options.getString(`name`)?.trim() || null;

	if (!isSnowflake(applicationId)) {
		await interaction.reply({ content: `Application ID must be a Discord snowflake ID.`, flags: MessageFlags.Ephemeral });
		return;
	}

	if (action === `add`) {
		const result = await addWhitelistEntry(interaction, WHITELIST_TYPES.APPLICATION, applicationId, label);

		await interaction.reply({
			content: result.created ?
				`Whitelisted application ${label ? `**${label}** ` : ``}(${applicationId}).` :
				`Application ${applicationId} was already whitelisted${label ? `; label updated to **${label}**.` : `.`}`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const removed = await removeWhitelistEntry(interaction, WHITELIST_TYPES.APPLICATION, applicationId);

	await interaction.reply({
		content: removed ? `Removed application ${applicationId} from the whitelist.` : `Application ${applicationId} was not whitelisted.`,
		flags: MessageFlags.Ephemeral,
	});
}

async function handleWhitelistChannel(interaction) {
	const action = interaction.options.getString(`action`, true);
	const channel = interaction.options.getChannel(`channel`, true);

	if (action === `add`) {
		const result = await addWhitelistEntry(interaction, WHITELIST_TYPES.CHANNEL, channel.id, channel.name || null);

		await interaction.reply({
			content: result.created ? `Whitelisted ${channel}.` : `${channel} was already whitelisted.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const removed = await removeWhitelistEntry(interaction, WHITELIST_TYPES.CHANNEL, channel.id);

	await interaction.reply({
		content: removed ? `Removed ${channel} from the whitelist.` : `${channel} was not whitelisted.`,
		flags: MessageFlags.Ephemeral,
	});
}

async function handleWhitelistCommand(interaction, subcommand) {
	if (subcommand === `app`) {
		await handleWhitelistApp(interaction);
	} else if (subcommand === `channel`) {
		await handleWhitelistChannel(interaction);
	} else if (subcommand === `list`) {
		const entries = await CommandMonitorWhitelists.findAll({
			order: [[`type`, `ASC`], [`label`, `ASC`], [`targetId`, `ASC`]],
			raw: true,
			where: { guildId: interaction.guild.id },
		});

		await interaction.reply({
			embeds: [buildWhitelistListEmbed(entries)],
			flags: MessageFlags.Ephemeral,
		});
	}
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`security`)
		.setDescription(`Configure and review security reporting.`)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`setup`)
				.setDescription(`Configure application command reporting.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`status`)
				.setDescription(`Show current security reporting settings.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`audit`)
				.setDescription(`Check whether security reporting can post alerts.`),
		)
		.addSubcommandGroup(group =>
			group
				.setName(`whitelist`)
				.setDescription(`Manage command-monitoring whitelist entries.`)
				.addSubcommand(subcommand =>
					subcommand
						.setName(`app`)
						.setDescription(`Add or remove an application ID from the whitelist.`)
						.addStringOption(option =>
							option
								.setName(`action`)
								.setDescription(`Whether to add or remove this application.`)
								.setRequired(true)
								.addChoices(
									{ name: `Add`, value: `add` },
									{ name: `Remove`, value: `remove` },
								),
						)
						.addStringOption(option =>
							option
								.setName(`application_id`)
								.setDescription(`Discord application ID.`)
								.setRequired(true),
						)
						.addStringOption(option =>
							option
								.setName(`name`)
								.setDescription(`Optional readable label, such as Wordle.`),
						),
				)
				.addSubcommand(subcommand =>
					subcommand
						.setName(`channel`)
						.setDescription(`Add or remove a channel from the whitelist.`)
						.addStringOption(option =>
							option
								.setName(`action`)
								.setDescription(`Whether to add or remove this channel.`)
								.setRequired(true)
								.addChoices(
									{ name: `Add`, value: `add` },
									{ name: `Remove`, value: `remove` },
								),
						)
						.addChannelOption(option =>
							option
								.setName(`channel`)
								.setDescription(`Channel to update.`)
								.addChannelTypes(...textChannelTypes)
								.setRequired(true),
						),
				)
				.addSubcommand(subcommand =>
					subcommand
						.setName(`list`)
						.setDescription(`List command-monitoring whitelist entries.`),
				),
		)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild),

	help: {
		category: `security`,
		permissions: [PermissionFlagsBits.ManageGuild],
		entries: [
			{
				command: `/security setup`,
				description: `configure application command reporting.`,
			},
			{
				command: `/security whitelist app/channel`,
				description: `suppress trusted apps or channels from monitoring reports.`,
			},
			{
				command: `/security status/audit`,
				description: `review command-monitoring configuration.`,
			},
		],
	},

	async execute(interaction) {
		const group = interaction.options.getSubcommandGroup(false);
		const subcommand = interaction.options.getSubcommand();

		try {
			if (group === `whitelist`) {
				await handleWhitelistCommand(interaction, subcommand);
			} else if (subcommand === `setup`) {
				await openSetupPanel(interaction);
			} else if (subcommand === `status`) {
				const settings = await getSecuritySettings(interaction.guild.id);

				await interaction.reply({
					embeds: [buildStatusEmbed(settings)],
					flags: MessageFlags.Ephemeral,
				});
			} else if (subcommand === `audit`) {
				await interaction.reply({
					embeds: [await auditSecurity(interaction)],
					flags: MessageFlags.Ephemeral,
				});
			}
		} catch (err) {
			logError(`Failed to execute security command:`, err);
			await interaction.reply({ content: `Failed to execute security command.`, flags: MessageFlags.Ephemeral });
		}
	},

	async handleComponent(interaction) {
		const [, setupId, action] = interaction.customId.split(`:`);

		try {
			await handleSetupComponent(interaction, setupId, action);
		} catch (err) {
			logError(`Failed to update security setup:`, err);

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: `Failed to update security setup.`, flags: MessageFlags.Ephemeral });
			} else {
				await interaction.reply({ content: `Failed to update security setup.`, flags: MessageFlags.Ephemeral });
			}
		}
	},

	openSetupPanel,
};
