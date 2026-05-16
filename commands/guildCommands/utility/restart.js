const { SlashCommandBuilder, MessageFlags } = require(`discord.js`);
const { writeLog } = require(`../../../modules/writeLog.js`);
const config = require(`../../../config.json`);

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`restart`)
		.setDescription(`Restart the bot`)
		.setDefaultMemberPermissions(0), // Restrict to admins or bot owner

	async execute(interaction) {
		if (interaction.user.id === config.botOwner) {
			await interaction.reply({ content: `Restarting...`, flags: MessageFlags.Ephemeral });
			writeLog(`Restart command used by ${interaction.user.username}.`, `Restarting...`);
			process.exit();
		}
		else {
			await interaction.reply({ content: `You are not authorized to use this command.`, flags: MessageFlags.Ephemeral });
		}
	},
};