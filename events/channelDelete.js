const { Events } = require(`discord.js`);
const { disablePanelsForDeletedChannel } = require(`../utils/reactionRoles.js`);
const { error, info } = require(`../utils/writeLog.js`);

module.exports = {
	name: Events.ChannelDelete,

	async execute(channel) {
		try {
			if (!channel.guild) {
				return;
			}

			const panels = await disablePanelsForDeletedChannel(channel.guild.id, channel.id);

			if (!panels.length) {
				return;
			}

			info(`Disabled ${panels.length} reaction-role panel(s) after channel deletion ${channel.id}.`);
		} catch (err) {
			error(`Failed to handle channel deletion for reaction roles:`, err);
		}
	},
};
