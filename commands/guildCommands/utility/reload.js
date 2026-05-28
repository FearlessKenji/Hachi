const { SlashCommandBuilder, MessageFlags } = require(`discord.js`);
const config = require(`../../../config.json`);
const path = require(`node:path`);

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`reload`)
		.setDescription(`Reloads a command.`)
		.addStringOption(option =>
			option.setName(`command`)
				.setDescription(`The command to reload.`)
				.setRequired(true),
		)
		.setDefaultMemberPermissions(0),

	async execute(interaction) {
		if (interaction.user.id !== config.botOwner) {
			return interaction.reply({
				content: `You do not have permission to use this command.`,
				flags: MessageFlags.Ephemeral,
			});
		}

		const commandName = interaction.options.getString(`command`, true).toLowerCase();
		const command = interaction.client.commands.get(commandName);

		if (!command) {
			return interaction.reply({
				content: `There is no command with name \`${commandName}\`!`,
				flags: MessageFlags.Ephemeral,
			});
		}

		let newCommand;

		try {
			const globalPath = path.resolve(
				__dirname,
				`../../globalCommands/utility`,
				`${command.data.name}.js`,
			);

			delete require.cache[require.resolve(globalPath)];
			newCommand = require(globalPath);
		} catch (err1) {
			try {
				const guildPath = path.resolve(
					__dirname,
					`../../guildCommands/utility`,
					`${command.data.name}.js`,
				);

				delete require.cache[require.resolve(guildPath)];
				newCommand = require(guildPath);
			} catch (err2) {
				console.error(err1, err2);
				return interaction.reply({
					content: `There was an error while reloading \`${command.data.name}\`.`,
					flags: MessageFlags.Ephemeral,
				});
			}
		}

		interaction.client.commands.set(newCommand.data.name, newCommand);
		await interaction.reply({
			content: `Command \`${newCommand.data.name}\` was reloaded!`,
			flags: MessageFlags.Ephemeral,
		});
	},
};