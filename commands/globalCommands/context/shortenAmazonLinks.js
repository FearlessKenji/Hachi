// "Shorten Amazon Links" profile-installable message context command.
//
// The command publishes canonical regional product links without following
// redirects or sending the selected message content to an additional service.
const {
	ApplicationCommandType,
	ApplicationIntegrationType,
	ContextMenuCommandBuilder,
	InteractionContextType,
	MessageFlags,
} = require(`discord.js`);
const { buildShortAmazonLinks } = require(`../../../utils/amazonLinks.js`);
const { error } = require(`../../../utils/writeLog.js`);

module.exports = {
	data: new ContextMenuCommandBuilder()
		.setName(`Shorten Amazon Links`)
		.setType(ApplicationCommandType.Message)
		.setIntegrationTypes(
			ApplicationIntegrationType.GuildInstall,
			ApplicationIntegrationType.UserInstall,
		)
		.setContexts(
			InteractionContextType.Guild,
			InteractionContextType.BotDM,
			InteractionContextType.PrivateChannel,
		),

	help: {
		category: `general`,
		entries: [
			{
				command: `Shorten Amazon Links`,
				description: `message context menu for posting canonical Amazon product links.`,
			},
		],
	},

	async execute(interaction) {
		try {
			const result = buildShortAmazonLinks(interaction.targetMessage?.content);

			if (!result.links.length) {
				await interaction.reply({
					content: `That message does not contain a recognized Amazon product link.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			await interaction.reply({
				allowedMentions: { parse: [], repliedUser: false },
				content: result.content,
				flags: MessageFlags.SuppressNotifications,
			});
		} catch (err) {
			error(`Failed to shorten Amazon links from context menu:`, err);

			const payload = {
				content: `Failed to shorten those Amazon links.`,
				flags: MessageFlags.Ephemeral,
			};

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp(payload);
			} else {
				await interaction.reply(payload);
			}
		}
	},
};
