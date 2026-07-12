// /raid command group.
//
// Administrators configure raid-protection policy here. The command also exposes
// status, audit, drill, incident, report, evidence, quarantine, release, and
// permission-sync flows backed by utils/raidProtection.js.
const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelSelectMenuBuilder,
	ChannelType,
	EmbedBuilder,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	RoleSelectMenuBuilder,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
} = require(`discord.js`);
const {
	auditRaidConfiguration,
	buildIncidentEmbed,
	buildRaidAuditEmbed,
	buildRaidDrill,
	buildRaidStatusEmbed,
	formatChannel,
	formatRole,
	formatYesNo,
	getIncidentDetails,
	getRaidConfig,
	listRecentIncidents,
	postIncidentEvidence,
	postIncidentReport,
	quarantineUser,
	releaseUser,
	saveRaidConfig,
	syncQuarantineOverwrites,
} = require(`../../../utils/raidProtection.js`);
const { error: logError } = require(`../../../utils/writeLog.js`);

const RAID_COLOR = 0xed4245;
const QUARANTINE_ROLE_NAME = `Quarantine`;
// Setup and sync confirmations are temporary Discord component flows. The saved
// policy lives in RaidConfigs; these maps only hold drafts until the user clicks
// Submit/Confirm or the process restarts.
const pendingRaidSetups = new Map();
const pendingRaidSyncs = new Map();
const textChannelTypes = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
];

// Component builders below keep customId construction consistent. Handlers parse
// those IDs to know which setup draft, page, and field a user is changing.
function buildYesNoSelect(customId, placeholder) {
	return new ActionRowBuilder().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(customId)
			.setPlaceholder(placeholder)
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

function buildNumberSelect(customId, placeholder, values) {
	return new ActionRowBuilder().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(customId)
			.setPlaceholder(placeholder)
			.addOptions(values.map(value =>
				new StringSelectMenuOptionBuilder()
					.setLabel(String(value))
					.setValue(String(value)),
			)),
	);
}

function buildChannelSelect(customId, placeholder) {
	return new ActionRowBuilder().addComponents(
		new ChannelSelectMenuBuilder()
			.setCustomId(customId)
			.setPlaceholder(placeholder)
			.setChannelTypes(textChannelTypes),
	);
}

function buildRoleSelect(customId, placeholder) {
	return new ActionRowBuilder().addComponents(
		new RoleSelectMenuBuilder()
			.setCustomId(customId)
			.setPlaceholder(placeholder),
	);
}

// Raid protection can only be enabled when every destination/action dependency
// is selected. This helper produces the exact user-facing reason when not ready.
function getRaidConfigurationError(config) {
	if (!config.alertChannelId) {
		return `Select a mod alert channel before enabling raid protection.`;
	}

	if (!config.reportChannelId) {
		return `Select a raid report channel before enabling raid protection.`;
	}

	if (!config.moderatorRoleId) {
		return `Select a moderator alert role before enabling raid protection.`;
	}

	if (config.actionQuarantine && !config.quarantineRoleId) {
		return `Select a quarantine role or disable the quarantine action.`;
	}

	return null;
}

function formatRaidEnabledState(config) {
	if (config.enabled) {
		return `Yes`;
	}

	return getRaidConfigurationError(config) ?
		`No. Improper configuration.` :
		`No. Ready to enable.`;
}

// The home page is the setup wizard's table of contents and status summary. It
// mirrors the saved config shape so administrators can review all policy choices
// before submitting.
function buildHomeContent(config) {
	const status = config.statusMessage ? `\n### ${config.statusMessage}` : ``;

	return `## Raid Protection Setup
- Enabled: ${formatRaidEnabledState(config)}
- Quarantine Role: ${formatRole(config.quarantineRoleId)}
- Alert Channel: ${formatChannel(config.alertChannelId)}
- Report Channel: ${formatChannel(config.reportChannelId)}
- Moderator Role: ${formatRole(config.moderatorRoleId)}
- Message Spam: ${config.messageSpamCount} messages / ${config.messageSpamSeconds}s
- Join Spike: ${config.joinSpikeCount} joins / ${config.joinSpikeSeconds}s
- Quarantine: ${formatYesNo(config.actionQuarantine)}
- Timeout: ${formatYesNo(config.actionTimeout)} (${config.timeoutMinutes}m)
- Delete Spam: ${formatYesNo(config.actionDelete)}${status}`;
}

