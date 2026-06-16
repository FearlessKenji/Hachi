const { Events } = require(`discord.js`);
const { handleReactionRoleReaction } = require(`../utils/reactionRoles.js`);
const { handleRulesVerificationReaction } = require(`../utils/rulesVerification.js`);
const { error } = require(`../utils/writeLog.js`);
const fallbackReactionCommand = require(`../commands/globalCommands/utility/reaction.js`);

function getReactionCommand(client) {
	return client.commands?.get(`reaction`) || fallbackReactionCommand;
}

module.exports = {
	name: Events.MessageReactionAdd,

	async execute(reaction, user) {
		try {
			const reactionCommand = getReactionCommand(reaction.client);

			if (await reactionCommand.handleSetupReaction(reaction, user, true)) {
				return;
			}

			if (await handleRulesVerificationReaction(reaction, user, true)) {
				return;
			}

			await handleReactionRoleReaction(reaction, user, true);
		} catch (err) {
			error(`Failed to handle reaction-role reaction add:`, err);
		}
	},
};
