// /setup hub command.
//
// This command gives administrators one entry point into the larger setup flows
// such as stream notifications, security monitoring, and raid protection.
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
	SlashCommandBuilder,
} = require(`discord.js`);
const {
	clearAnnouncementChannel,
	getAnnouncementSettings,
	getLatestPatchNotes,
	saveAnnouncementChannel,
	sendLatestPatchNotesToGuild,
} = require(`../../../utils/announcements.js`);
const { error: logError } = require(`../../../utils/writeLog.js`);

const SETUP_COLOR = 0xffb020;
const textChannelTypes = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
];
const pendingSetupHubs = new Map();

function formatChannel(id) {
	return id ? `<#${id}>` : `Not set`;
}

function buildSetupEmbed() {
	return new EmbedBuilder()
		.setColor(SETUP_COLOR)
		.setTitle(`Hachi Setup`)
		.setDescription(`Choose which area you want to configure.`)
		.addFields(
			{
				name: `Hachi Updates`,
				value: `Choose where manually sent Hachi patch notes should be posted.`,
				inline: false,
			},
			{
				name: `Stream Notifications`,
				value: `Configure Twitch/Kick notification channels and roles.`,
				inline: false,
			},
			{
				name: `Birthday Posts`,
				value: `Configure automatic birthday reminder and birthday-day posts.`,
				inline: false,
			},
			{
				name: `Security Reporting`,
				value: `Configure application command reporting.`,
				inline: false,
			},
			{
				name: `Raid Protection`,
				value: `Configure quarantine, thresholds, alerts, and raid reports.`,
				inline: false,
			},
			{
				name: `Other Setup Commands`,
				value: `Use \`/rules\` for rules verification and \`/reaction roles add\` for reaction-role panels.`,
				inline: false,
			},
		);
}

function buildSetupComponents(setupId) {
	return [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`setup:${setupId}:announcements`)
				.setLabel(`Hachi Updates`)
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId(`setup:${setupId}:stream`)
				.setLabel(`Stream Notifications`)
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId(`setup:${setupId}:birthday`)
				.setLabel(`Birthday Posts`)
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId(`setup:${setupId}:security`)
				.setLabel(`Security Reporting`)
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId(`setup:${setupId}:raid`)
				.setLabel(`Raid Protection`)
				.setStyle(ButtonStyle.Secondary),
		),
	];
}

function buildAnnouncementsContent(settings, statusMessage = null) {
	const latest = getLatestPatchNotes();
	const status = statusMessage ? `\n### ${statusMessage}` : ``;

	return `## Hachi Updates
- Announcement Channel: ${formatChannel(settings.hachiAnnouncementChannelId)}
- Last Patch Notes Sent: ${settings.hachiAnnouncementLastId || `None`}
- Latest Local Patch Notes: ${latest?.id || `Not found`}${status}`;
}

function buildAnnouncementsComponents(setupId, settings) {
	const buttons = [
		new ButtonBuilder()
			.setCustomId(`setup:${setupId}:announcementSend`)
			.setLabel(`Send Latest`)
			.setStyle(ButtonStyle.Primary)
			.setDisabled(!settings.hachiAnnouncementChannelId),
		new ButtonBuilder()
			.setCustomId(`setup:${setupId}:announcementClear`)
			.setLabel(`Clear Channel`)
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(!settings.hachiAnnouncementChannelId),
		new ButtonBuilder()
			.setCustomId(`setup:${setupId}:home`)
			.setLabel(`Back to Setup`)
			.setStyle(ButtonStyle.Secondary),
	];

	return [
		new ActionRowBuilder().addComponents(
			new ChannelSelectMenuBuilder()
				.setCustomId(`setup:${setupId}:announcementChannel`)
				.setPlaceholder(`Hachi updates channel`)
				.setChannelTypes(textChannelTypes),
		),
		new ActionRowBuilder().addComponents(buttons),
	];
}

async function getPendingHub(interaction, setupId) {
	const pendingHub = pendingSetupHubs.get(setupId);

	if (!pendingHub || pendingHub.userId !== interaction.user.id || pendingHub.guildId !== interaction.guild.id) {
		await interaction.update({
			content: `This setup panel is no longer available. Run \`/setup\` again.`,
			components: [],
			embeds: [],
		});
		return null;
	}

	return pendingHub;
}

