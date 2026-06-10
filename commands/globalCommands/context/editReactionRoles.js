const {
	ApplicationCommandType,
	ContextMenuCommandBuilder,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
} = require(`discord.js`);
const { ReactionRoleMessages, Servers } = require(`../../../database/dbObjects.js`);
const { error } = require(`../../../utils/writeLog.js`);
const { canManageReactionRoles } = require(`../../../utils/reactionRoles.js`);

module.exports = {
	data: new ContextMenuCommandBuilder()
		.setName(`Edit Reaction Roles`)
		.setType(ApplicationCommandType.Message)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild),

	async execute(interaction) {
		try {
			if (!canManageReactionRoles(interaction)) {
				await interaction.reply({
					content: `You need both Manage Server and Manage Roles to edit reaction roles.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			const panel = await ReactionRoleMessages.findOne({
				where: {
					guildId: interaction.guild.id,
					messageId: interaction.targetMessage.id,
					status: `active`,
				},
			});

			if (!panel) {
				await interaction.reply({
					content: `That message is not an active reaction-role panel.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			await Servers.upsert({ guildId: interaction.guild.id });

			const reactionCommand = interaction.client.commands.get(`reaction`) || require(`../utility/reaction.js`);
			await reactionCommand.startEditFromContext(interaction, panel);
		} catch (err) {
			error(`Failed to edit reaction roles from context menu:`, err);

			const payload = {
				content: `Failed to open that reaction-role panel for editing: ${err.message}`,
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
