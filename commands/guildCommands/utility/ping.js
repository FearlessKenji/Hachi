const { SlashCommandBuilder } = require(`discord.js`);

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`ping`)
		.setDescription(`Replies with Pong!`)
		.setDefaultMemberPermissions(0), // Restrict to admins or bot owner

	async execute(interaction) {
		const sent = await interaction.reply({ content: `Pinging...`, withResponse: true });
		interaction.editReply(`Roundtrip latency: ${sent.resource.message.createdTimestamp - interaction.createdTimestamp}ms`);
	},
};