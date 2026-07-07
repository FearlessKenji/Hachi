const { Events } = require(`discord.js`);
const { ReactionRoleMessages, RulesVerificationMessages } = require(`../database/dbObjects.js`);
const { deletePanelRecords } = require(`../utils/reactionRoles.js`);
const { error, info } = require(`../utils/writeLog.js`);

module.exports = {
	name: Events.MessageDelete,

	async execute(message) {
		try {
			if (!message.guildId) {
				return;
			}

			const panel = await ReactionRoleMessages.findOne({
				where: {
					guildId: message.guildId,
					messageId: message.id,
					status: `active`,
				},
			});

			if (panel) {
				await deletePanelRecords([panel.id]);
				info(`Deleted reaction-role panel data for deleted message ${message.id} in guild ${message.guildId}.`);
			}

			const removedRulesVerifications = await RulesVerificationMessages.destroy({
				where: {
					guildId: message.guildId,
					messageId: message.id,
				},
			});

			if (removedRulesVerifications) {
				info(`Deleted ${removedRulesVerifications} rules verification record(s) for deleted message ${message.id} in guild ${message.guildId}.`);
			}
		} catch (err) {
			error(`Failed to handle message deletion cleanup:`, err);
		}
	},
};