function buildBackToSetupButton(parentSetupId) {
	if (!parentSetupId) {
		return null;
	}

	return new ButtonBuilder()
		.setCustomId(`setup:${parentSetupId}:home`)
		.setLabel(`Back to Setup`)
		.setStyle(ButtonStyle.Secondary);
}

function buildHomeComponents(setupId, parentSetupId = null) {
	const components = [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`raid:${setupId}:setup:page:toggles`)
				.setLabel(`Roles`)
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId(`raid:${setupId}:setup:page:destinations`)
				.setLabel(`Channels`)
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId(`raid:${setupId}:setup:page:thresholds`)
				.setLabel(`Thresholds`)
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId(`raid:${setupId}:setup:page:actions`)
				.setLabel(`Actions`)
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId(`raid:${setupId}:setup:submit`)
				.setLabel(`Submit`)
				.setStyle(ButtonStyle.Success),
		),
	];

	const backToSetupButton = buildBackToSetupButton(parentSetupId);

	if (backToSetupButton) {
		components.push(new ActionRowBuilder().addComponents(backToSetupButton));
	}

	return components;
}

function buildBackRow(setupId, parentSetupId = null) {
	const buttons = [
		new ButtonBuilder()
			.setCustomId(`raid:${setupId}:setup:page:home`)
			.setLabel(`Back`)
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(`raid:${setupId}:setup:submit`)
			.setLabel(`Submit`)
			.setStyle(ButtonStyle.Success),
	];
	const backToSetupButton = buildBackToSetupButton(parentSetupId);

	if (backToSetupButton) {
		buttons.push(backToSetupButton);
	}

	return new ActionRowBuilder().addComponents(buttons);
}

function buildRolesContent(config) {
	const status = config.statusMessage ? `\n### ${config.statusMessage}` : ``;

	return `## Raid Roles
- Enabled: ${formatYesNo(config.enabled)}
- Quarantine Role: ${formatRole(config.quarantineRoleId)}
- Moderator Role: ${formatRole(config.moderatorRoleId)}${status}`;
}

function buildCreateQuarantineRoleRow(setupId) {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`raid:${setupId}:setup:createQuarantineRole`)
			.setLabel(`Create Quarantine Role`)
			.setStyle(ButtonStyle.Secondary),
	);
}

function buildRolesComponents(setupId, parentSetupId = null) {
	return [
		buildYesNoSelect(`raid:${setupId}:setup:enabled`, `Raid protection enabled?`),
		buildRoleSelect(`raid:${setupId}:setup:quarantineRole`, `Quarantine role:`),
		buildRoleSelect(`raid:${setupId}:setup:moderatorRole`, `Moderator alert role:`),
		buildCreateQuarantineRoleRow(setupId),
		buildBackRow(setupId, parentSetupId),
	];
}

function buildDestinationsContent(config) {
	return `## Raid Channels
- Alert Channel: ${formatChannel(config.alertChannelId)}
- Report Channel: ${formatChannel(config.reportChannelId)}`;
}

function buildDestinationsComponents(setupId, parentSetupId = null) {
	return [
		buildChannelSelect(`raid:${setupId}:setup:alertChannel`, `Mod alert channel:`),
		buildChannelSelect(`raid:${setupId}:setup:reportChannel`, `Raid report channel:`),
		buildBackRow(setupId, parentSetupId),
	];
}

function buildThresholdContent(config) {
	return `## Raid Thresholds
- Message/App Spam: ${config.messageSpamCount} messages in ${config.messageSpamSeconds} seconds
- Join Spike: ${config.joinSpikeCount} joins in ${config.joinSpikeSeconds} seconds`;
}

