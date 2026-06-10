const { CronJob } = require(`cron`);
const { getKick } = require(`../modules/getKick.js`);
const { getTwitch } = require(`../modules/getTwitch.js`);
const config = require(`../config/config.json`);
const { ActivityType } = require(`discord.js`);
const { updateKick, updateTwitch } = require(`../auth/refreshAuthTokens.js`);
const { checkBirthdays } = require(`./birthdays.js`);

module.exports = (client) => {
	let activityIndex = -1;

	return {
		Twitch: new CronJob(config.twitchCron, async () => {
			await getTwitch(client);
		}),

		Kick: new CronJob(config.kickCron, async () => {
			await getKick(client);
		}),

		Birthdays: new CronJob(config.birthdayCron, async () => {
			await checkBirthdays(client);
		}),

		Status: new CronJob(config.statusCron, () => {
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
		}),

		Auth: new CronJob(config.authCron, async () => {
			await Promise.all([
				updateTwitch(),
				updateKick(),
			]);
		}),
	};
};
