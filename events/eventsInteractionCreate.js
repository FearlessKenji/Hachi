// Central interaction router.
//
// Discord sends slash commands, autocomplete requests, buttons, select menus,
// modals, and context-menu commands through the same InteractionCreate event.
// This file classifies the interaction and delegates to the command module that
// owns the matching command/component/modal behavior.
const { Events, MessageFlags } = require(`discord.js`);
const { warn, error } = require(`../utils/writeLog.js`);
const { autocompletes } = require(`../utils/autocompletes.js`);

async function sendInteractionError(interaction) {
	const payload = {
		content: `Something went wrong.`,
		flags: MessageFlags.Ephemeral,
	};

	try {
		if (interaction.replied || interaction.deferred) {
			await interaction.followUp(payload);
		} else {
			await interaction.reply(payload);
		}
	} catch (err) {
		error(`Failed to send interaction error response:`, err);
	}
}

module.exports = {
	name: Events.InteractionCreate,

	async execute(interaction) {

		// Autocomplete interactions are handled before command dispatch because
		// Discord expects an autocomplete response, not a normal slash reply.
		if (interaction.isAutocomplete()) {
			return interaction.respond(autocompletes(interaction));
		}

		// Slash commands
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
				await sendInteractionError(interaction);
			}

			return;
		}

		// Message context menus
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
				await sendInteractionError(interaction);
			}

			return;
		}

		// Message components route by the first customId segment, which matches the
		// command name that created the buttons or select menus.
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
				await sendInteractionError(interaction);
			}
		}

		// Modal submissions route by the first customId segment, which matches the
		// command name that opened the modal.
		if (interaction.isModalSubmit()) {
			const [commandName] = interaction.customId.split(`:`);

			const command = interaction.client.commands.get(commandName);

			if (!command?.handleModalSubmit) {
				return;
			}

			try {
				await command.handleModalSubmit(interaction);
			} catch (err) {
				error(`Error handling modal submit:`, err);
				await sendInteractionError(interaction);
			}
		}
	},
};
