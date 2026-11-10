// Guild-only /restart command.
//
// Owner/admin utility for restarting the bot process from Discord. HachiGen/PM2
// still own normal process control, but this gives a guarded in-Discord escape.
const { SlashCommandBuilder, MessageFlags } = require(`discord.js`);
const { setImmediate } = require(`node:timers`);
const { error, info } = require(`../../../utils/writeLog.js`);
const config = require(`../../../config/config.json`);
const { isConfiguredOwner } = require(`../../../utils/configValues.js`);

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`restart`)
		.setDescription(`Restart the bot`)
		.setDefaultMemberPermissions(0),

	help: {
		hidden: true,
	},

	async execute(interaction) {
		if (isConfiguredOwner(config, interaction.user.id)) {
			await interaction.reply({ content: `Restarting...`, flags: MessageFlags.Ephemeral });
			info(`Restart command used by ${interaction.user.username}.`, `Restarting...`);
			if (typeof interaction.client.requestShutdown !== `function`) {
				throw new Error(`The bot's shutdown handler is unavailable.`);
			}
			// Let this interaction finish before the shared shutdown path waits for
			// active event handlers, then PM2 restarts the exited process.
			setImmediate(() => {
				void interaction.client.requestShutdown(`the restart command`).catch(err =>
					error(`Restart shutdown failed.`, err, { module: `shutdown` }));
			});
		} else {
			await interaction.reply({ content: `You are not authorized to use this command.`, flags: MessageFlags.Ephemeral });
		}
	},
};
