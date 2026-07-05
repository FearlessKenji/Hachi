const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require(`discord.js`);
const { error: logError } = require(`../../../utils/writeLog.js`);

const SETUP_COLOR = 0xffb020;
const pendingSetupHubs = new Map();

function buildSetupEmbed() {
	return new EmbedBuilder()
		.setColor(SETUP_COLOR)
		.setTitle(`Hachi Setup`)
		.setDescription(`Choose which area you want to configure.`)
		.addFields(
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
				.setCustomId(`setup:${setupId}:stream`)
				.setLabel(`Stream Notifications`)
				.setStyle(ButtonStyle.Primary),
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
				.setStyle(ButtonStyle.Danger),
		),
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
		content: ``,
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
