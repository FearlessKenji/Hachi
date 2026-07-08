const { info, error } = require(`../utils/writeLog.js`);
const { Events } = require(`discord.js`);
const { markServerJoined } = require(`../utils/serverLifecycle.js`);

module.exports = {
	name: Events.GuildCreate,
	async execute(guild) {
		try {
			await markServerJoined(guild);
			const owner = await guild.fetchOwner();
			info(`Added to new server: ${guild.name} | ID: ${guild.id}\nOwner: ${owner} | OwnerUsername: ${owner.user.username}.`);
		} catch (err) {
			error(`Failed to update server table upon arrival.`, err);
		}
	},
};