function buildThresholdComponents(setupId, parentSetupId = null) {
	return [
		buildNumberSelect(`raid:${setupId}:setup:messageSpamCount`, `Message count:`, [3, 4, 5, 6, 8, 10]),
		buildNumberSelect(`raid:${setupId}:setup:messageSpamSeconds`, `Message window seconds:`, [3, 5, 8, 10, 15, 30]),
		buildNumberSelect(`raid:${setupId}:setup:joinSpikeCount`, `Join count:`, [3, 4, 5, 6, 8, 10, 15, 20]),
		buildNumberSelect(`raid:${setupId}:setup:joinSpikeSeconds`, `Join window seconds:`, [3, 5, 8, 10, 15, 30]),
		buildBackRow(setupId, parentSetupId),
	];
}

function buildActionContent(config) {
	return `## Raid Actions
- Assign quarantine role: ${formatYesNo(config.actionQuarantine)}
- Timeout users: ${formatYesNo(config.actionTimeout)}
- Timeout duration: ${config.timeoutMinutes} minutes
- Delete spam messages: ${formatYesNo(config.actionDelete)}`;
}

function buildActionComponents(setupId, parentSetupId = null) {
	return [
		buildYesNoSelect(`raid:${setupId}:setup:actionQuarantine`, `Assign quarantine role?`),
		buildYesNoSelect(`raid:${setupId}:setup:actionTimeout`, `Timeout users?`),
		buildNumberSelect(`raid:${setupId}:setup:timeoutMinutes`, `Timeout duration minutes:`, [10, 30, 60, 180, 360, 1440]),
		buildYesNoSelect(`raid:${setupId}:setup:actionDelete`, `Delete spam messages?`),
		buildBackRow(setupId, parentSetupId),
	];
}

async function getPendingSetup(interaction, setupId) {
	const pendingSetup = pendingRaidSetups.get(setupId);

	if (!pendingSetup || pendingSetup.userId !== interaction.user.id || pendingSetup.guildId !== interaction.guild.id) {
		await interaction.update({
			content: `This raid setup request is no longer available. Run \`/raid setup\` again.`,
			components: [],
		});
		return null;
	}

	return pendingSetup;
}

async function updateSetup(interaction, content, components) {
	await interaction.update({ content, components });
}

async function showHome(interaction, setupId, pendingSetup) {
	await updateSetup(interaction, buildHomeContent(pendingSetup), buildHomeComponents(setupId, pendingSetup.parentSetupId));
}

async function showPage(interaction, setupId, pendingSetup, page) {
	if (page === `toggles`) {
		await updateSetup(interaction, buildRolesContent(pendingSetup), buildRolesComponents(setupId, pendingSetup.parentSetupId));
	} else if (page === `destinations`) {
		await updateSetup(interaction, buildDestinationsContent(pendingSetup), buildDestinationsComponents(setupId, pendingSetup.parentSetupId));
	} else if (page === `thresholds`) {
		await updateSetup(interaction, buildThresholdContent(pendingSetup), buildThresholdComponents(setupId, pendingSetup.parentSetupId));
	} else if (page === `actions`) {
		await updateSetup(interaction, buildActionContent(pendingSetup), buildActionComponents(setupId, pendingSetup.parentSetupId));
	} else {
		await showHome(interaction, setupId, pendingSetup);
	}
}

function validateSetup(pendingSetup) {
	if (!pendingSetup.enabled) {
		return null;
	}

	return getRaidConfigurationError(pendingSetup);
}

