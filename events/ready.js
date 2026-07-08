const { Events, ActivityType } = require(`discord.js`);
const { error, info } = require(`../utils/writeLog.js`);
const { dbInit } = require(`../database/dbInit.js`);
const { updateKick, updateTwitch } = require(`../auth/refreshAuthTokens.js`);
const { startTwitchRoleEventSub } = require(`../modules/twitchRoleEventSub.js`);
const { syncAllTwitchRoles } = require(`../modules/twitchRoles.js`);
const { reconcileServerRows } = require(`../utils/serverLifecycle.js`);

module.exports = {
	name: Events.ClientReady,
	once: true,
	reconcileServerRows,
	async execute(client) {
		// Sync DB tables once on startup
		await dbInit();

		try {
			await reconcileServerRows(client);
		} catch (err) {
			error(`Failed to reconcile server table on startup.`, err, { module: `ready` });
		}

		// Prime runtime auth tokens before stream checks begin.
		info(`Priming auth tokens...`);

		await updateTwitch();
		await updateKick();

		client.twitchRoleEventSub = startTwitchRoleEventSub(client);

		await syncAllTwitchRoles(client);

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
