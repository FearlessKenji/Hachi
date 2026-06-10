const { Events, MessageFlags } = require(`discord.js`);
const { warn, error } = require(`../utils/writeLog.js`);
const { TIMEZONES } = require(`../utils/timezones.js`);

module.exports = {
	name: Events.InteractionCreate,

	async execute(interaction) {

		// =========================
		// AUTOCOMPLETE HANDLER
		// =========================
		if (interaction.isAutocomplete()) {
			const focused = interaction.options.getFocused().toLowerCase();

			const results = TIMEZONES
				.filter(tz => tz.label.toLowerCase().includes(focused))
				.slice(0, 25)
				.map(tz => ({
					name: tz.label,
					value: tz.value,
				}));

			return interaction.respond(results);
		}

		// =========================
		// SLASH COMMANDS
		// =========================
		if (interaction.isChatInputCommand()) {
			const command = interaction.client.commands.get(interaction.commandName);

			if (!command) {
				warn(`No command matching ${interaction.commandName} was found.`);
				return;
			}

			try {
				await command.execute(interaction);
			} catch (err) {
				error(`Error executing ${interaction.commandName}`, err);
			}

			return;
		}

		// =========================
		// MESSAGE CONTEXT MENUS
		// =========================
		if (interaction.isMessageContextMenuCommand()) {
			const command = interaction.client.commands.get(interaction.commandName);

			if (!command) {
				warn(`No context command matching ${interaction.commandName} was found.`);
				return;
			}

			try {
				await command.execute(interaction);
			} catch (err) {
				error(`Error executing ${interaction.commandName}`, err);
			}

			return;
		}

		// =========================
		// COMPONENTS (BUTTONS, MENUS)
		// =========================
		if (
			interaction.isButton() ||
			interaction.isStringSelectMenu() ||
			interaction.isChannelSelectMenu() ||
			interaction.isRoleSelectMenu()
		) {
			const [commandName] = interaction.customId.split(`:`);

			const command = interaction.client.commands.get(commandName);

			if (!command?.handleComponent) {
				return;
			}

			try {
				await command.handleComponent(interaction);
			} catch (err) {
				error(`Error handling interaction:`, err);

				const payload = {
					content: `Something went wrong.`,
					flags: MessageFlags.Ephemeral,
				};

				if (interaction.replied || interaction.deferred) {
					await interaction.followUp(payload);
				} else {
					await interaction.reply(payload);
				}
			}
		}
	},
};
