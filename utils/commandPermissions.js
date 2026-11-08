const { MessageFlags, PermissionFlagsBits } = require(`discord.js`);

// Guild command defaults can be overridden in Discord, so check the member's
// current permission again before running an administrative command.
async function requireManageServer(interaction) {
	const memberPermissions = interaction.memberPermissions;
	if (memberPermissions?.has(PermissionFlagsBits.ManageGuild) ||
		memberPermissions?.has(PermissionFlagsBits.Administrator)) {
		return true;
	}

	await interaction.reply({
		content: `You need Manage Server to use this command.`,
		flags: MessageFlags.Ephemeral,
	});
	return false;
}

module.exports = { requireManageServer };
