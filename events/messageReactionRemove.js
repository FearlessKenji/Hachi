// Reaction remove event.
//
// Reaction-role panels can remove roles when users remove a reaction. Rules
// verification intentionally only grants on add, so this route stays feature
// aware instead of blindly reversing every reaction action.
const { Events } = require(`discord.js`);
const { handleReactionRoleReaction } = require(`../utils/reactionRoles.js`);
const { handleRulesVerificationReaction } = require(`../utils/rulesVerification.js`);
const { error } = require(`../utils/writeLog.js`);
const fallbackReactionCommand = require(`../commands/globalCommands/utility/reaction.js`);

function getReactionCommand(client) {
	return client.commands?.get(`reaction`) || fallbackReactionCommand;
}

module.exports = {
	name: Events.MessageReactionRemove,

	async execute(reaction, user) {
		try {
			const reactionCommand = getReactionCommand(reaction.client);

			if (await reactionCommand.handleSetupReaction(reaction, user, false)) {
				return;
			}

			if (await handleRulesVerificationReaction(reaction, user, false)) {
				return;
			}

			await handleReactionRoleReaction(reaction, user, false);
		} catch (err) {
			error(`Failed to handle reaction-role reaction remove:`, err);
		}
	},
};
