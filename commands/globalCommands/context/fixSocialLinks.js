// "Fix Social Links" profile-installable message context command.
//
// This on-demand surface shares the exact URL rules used by automatic guild
// replies, but it remains available when automatic fixing is disabled.
const {
	ApplicationCommandType,
	ApplicationIntegrationType,
	ContextMenuCommandBuilder,
	InteractionContextType,
	MessageFlags,
} = require(`discord.js`);
const { buildFixedSocialLinks } = require(`../../../utils/socialLinks.js`);
const { error } = require(`../../../utils/writeLog.js`);

module.exports = {
	data: new ContextMenuCommandBuilder()
		.setName(`Fix Social Links`)
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
				command: `Fix Social Links`,
				description: `message context menu for posting clean, embed-friendly social links.`,
			},
		],
	},

	async execute(interaction) {
		try {
			const result = buildFixedSocialLinks(interaction.targetMessage?.content);

			if (!result.links.length) {
				await interaction.reply({
					content: `That message does not contain a supported social link.`,
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
			error(`Failed to fix social links from context menu:`, err);

			const payload = {
				content: `Failed to create embed-friendly links.`,
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
