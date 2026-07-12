// Guild leave event.
//
// Leaving a server should not delete all historical configuration immediately.
// Instead Hachi marks the server as left so records can be reconciled or cleaned
// intentionally later.
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