async function showSetupHub(interaction, setupId) {
	await interaction.update({
		content: null,
		embeds: [buildSetupEmbed()],
		components: buildSetupComponents(setupId),
	});
}

async function routeToCommandPanel(interaction, setupId, commandName) {
	const command = interaction.client.commands.get(commandName);

	if (!command?.openSetupPanel) {
		await interaction.update({
			content: `That setup panel is not available right now.`,
			components: [],
			embeds: [],
		});
		return;
	}

	await command.openSetupPanel(interaction, { parentSetupId: setupId, update: true });
}

async function showAnnouncementsPanel(interaction, setupId, statusMessage = null) {
	const settings = await getAnnouncementSettings(interaction.guild.id);

	await interaction.update({
		content: buildAnnouncementsContent(settings, statusMessage),
		components: buildAnnouncementsComponents(setupId, settings),
		embeds: [],
	});
}

async function saveAnnouncementChannelSelection(interaction, setupId) {
	const channelId = interaction.values[0] || null;
	const settings = await saveAnnouncementChannel(interaction.guild.id, channelId);

	await interaction.update({
		content: buildAnnouncementsContent(settings, `Announcement channel saved.`),
		components: buildAnnouncementsComponents(setupId, settings),
		embeds: [],
	});
}

async function clearAnnouncementChannelSelection(interaction, setupId) {
	const settings = await clearAnnouncementChannel(interaction.guild.id);

	await interaction.update({
		content: buildAnnouncementsContent(settings, `Announcement channel cleared.`),
		components: buildAnnouncementsComponents(setupId, settings),
		embeds: [],
	});
}

async function sendLatestAnnouncement(interaction, setupId) {
	await interaction.deferUpdate();
	const result = await sendLatestPatchNotesToGuild(interaction.client, interaction.guild.id);
	const settings = await getAnnouncementSettings(interaction.guild.id);

	await interaction.editReply({
		content: buildAnnouncementsContent(settings, result.message),
		components: buildAnnouncementsComponents(setupId, settings),
		embeds: [],
	});
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`setup`)
		.setDescription(`Open Hachi's setup hub.`)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild),

	help: {
		category: `management`,
		permissions: [PermissionFlagsBits.ManageGuild],
		entries: [
			{
				command: `/setup`,
				description: `open the setup hub.`,
			},
		],
	},

	async execute(interaction) {
		try {
			const setupId = interaction.id;

			pendingSetupHubs.set(setupId, {
				guildId: interaction.guild.id,
				userId: interaction.user.id,
			});

			await interaction.reply({
				embeds: [buildSetupEmbed()],
				components: buildSetupComponents(setupId),
				flags: MessageFlags.Ephemeral,
			});
		} catch (err) {
			logError(`Failed to open setup hub:`, err);
			await interaction.reply({ content: `Failed to open setup hub.`, flags: MessageFlags.Ephemeral });
		}
	},

	async handleComponent(interaction) {
		const [, setupId, action] = interaction.customId.split(`:`);

		try {
			const pendingHub = await getPendingHub(interaction, setupId);

			if (!pendingHub) {
				return;
			}

			if (action === `home`) {
				await showSetupHub(interaction, setupId);
			} else if (action === `stream`) {
				await routeToCommandPanel(interaction, setupId, `stream`);
			} else if (action === `birthday`) {
				await routeToCommandPanel(interaction, setupId, `birthday`);
			} else if (action === `security`) {
				await routeToCommandPanel(interaction, setupId, `security`);
			} else if (action === `raid`) {
				await routeToCommandPanel(interaction, setupId, `raid`);
			} else if (action === `announcements`) {
				await showAnnouncementsPanel(interaction, setupId);
			} else if (action === `announcementChannel`) {
				await saveAnnouncementChannelSelection(interaction, setupId);
			} else if (action === `announcementClear`) {
				await clearAnnouncementChannelSelection(interaction, setupId);
			} else if (action === `announcementSend`) {
				await sendLatestAnnouncement(interaction, setupId);
			}
		} catch (err) {
			logError(`Failed to route setup hub:`, err);

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: `Failed to open that setup panel.`, flags: MessageFlags.Ephemeral });
			} else {
				await interaction.reply({ content: `Failed to open that setup panel.`, flags: MessageFlags.Ephemeral });
			}
		}
	},
};
