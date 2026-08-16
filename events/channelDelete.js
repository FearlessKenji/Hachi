// Channel delete event.
//
// Several features store channel IDs. This cleanup path prevents deleted
// channels from being reused as notification, birthday, rules, or report targets.
const { Events } = require(`discord.js`);
const {
	BirthdayConfigs,
	ModmailConfigs,
	ModmailTickets,
	RulesVerificationMessages,
	TwitchVerificationPanels,
} = require(`../database/dbObjects.js`);
const { disablePanelsForDeletedChannel } = require(`../utils/reactionRoles.js`);
const { error, info } = require(`../utils/writeLog.js`);

module.exports = {
	name: Events.ChannelDelete,

	async execute(channel) {
		try {
			if (!channel.guild) {
				return;
			}

			const removedBirthdayConfigs = await BirthdayConfigs.destroy({
				where: {
					channelId: channel.id,
					guildId: channel.guild.id,
				},
			});
			const panels = await disablePanelsForDeletedChannel(channel.guild.id, channel.id);
			const removedRulesVerifications = await RulesVerificationMessages.destroy({
				where: {
					channelId: channel.id,
					guildId: channel.guild.id,
				},
			});
			const clearedModmailEntries = await ModmailConfigs.update(
				{ entryChannelId: null, panelMessageId: null },
				{ where: { guildId: channel.guild.id, entryChannelId: channel.id } },
			);
			const clearedModmailCategories = await ModmailConfigs.update(
				{ ticketCategoryId: null },
				{ where: { guildId: channel.guild.id, ticketCategoryId: channel.id } },
			);
			const removedTickets = await ModmailTickets.findAll({
				where: { guildId: channel.guild.id, channelId: channel.id },
			});
			for (const ticket of removedTickets) {
				await ticket.update({
					channelId: null,
					deleteAt: null,
					status: ticket.storedAt ? `stored` : `deleted`,
				});
			}
			const twitchPanel = await TwitchVerificationPanels.findByPk(channel.guild.id);
			if (twitchPanel?.channelId === channel.id) {
				await twitchPanel.update({ failureCode: `unavailable`, messageId: null });
			}
			if (removedBirthdayConfigs) {
				info(`Removed ${removedBirthdayConfigs} birthday config(s) after channel deletion ${channel.id}.`);
			}

			if (removedRulesVerifications) {
				info(`Removed ${removedRulesVerifications} rules verification record(s) after channel deletion ${channel.id}.`);
			}

			if (panels.length) {
				info(`Disabled ${panels.length} reaction-role panel(s) after channel deletion ${channel.id}.`);
			}

			if (clearedModmailEntries[0] || clearedModmailCategories[0] || removedTickets.length) {
				info(`Reconciled Modmail state after channel deletion ${channel.id}.`);
			}
		} catch (err) {
			error(`Failed to handle channel deletion cleanup:`, err);
		}
	},
};
