const { SlashCommandBuilder, MessageFlags } = require(`discord.js`);
const { info } = require(`../../../utils/writeLog.js`);
const config = require(`../../../config/config.json`);

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`restart`)
		.setDescription(`Restart the bot`)
		.setDefaultMemberPermissions(0),

	help: {
		hidden: true,
	},

	async execute(interaction) {
		if (interaction.user.id === config.botOwner) {
			await interaction.reply({ content: `Restarting...`, flags: MessageFlags.Ephemeral });
			info(`Restart command used by ${interaction.user.username}.`, `Restarting...`);
			process.exit();
		} else {
			await interaction.reply({ content: `You are not authorized to use this command.`, flags: MessageFlags.Ephemeral });
		}
	},
};
