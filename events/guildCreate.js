const { Servers } = require(`../database/dbObjects.js`);
const { info, error } = require(`../utils/writeLog.js`);
const { Events } = require(`discord.js`);

module.exports = {
	name: Events.GuildCreate,
	async execute(guild) {
		try {
			await Servers.upsert({ guildId: guild.id });
			const owner = await guild.fetchOwner();
			info(`Added to new server: ${guild.name} | ID: ${guild.id}\nOwner: ${owner} | OwnerUsername: ${owner.user.username}.`);
		} catch (err) {
			error(`Failed to update server table upon arrival.`, err);
		}
	},
};
