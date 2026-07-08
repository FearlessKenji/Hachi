const { Events } = require(`discord.js`);
const { markServerLeft } = require(`../utils/serverLifecycle.js`);
const { error } = require(`../utils/writeLog.js`);

module.exports = {
	name: Events.GuildDelete,
	async execute(guild) {
		try {
			await markServerLeft(guild);
		} catch (err) {
			error(`Failed to mark server as left.`, err, {
				meta: {
					guildId: guild.id,
					guildName: guild.name,
				},
				module: `server-lifecycle`,
			});
		}
	},
};
