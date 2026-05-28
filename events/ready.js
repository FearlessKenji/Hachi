const { Events, ActivityType } = require(`discord.js`);
const { writeLog } = require(`../modules/writeLog.js`);
const { dbInit } = require(`../modules/dbInit.js`);

module.exports = {
	name: Events.ClientReady,
	once: true,
	async execute(client) {
		// Sync DB tables once on startup
		await dbInit();

		console.log(writeLog(`Ready! Logged in as ${client.user.tag}`));

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
