// Cron job factory.
//
// The ready event calls this once with the Discord client. Configured feature
// checks retain their schedules; independent cleanup runs later in the hour.
const { CronJob } = require(`cron`);
const { getKick } = require(`../modules/getKick.js`);
const { getTwitch } = require(`../modules/getTwitch.js`);
const config = require(`../config/config.json`);
const { ActivityType } = require(`discord.js`);
const { updateKick, updateTwitch } = require(`../auth/refreshAuthTokens.js`);
const { getAuthTokens } = require(`../auth/authTokens.js`);
const { checkBirthdays, runBirthdayMaintenance } = require(`./birthdays.js`);
const { syncAllTwitchRoles } = require(`../modules/twitchRoles.js`);
const { syncAllLinkBlockRules } = require(`./linkBlocking.js`);
const { cleanupClosedTickets } = require(`./modmail.js`);
const { error } = require(`./writeLog.js`);

const BIRTHDAY_MAINTENANCE_CRON = `7 * * * *`;
const MODMAIL_CLEANUP_CRON = `17 * * * *`;

function logCronFailure(jobName) {
	return failure => error(`${jobName} cron job failed.`, failure, { module: `cron` });
}

module.exports = (client) => {
	let activityIndex = -1;

	return {
		// Slow provider or database calls must finish before the next tick starts;
		// overlapping stream polls amplify SQLite contention and API traffic.
		Twitch: CronJob.from({
			cronTime: config.twitchCron,
			onTick: async () => {
				// OAuth retries own provider recovery. Polling without a token only
				// creates repeated unauthorized API requests.
				if (!getAuthTokens().twitchAuthToken) {
					return;
				}

				await getTwitch(client);
			},
			waitForCompletion: true,
			errorHandler: logCronFailure(`Twitch`),
		}),

		Kick: CronJob.from({
			cronTime: config.kickCron,
			onTick: async () => {
				if (!getAuthTokens().kickAuthToken) {
					return;
				}

				await getKick(client);
			},
			waitForCompletion: true,
			errorHandler: logCronFailure(`Kick`),
		}),

		Birthday: CronJob.from({
			cronTime: config.birthdayCron,
			onTick: async () => {
				await checkBirthdays(client);
			},
			waitForCompletion: true,
			errorHandler: logCronFailure(`Birthday`),
		}),

		// Departure purges and pending board retries need no exact posting minute.
		BirthdayMaintenance: CronJob.from({
			cronTime: BIRTHDAY_MAINTENANCE_CRON,
			onTick: async () => {
				await runBirthdayMaintenance(client);
			},
			waitForCompletion: true,
			errorHandler: logCronFailure(`Birthday maintenance`),
		}),

		Modmail: CronJob.from({
			cronTime: MODMAIL_CLEANUP_CRON,
			onTick: async () => {
				await cleanupClosedTickets(client);
			},
			waitForCompletion: true,
			errorHandler: logCronFailure(`Modmail cleanup`),
		}),

		Status: CronJob.from({
			cronTime: config.statusCron,
			onTick: () => {
				let totalMembers = 0;
				client.guilds.cache.forEach(guild => totalMembers += guild.memberCount);

				const activities = [
					{ type: ActivityType.Watching, name: `${client.guilds.cache.size} servers` },
					{ type: ActivityType.Watching, name: `${totalMembers} servants` },
					{ type: ActivityType.Playing, name: `Sid Meier's Civilization V` },
					{ type: ActivityType.Playing, name: `Grand Theft Auto Auto VI` },
					{ type: ActivityType.Playing, name: `Final Fantasy X` },
					{ type: ActivityType.Playing, name: `Rocket League` },
					{ type: ActivityType.Playing, name: `hackmud` },
					{ type: ActivityType.Playing, name: `Stellaris` },
					{ type: ActivityType.Playing, name: `Clair Obscur: Expedition 33` },
					{ type: ActivityType.Watching, name: `Twitch.tv` },
					{ type: ActivityType.Competing, name: `Global Thermonuclear War` },
					{ type: ActivityType.Competing, name: `Galactic Domination` },
				];

				activityIndex = (activityIndex + 1) % activities.length;
				client.user.setActivity(activities[activityIndex]);
			},
			waitForCompletion: true,
			errorHandler: logCronFailure(`Status`),
		}),

		Auth: CronJob.from({
			cronTime: config.authCron,
			onTick: async () => {
				await Promise.all([
					updateTwitch(),
					updateKick(),
					syncAllTwitchRoles(client),
					syncAllLinkBlockRules(client),
				]);
			},
			waitForCompletion: true,
			errorHandler: logCronFailure(`Auth`),
		}),
	};
};
