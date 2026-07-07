const { Events } = require(`discord.js`);
const { BirthdayConfigs, RulesVerificationMessages } = require(`../database/dbObjects.js`);
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

			if (removedBirthdayConfigs) {
				info(`Removed ${removedBirthdayConfigs} birthday config(s) after channel deletion ${channel.id}.`);
			}

			if (removedRulesVerifications) {
				info(`Removed ${removedRulesVerifications} rules verification record(s) after channel deletion ${channel.id}.`);
			}

			if (panels.length) {
				info(`Disabled ${panels.length} reaction-role panel(s) after channel deletion ${channel.id}.`);
			}
		} catch (err) {
			error(`Failed to handle channel deletion cleanup:`, err);
		}
	},
};
