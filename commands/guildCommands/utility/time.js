// Guild-only /time command.
//
// Simple utility for confirming command execution and displaying current runtime
// time from the bot process.
const { SlashCommandBuilder } = require(`discord.js`);

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`time`)
		.setDescription(`Replies with the current time and date.`)
		.setDefaultMemberPermissions(0),

	help: {
		category: `diagnostics`,
		entries: [
			{
				command: `/time`,
				description: `show the current Discord timestamp.`,
			},
		],
	},

	async execute(interaction) {
		const epoch = Math.floor(Date.now() / 1000);
		const discordTime = `<t:${epoch}:t>`;
		const discordDate = `<t:${epoch}:d>`;
		await interaction.reply({ content: `It is currently ${discordTime}, ${discordDate}.` });
	},
};
