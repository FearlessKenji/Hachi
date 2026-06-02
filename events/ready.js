const { Events, ActivityType } = require(`discord.js`);
const { writeLog } = require(`../utils/writeLog.js`);
const { dbInit } = require(`../database/dbInit.js`);
const twitchAuth = require(`../auth/updateTwitchAuthConfig.js`);
const kickAuth = require(`../auth/updateKickAuthConfig.js`);

module.exports = {
	name: Events.ClientReady,
	once: true,
	async execute(client) {
		// Sync DB tables once on startup
		await dbInit();

		console.log(writeLog(`Ready! Logged in as ${client.user.tag}`));

		// Prime runtime auth tokens before stream checks begin.
		await twitchAuth.updateTwitchAuthConfig();
		await kickAuth.updateKickAuthConfig();

		// Start all cron jobs
		for (const [name, job] of Object.entries(client.cronJobs)) {
			job.start();
			console.log(writeLog(`Started cron job: ${name}`));
		}

		// Optional initial status
		client.user.setActivity({
			name: `Initializing...`,
			type: ActivityType.Playing,
		});
	},
};
