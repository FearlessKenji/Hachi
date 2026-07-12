// Guild-only /ping command.
//
// Tiny health check used during local/guild command deployment testing.
const { SlashCommandBuilder } = require(`discord.js`);

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`ping`)
		.setDescription(`Replies with Pong!`)
		.setDefaultMemberPermissions(0),

	help: {
		category: `diagnostics`,
		entries: [
			{
				command: `/ping`,
				description: `check bot latency when guild utility commands are installed.`,
			},
		],
	},

	async execute(interaction) {
		const sent = await interaction.reply({ content: `Pinging...`, withResponse: true });
		interaction.editReply(`Roundtrip latency: ${sent.resource.message.createdTimestamp - interaction.createdTimestamp}ms`);
	},
};
