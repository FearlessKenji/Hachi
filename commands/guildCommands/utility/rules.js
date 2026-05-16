const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require(`discord.js`);

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`rules`)
		.setDescription(`Embed the rules.`)
		.addChannelOption(option =>
			option
				.setName(`channel`)
				.setDescription(`Select your rules channel`)
				.setRequired(true),
		)
		.setDefaultMemberPermissions(0), // Restrict to admins or bot owner,

	async execute(interaction) {
		const channel = interaction.options.getChannel(`channel`);

		const rules = new EmbedBuilder()
			.setColor([255, 0, 0])
			.setTitle(`Server Rules:`)
			.setDescription(`Please read and understand the following:
 
			1. Treat everyone with respect. Absolutely no harassment, witch hunting, sexism, racism, or hate speech will be tolerated.

			2. No spam or self-promotion (server invites, advertisements, etc) without permission from a staff member. This includes DMing fellow members.

			3. No NSFW or obscene content. This includes text, images, or links featuring nudity, sex, hard violence, or other graphically disturbing content.

			4. If you see something against the rules or something that makes you feel unsafe, let staff know. We want this server to be a welcoming space!`);

		await channel.send({ embeds: [rules] });
		await interaction.reply({ content: `Rules posted.`, flags: MessageFlags.Ephemeral });
	},
};