async function createOrSelectQuarantineRole(interaction, selectedRoleId) {
	if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
		return { statusMessage: `You need Manage Roles to create a quarantine role.` };
	}

	const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);

	if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
		return { statusMessage: `Hachi needs Manage Roles to create a quarantine role.` };
	}

	await interaction.guild.roles.fetch().catch(() => null);

	const selectedRole = selectedRoleId ? interaction.guild.roles.cache.get(selectedRoleId) : null;

	if (selectedRole) {
		return { statusMessage: `Quarantine role is already set to ${selectedRole}.` };
	}

	const existingRole = interaction.guild.roles.cache.find(role =>
		!role.managed && role.name.toLowerCase() === QUARANTINE_ROLE_NAME.toLowerCase(),
	);
	let role = existingRole;
	let created = false;

	if (!role) {
		try {
			role = await interaction.guild.roles.create({
				name: QUARANTINE_ROLE_NAME,
				permissions: [],
				mentionable: false,
				reason: `Raid protection quarantine role created by ${interaction.user.tag}`,
			});
			created = true;
		} catch (err) {
			logError(`Failed to create quarantine role:`, err);
			return { statusMessage: `Hachi could not create the quarantine role. Check Manage Roles and role hierarchy.` };
		}
	}

	const actionText = created ?
		`Created and selected ${role} with no server-wide permissions.` :
		`Selected existing ${role}.`;
	const hierarchyText = role.comparePositionTo(botMember.roles.highest) >= 0 ?
		` Move it below Hachi before raid protection can assign it.` :
		` Save settings, then use \`/raid sync\` to apply channel/category denies.`;

	return {
		quarantineRoleId: role.id,
		statusMessage: `${actionText}${hierarchyText}`,
	};
}

async function submitSetup(interaction, setupId, pendingSetup) {
	const validationError = validateSetup(pendingSetup);

	if (validationError) {
		pendingSetup.statusMessage = validationError;
		await showHome(interaction, setupId, pendingSetup);
		return;
	}

	pendingSetup.statusMessage = null;
	await saveRaidConfig(pendingSetup.guildId, pendingSetup);
	pendingRaidSetups.delete(setupId);

	await updateSetup(
		interaction,
		`${buildHomeContent(pendingSetup)}
### Settings saved.
- Run \`/raid audit\` to check quarantine reliability.`,
		[],
	);
}

async function handleSetupField(interaction, setupId, pendingSetup, action, field) {
	pendingSetup.statusMessage = null;

	if (action === `page`) {
		pendingSetup.currentPage = field === `home` ? null : field;
		await showPage(interaction, setupId, pendingSetup, field);
		return;
	}

	if (action === `submit`) {
		await submitSetup(interaction, setupId, pendingSetup);
		return;
	}

	if (action === `createQuarantineRole`) {
		Object.assign(pendingSetup, await createOrSelectQuarantineRole(interaction, pendingSetup.quarantineRoleId));
		await showPage(interaction, setupId, pendingSetup, `toggles`);
		return;
	}

	const selectedValue = interaction.values?.[0] || null;

	if (action === `enabled`) {
		pendingSetup.enabled = selectedValue === `yes`;
	} else if (action === `quarantineRole`) {
		pendingSetup.quarantineRoleId = selectedValue;
	} else if (action === `moderatorRole`) {
		pendingSetup.moderatorRoleId = selectedValue;
	} else if (action === `alertChannel`) {
		pendingSetup.alertChannelId = selectedValue;
	} else if (action === `reportChannel`) {
		pendingSetup.reportChannelId = selectedValue;
	} else if ([`messageSpamCount`, `messageSpamSeconds`, `joinSpikeCount`, `joinSpikeSeconds`, `timeoutMinutes`].includes(action)) {
		pendingSetup[action] = Number(selectedValue);
	} else if ([`actionQuarantine`, `actionTimeout`, `actionDelete`].includes(action)) {
		pendingSetup[action] = selectedValue === `yes`;
	}

	if (pendingSetup.currentPage) {
		await showPage(interaction, setupId, pendingSetup, pendingSetup.currentPage);
	} else {
		await showHome(interaction, setupId, pendingSetup);
	}
}

