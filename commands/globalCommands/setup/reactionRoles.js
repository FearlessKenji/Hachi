const { SlashCommandBuilder, MessageFlags } = require(`discord.js`);
const { info, warn, error } = require(`../../../utils/writeLog.js`);
const config = require(`../../../config/config.json`);

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`reaction`)
		// Restrict to admins or bot owner
		.addSubcommand(subcommand =>
			subcommand
				.setName(`roles`)
				.addStringOption(option =>
					option
						.setName(`add`)
						.setDescription(`Add reaction role message.`)
				)
				.addStringOption(option =>
					option
						.setName(`edit`)
						.setDescription(`Edit reaction role message.`)
				)
				.addStringOption(option =>
					option
						.setName(`delete`)
						.setDescription(`Delete reaction role message.`),
				),
		)
		.setDefaultMemberPermissions(0),

	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();

		try {
			if (subcommand === `roles`) {
				
			}
		} catch (error) {
			error(`Failed to execute command ${subcommand}:`, error);
			await interaction.reply({
				content: `Failed to execute command ${subcommand}.`,
				flags: MessageFlags.Ephemeral,
			});
		}
	},
};