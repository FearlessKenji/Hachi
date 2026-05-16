const { SlashCommandBuilder } = require(`discord.js`);
const ST = new Date(); // Start time

// Function to calculate the elapsed time
function calculateUptime() {
	const CURR = new Date();
	const uptime = CURR - ST;

	// Convert elapsed time to seconds
	const uptimeS = Math.floor(uptime / 1000);
	const uptimeM = Math.floor(uptimeS / 60);
	const uptimeH = Math.floor(uptimeM / 60);
	const uptimeD = Math.floor(uptimeH / 24);

	// Print the elapsed time
	return `I have been awake for ${uptimeD} days, ${uptimeH % 24} hours, ${uptimeM % 60} minutes, ${uptimeS % 60} seconds`;
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`uptime`)
		.setDescription(`Replies with the runtime.`)
		.setDefaultMemberPermissions(0), // Restrict to admins or bot owner

	async execute(interaction) {
		await interaction.reply({ content: calculateUptime(), fetchReply: true });
	},
};