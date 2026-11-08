// Discord ready event.
//
// This is the first point where Hachi has a connected Discord client. It
// initializes database state, starts cron jobs, and schedules slower optional
// reconciliation after the bot is ready to serve events.
const { Events, ActivityType } = require(`discord.js`);
const { error, info } = require(`../utils/writeLog.js`);
const { dbInit } = require(`../database/dbInit.js`);
const { updateKick, updateTwitch } = require(`../auth/refreshAuthTokens.js`);
const { startTwitchRoleEventSub } = require(`../modules/twitchRoleEventSub.js`);
const { syncAllTwitchRoles } = require(`../modules/twitchRoles.js`);
const { reconcileServerRows } = require(`../utils/serverLifecycle.js`);
const { reconcileVerificationPanels } = require(`../utils/twitchVerificationPanels.js`);
const {
	purgeExpiredBirthdayDepartures,
	reconcileStoredBirthdayMemberships,
	retryPendingBirthdayBoardWork,
} = require(`../utils/birthdays.js`);
const BIRTHDAY_RECONCILIATION_RETRY_MS = 60 * 60 * 1000;
let birthdayRetryTimer = null;

function scheduleBirthdayRetry(client) {
	if (birthdayRetryTimer) {
		return;
	}

	birthdayRetryTimer = setTimeout(() => {
		birthdayRetryTimer = null;
		void reconcileBirthdays(client);
	}, BIRTHDAY_RECONCILIATION_RETRY_MS);
	birthdayRetryTimer.unref();
}

async function reconcileBirthdays(client) {
	try {
		// Restore timely rejoins before removing expired departures. A Discord
		// lookup failure can leave membership unverified, so retry later.
		const result = await reconcileStoredBirthdayMemberships(client);

		if (result.unverified > 0) {
			// A previously marked departure may be a member who rejoined while
			// Discord could not be queried. Keep all rows until the next check.
			scheduleBirthdayRetry(client);
			return;
		}

		await purgeExpiredBirthdayDepartures();
	} catch (err) {
		error(`Failed to reconcile stored birthday memberships.`, err, { module: `birthday` });
		scheduleBirthdayRetry(client);
	}
}

function runOptionalStartupTask(name, task) {
	void Promise.resolve().then(task).catch(err => {
		error(`Failed to initialize ${name}.`, err, { module: `ready` });
	});
}

module.exports = {
	name: Events.ClientReady,
	once: true,
	reconcileServerRows,
	async execute(client) {
		// Database and server rows are required by command and cron handlers.
		// Their failure propagates to index.js, which stops PM2 restart loops.
		await dbInit();
		await reconcileServerRows(client);

		// Prime runtime auth tokens before stream checks begin.
		info(`Priming auth tokens...`);

		await Promise.all([updateTwitch(), updateKick()]);

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

		// These operations can need many Discord or provider calls. They run with
		// explicit error handling after core startup so polling is not held back.
		void reconcileBirthdays(client);
		runOptionalStartupTask(`birthday board cleanup`, () => retryPendingBirthdayBoardWork(client));
		runOptionalStartupTask(`Twitch role EventSub`, () => {
			client.twitchRoleEventSub = startTwitchRoleEventSub(client);
		});
		runOptionalStartupTask(`Twitch role sync`, () => syncAllTwitchRoles(client));
		runOptionalStartupTask(`verification panels`, () => reconcileVerificationPanels(client));
	},
};