async function openSetupPanel(interaction, { parentSetupId = null, update = false } = {}) {
	const setupId = interaction.id;
	const config = await getRaidConfig(interaction.guild.id, { create: true });
	const pendingSetup = {
		...config,
		currentPage: null,
		parentSetupId,
		userId: interaction.user.id,
	};

	pendingRaidSetups.set(setupId, pendingSetup);

	const payload = {
		content: buildHomeContent(pendingSetup),
		components: buildHomeComponents(setupId, pendingSetup.parentSetupId),
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

function buildIncidentListEmbed(incidents) {
	const lines = incidents.map(incident => {
		const started = Math.floor(new Date(incident.startedAt).getTime() / 1000);

		return `#${incident.id} - ${incident.triggerType} - ${incident.status} - <t:${started}:R>`;
	});

	return new EmbedBuilder()
		.setColor(RAID_COLOR)
		.setTitle(`Recent Raid Incidents`)
		.setDescription(lines.length ? lines.join(`\n`) : `No raid incidents recorded.`);
}

function buildSyncResultEmbed(result) {
	return new EmbedBuilder()
		.setColor(result.errors.length ? RAID_COLOR : 0x57f287)
		.setTitle(`Quarantine Overwrite Sync`)
		.addFields(
			{ name: `Applied`, value: String(result.applied), inline: true },
			{ name: `Skipped`, value: String(result.skipped), inline: true },
			{
				name: `Errors`,
				value: result.errors.length ? result.errors.slice(0, 10).map(item => `- ${item}`).join(`\n`) : `None`,
				inline: false,
			},
		)
		.setFooter({ text: `Review intentionally visible channels after syncing, such as rules channels.` });
}

function buildSyncConfirmEmbed(config) {
	return new EmbedBuilder()
		.setColor(RAID_COLOR)
		.setTitle(`Confirm Quarantine Sync`)
		.setDescription(`This will add or update quarantine deny overwrites across supported channels and categories where Hachi can edit permission overwrites.`)
		.addFields(
			{ name: `Quarantine Role`, value: formatRole(config.quarantineRoleId), inline: true },
			{ name: `Review Afterward`, value: `Check channels that should stay visible, such as rules or information channels.`, inline: false },
		);
}

function buildSyncConfirmComponents(syncId) {
	return [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`raid:${syncId}:sync:confirm`)
				.setLabel(`Apply Sync`)
				.setStyle(ButtonStyle.Danger),
			new ButtonBuilder()
				.setCustomId(`raid:${syncId}:sync:cancel`)
				.setLabel(`Cancel`)
				.setStyle(ButtonStyle.Secondary),
		),
	];
}

async function openSyncConfirmation(interaction) {
	const config = await getRaidConfig(interaction.guild.id);
	const syncId = interaction.id;

	pendingRaidSyncs.set(syncId, {
		guildId: interaction.guild.id,
		userId: interaction.user.id,
	});

	await interaction.reply({
		embeds: [buildSyncConfirmEmbed(config)],
		components: buildSyncConfirmComponents(syncId),
		flags: MessageFlags.Ephemeral,
	});
}

async function handleSyncComponent(interaction, syncId, action) {
	const pendingSync = pendingRaidSyncs.get(syncId);

	if (!pendingSync || pendingSync.userId !== interaction.user.id || pendingSync.guildId !== interaction.guild.id) {
		await interaction.update({
			content: `This sync confirmation is no longer available. Run \`/raid sync\` again.`,
			components: [],
			embeds: [],
		});
		return;
	}

	pendingRaidSyncs.delete(syncId);

	if (action === `cancel`) {
		await interaction.update({
			content: `No changes made.`,
			components: [],
			embeds: [],
		});
		return;
	}

	await interaction.update({
		content: `Applying quarantine sync. This can take a bit on larger servers.`,
		components: [],
		embeds: [],
	});

	try {
		const config = await getRaidConfig(interaction.guild.id);
		const result = await syncQuarantineOverwrites(interaction.guild, config);

		await interaction.editReply({
			content: ``,
			components: [],
			embeds: [buildSyncResultEmbed(result)],
		});
	} catch (err) {
		logError(`Failed to apply quarantine overwrite sync:`, err);

		await interaction.editReply({
			content: `Failed to apply quarantine sync: ${err.message}`,
			components: [],
			embeds: [],
		}).catch(replyErr => {
			logError(`Failed to update quarantine sync failure message:`, replyErr);
		});
	}
}

