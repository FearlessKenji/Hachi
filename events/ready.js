const { Events, ActivityType } = require(`discord.js`);
const { info } = require(`../utils/writeLog.js`);
const { dbInit } = require(`../database/dbInit.js`);
const { updateKick, updateTwitch } = require(`../auth/refreshAuthTokens.js`);

module.exports = {
	name: Events.ClientReady,
	once: true,
	async execute(client) {
		// Sync DB tables once on startup
		await dbInit();

		// Prime runtime auth tokens before stream checks begin.
		info(`Priming auth tokens...`);

		await updateTwitch();
		await updateKick();

		// Start all cron jobs
		for (const [name, job] of Object.entries(client.cronJobs)) {
			job.start();
			info(`Started cron job: ${name}`);
		}

		// Optional initial status
		client.user.setActivity({
			name: `Initializing...`,
			type: ActivityType.Playing,
		});

		info(`Ready! Logged into Discord as ${client.user.tag}`);
	},
};
