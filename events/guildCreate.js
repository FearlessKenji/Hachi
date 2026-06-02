const { Servers } = require(`../database/dbObjects.js`);
const { writeLog } = require(`../utils/writeLog.js`);
const { Events } = require(`discord.js`);

module.exports = {
	name: Events.GuildCreate,
	async execute(guild) {
		try {
			await Servers.upsert({ guildId: guild.id });
			const owner = await guild.fetchOwner();
			console.log(writeLog(`Added to new server: ${guild.name}) | ID: ${guild.id}\nOwner: ${owner} | OwnerUsername: ${owner.user.username}.`));
		} catch (error) {
			console.error(writeLog(`Failed to update server table upon arrival.`, error));
		}
	},
};