async function replyWithError(interaction, content) {
	await interaction.reply({
		content,
		flags: MessageFlags.Ephemeral,
	});
}

async function sendRaidErrorResponse(interaction, content) {
	try {
		if (interaction.replied || interaction.deferred) {
			await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
		} else {
			await interaction.reply({ content, flags: MessageFlags.Ephemeral });
		}
	} catch (err) {
		logError(`Failed to send raid error response:`, err);
	}
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`raid`)
		.setDescription(`Configure and operate raid protection.`)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`setup`)
				.setDescription(`Configure raid protection.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`status`)
				.setDescription(`Show raid protection settings.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`audit`)
				.setDescription(`Check raid protection readiness.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`drill`)
				.setDescription(`Send dry-run raid alerts and reports without actions or pings.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`incidents`)
				.setDescription(`List recent raid incidents.`)
				.addIntegerOption(option =>
					option
						.setName(`limit`)
						.setDescription(`Number of incidents to show.`)
						.setMinValue(1)
						.setMaxValue(20),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`incident`)
				.setDescription(`Show a raid incident.`)
				.addIntegerOption(option =>
					option
						.setName(`id`)
						.setDescription(`Incident ID.`)
						.setRequired(true),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`report`)
				.setDescription(`Post a raid report to the configured report channel.`)
				.addIntegerOption(option =>
					option
						.setName(`id`)
						.setDescription(`Incident ID.`)
						.setRequired(true),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`evidence`)
				.setDescription(`Post stored raid evidence to the configured report channel.`)
				.addIntegerOption(option =>
					option
						.setName(`id`)
						.setDescription(`Incident ID.`)
						.setRequired(true),
				)
				.addStringOption(option =>
					option
						.setName(`mode`)
						.setDescription(`Evidence format.`)
						.addChoices(
							{ name: `Summary`, value: `summary` },
							{ name: `Verbatim`, value: `verbatim` },
						),
				)
				.addBooleanOption(option =>
					option
						.setName(`include_files`)
						.setDescription(`Re-upload locally archived files when using verbatim mode.`),
				)
				.addIntegerOption(option =>
					option
						.setName(`limit`)
						.setDescription(`Maximum unique message types to post in verbatim mode.`)
						.setMinValue(1)
						.setMaxValue(25),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`sync`)
				.setDescription(`Confirm and apply quarantine denies across channels and categories.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`quarantine`)
				.setDescription(`Manually assign the quarantine role to a user.`)
				.addUserOption(option =>
					option
						.setName(`user`)
						.setDescription(`User to quarantine.`)
						.setRequired(true),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`release`)
				.setDescription(`Remove raid quarantine and timeout state from a user.`)
				.addUserOption(option =>
					option
						.setName(`user`)
						.setDescription(`User to release.`)
						.setRequired(true),
				),
		)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild),

	help: {
		category: `raid`,
		permissions: [PermissionFlagsBits.ManageGuild],
		entries: [
			{
				command: `/raid setup/status/audit/drill`,
				description: `configure and test raid protection.`,
			},
			{
				command: `/raid incidents/incident/report/evidence`,
				description: `review incidents and post summaries or stored evidence.`,
			},
			{
				command: `/raid quarantine/release/sync`,
				description: `operate quarantine and channel overwrite tools.`,
			},
		],
	},

	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();

		try {
			if (subcommand === `setup`) {
				await openSetupPanel(interaction);
			} else if (subcommand === `status`) {
				const config = await getRaidConfig(interaction.guild.id);

				await interaction.reply({ embeds: [buildRaidStatusEmbed(config)], flags: MessageFlags.Ephemeral });
			} else if (subcommand === `audit`) {
				const config = await getRaidConfig(interaction.guild.id);
				const audit = await auditRaidConfiguration(interaction.guild, config);

				await interaction.reply({ embeds: [buildRaidAuditEmbed(config, audit)], flags: MessageFlags.Ephemeral });
			} else if (subcommand === `drill`) {
				await interaction.deferReply({ flags: MessageFlags.Ephemeral });

				const drill = await buildRaidDrill(interaction.guild);
				const triggerLabel = drill.details?.incident?.triggerType === `join_spike` ? `Join Spike` : `Message Spam`;

				if (!drill.ok) {
					await interaction.editReply({
						content: `Raid drill could not run: ${drill.reason}`,
						embeds: drill.audit && drill.config ? [buildRaidAuditEmbed(drill.config, drill.audit, { drill: true })] : [],
					});
					return;
				}

				await interaction.editReply({
					content: [
						`Raid drill sent.`,
						`Trigger: ${triggerLabel}`,
						`Alert: ${drill.alertMessage.url}`,
						`Report: ${drill.reportMessage.url}`,
						`No roles, timeouts, deletions, pings, or database incidents were created.`,
					].join(`\n`),
				});
			} else if (subcommand === `incidents`) {
				const incidents = await listRecentIncidents(interaction.guild.id, interaction.options.getInteger(`limit`) || 10);

				await interaction.reply({ embeds: [buildIncidentListEmbed(incidents)], flags: MessageFlags.Ephemeral });
			} else if (subcommand === `incident`) {
				const details = await getIncidentDetails(interaction.guild.id, interaction.options.getInteger(`id`));

				if (!details) {
					await replyWithError(interaction, `Incident not found.`);
					return;
				}

				await interaction.reply({ embeds: [buildIncidentEmbed(details)], flags: MessageFlags.Ephemeral });
			} else if (subcommand === `report`) {
				const config = await getRaidConfig(interaction.guild.id);
				const result = await postIncidentReport(interaction.guild, config, interaction.options.getInteger(`id`));

				await interaction.reply({
					content: result.ok ? `Raid report posted.` : result.reason,
					flags: MessageFlags.Ephemeral,
				});
			} else if (subcommand === `evidence`) {
				await interaction.deferReply({ flags: MessageFlags.Ephemeral });

				const config = await getRaidConfig(interaction.guild.id);
				const result = await postIncidentEvidence(interaction.guild, config, interaction.options.getInteger(`id`), {
					includeFiles: interaction.options.getBoolean(`include_files`) || false,
					limit: interaction.options.getInteger(`limit`) || undefined,
					mode: interaction.options.getString(`mode`) || `summary`,
				});
				const content = result.ok ?
					`Raid evidence posted. Mode: ${result.mode}; messages posted: ${result.postedMessages}; unique message types: ${result.uniqueMessages}.` :
					result.reason;

				await interaction.editReply({ content });
			} else if (subcommand === `sync`) {
				await openSyncConfirmation(interaction);
			} else if (subcommand === `quarantine`) {
				const user = interaction.options.getUser(`user`, true);
				const result = await quarantineUser(interaction.guild, user.id);

				await interaction.reply({
					content: result.ok ? `Quarantined ${user}.` : result.reason,
					flags: MessageFlags.Ephemeral,
				});
			} else if (subcommand === `release`) {
				const user = interaction.options.getUser(`user`, true);
				const result = await releaseUser(interaction.guild, user.id);

				await interaction.reply({
					content: result.ok ? `Released ${user}.` : result.reason,
					flags: MessageFlags.Ephemeral,
				});
			}
		} catch (err) {
			logError(`Failed to execute raid command:`, err);
			await sendRaidErrorResponse(interaction, `Failed to execute raid command.`);
		}
	},

	async handleComponent(interaction) {
		const [, setupId, scope, action, field] = interaction.customId.split(`:`);

		try {
			if (scope === `sync`) {
				await handleSyncComponent(interaction, setupId, action);
				return;
			}

			if (scope !== `setup`) {
				return;
			}

			const pendingSetup = await getPendingSetup(interaction, setupId);

			if (!pendingSetup) {
				return;
			}

			await handleSetupField(interaction, setupId, pendingSetup, action, field);
		} catch (err) {
			logError(`Failed to handle raid interaction:`, err);
			await sendRaidErrorResponse(interaction, `Failed to update raid setup.`);
		}
	},

	openSetupPanel,
};
