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

const RESULT_MESSAGE_LIMIT = 1900;

function appendResultText(messages, text) {
	let remaining = text;

	while (remaining) {
		const current = messages.at(-1) || ``;
		const separator = current ? `\n` : ``;
		const available = RESULT_MESSAGE_LIMIT - current.length - separator.length;

		if (available <= 0) {
			messages.push(``);
			continue;
		}

		messages[messages.length - 1] = `${current}${separator}${remaining.slice(0, available)}`;
		remaining = remaining.slice(available);

		if (remaining) {
			messages.push(``);
		}
	}
}

function summarizeResults(results) {
	const sent = results.filter(result => result.ok && !result.skipped).length;
	const skipped = results.filter(result => result.skipped).length;
	const failed = results.filter(result => !result.ok).length;
	const exceptionalResults = results.filter(result => result.skipped || !result.ok);
	const messages = [`Patch-note broadcast complete.
- Sent: ${sent}
- Skipped: ${skipped}
- Failed: ${failed}`];

	if (!exceptionalResults.length) {
		appendResultText(messages, `\nAll deliveries succeeded.`);
		return messages;
	}

	appendResultText(messages, `\nSkipped and failed results:`);
	for (const result of exceptionalResults) {
		const status = result.skipped ? `skipped` : `failed`;
		const guildLabel = `${result.guildName || `Unknown Server`} (${result.guildId})`;

		// Keep every actionable result, splitting across Discord-safe messages when necessary.
		appendResultText(messages, `- ${guildLabel}: ${status}. ${result.message}`);
	}

	return messages;
}

module.exports = {
	summarizeResults,
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
						guildName: result.guildName,
						message: result.message,
						ok: result.ok,
						sent: result.sent,
						skipped: result.skipped,
					})),
				},
				module: `announcements`,
			});

			const resultMessages = summarizeResults(results);

			await interaction.editReply({ content: resultMessages[0] });
			for (const content of resultMessages.slice(1)) {
				await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
			}
		} catch (err) {
			logError(`Failed to broadcast patch notes:`, err);
			await interaction.editReply({ content: `Failed to broadcast patch notes: ${err.message}` });
		}
	},
};
