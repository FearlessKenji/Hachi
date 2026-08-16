// Message delete event.
//
// Reaction-role and rules-verification records point at Discord messages. When
// those messages disappear, the database must stop treating them as live panels.
const { Events } = require(`discord.js`);
const { ReactionRoleMessages, RulesVerificationMessages } = require(`../database/dbObjects.js`);
const { deletePanelRecords } = require(`../utils/reactionRoles.js`);
const { error, info } = require(`../utils/writeLog.js`);
const { restoreDeletedPanel } = require(`../utils/modmail.js`);
const { repairVerificationPanel } = require(`../utils/twitchVerificationPanels.js`);

module.exports = {
	name: Events.MessageDelete,

	async execute(message) {
		try {
			if (!message.guildId) {
				return;
			}

			if (await restoreDeletedPanel(message)) {
				info(`Restored deleted Modmail panel ${message.id} in guild ${message.guildId}.`);
			}

			const { TwitchVerificationPanels } = require(`../database/dbObjects.js`);
			const twitchPanel = await TwitchVerificationPanels.findByPk(message.guildId);
			if (twitchPanel?.messageId === message.id) {
				await twitchPanel.update({ messageId: null });
				await repairVerificationPanel(message.client, twitchPanel, { force: true });
				info(`Repaired deleted Twitch verification panel ${message.id} in guild ${message.guildId}.`);
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
