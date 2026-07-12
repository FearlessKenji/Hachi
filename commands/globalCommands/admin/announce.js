// Owner-only manual announcement command.
//
// This command deliberately does not run from startup, GitHub polling, or a
// version check. A configured owner must invoke it when user-facing patch notes
// should be posted to servers that opted in through /setup -> Hachi Updates.
const {
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require(`discord.js`);
const config = require(`../../../config/config.json`);
const { broadcastLatestPatchNotes } = require(`../../../utils/announcements.js`);
const { isConfiguredOwner } = require(`../../../utils/configValues.js`);
const { error: logError, info } = require(`../../../utils/writeLog.js`);

function summarizeResults(results) {
	const sent = results.filter(result => result.ok && !result.skipped).length;
	const skipped = results.filter(result => result.skipped).length;
	const failed = results.filter(result => !result.ok).length;
	const lines = results.slice(0, 10).map(result => {
		const status = result.ok ?
			(result.skipped ? `skipped` : `sent`) :
			`failed`;

		return `- ${result.guildId}: ${status}. ${result.message}`;
	});
	const overflow = results.length > lines.length ?
		`\n- ...and ${results.length - lines.length} more result(s).` :
		``;

	return `Patch-note broadcast complete.
- Sent: ${sent}
- Skipped: ${skipped}
- Failed: ${failed}

${lines.join(`\n`)}${overflow}`;
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`announce`)
		.setDescription(`Owner-only Hachi announcement tools.`)
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.setContexts(InteractionContextType.Guild)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`patch-notes`)
				.setDescription(`Manually send the latest user-facing Hachi patch notes.`)
				.addBooleanOption(option =>
					option
						.setName(`force`)
						.setDescription(`Send again even if this patch-note ID was already delivered.`),
				),
		),

	help: {
		hidden: true,
	},

	async execute(interaction) {
		if (!isConfiguredOwner(config, interaction.user.id)) {
			await interaction.reply({ content: `You are not authorized to use this command.`, flags: MessageFlags.Ephemeral });
			return;
		}

		const subcommand = interaction.options.getSubcommand();

		if (subcommand !== `patch-notes`) {
			await interaction.reply({ content: `Unknown announcement action.`, flags: MessageFlags.Ephemeral });
			return;
		}

		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			const force = interaction.options.getBoolean(`force`) || false;
			const results = await broadcastLatestPatchNotes(interaction.client, { force });

			info(`Manual patch-note broadcast requested by ${interaction.user.username}.`, {
				meta: {
					force,
					results: results.map(result => ({
						guildId: result.guildId,
						message: result.message,
						ok: result.ok,
						sent: result.sent,
						skipped: result.skipped,
					})),
				},
				module: `announcements`,
			});

			await interaction.editReply({ content: summarizeResults(results) });
		} catch (err) {
			logError(`Failed to broadcast patch notes:`, err);
			await interaction.editReply({ content: `Failed to broadcast patch notes: ${err.message}` });
		}
	},
};
