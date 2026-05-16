const { updateAuthKey } = require(`./updateAuthKey.js`);
const { ActivityType } = require(`discord.js`);
const { getStreamInfo } = require(`./getStreamInfo.js`);
const config = require(`../config.json`);
const { CronJob } = require(`cron`);


module.exports = (client) => {
	let activityIndex = -1;

	return {
		Twitch: new CronJob(config.twitchCron, async () => {
			await getStreamInfo(true, client);
		}),

		Kick: new CronJob(config.kickCron, async () => {
			await getStreamInfo(false, client);
		}),

		Status: new CronJob(config.statusCron, () => {
			let totalMembers = 0;
			client.guilds.cache.forEach(g => totalMembers += g.memberCount);

			const activities = [
				{ type: ActivityType.Watching, name: `${client.guilds.cache.size} servers` },
				{ type: ActivityType.Playing, name: `Sid Meier's Civilization V` },
				{ type: ActivityType.Watching, name: `${totalMembers} servants` },
				{ type: ActivityType.Playing, name: `Grand Theft Auto Auto VI` },
				{ type: ActivityType.Competing, name: `Galactic Domination` },
				{ type: ActivityType.Playing, name: `Final Fantasy X` },
				{ type: ActivityType.Playing, name: `Rocket League` },
				{ type: ActivityType.Playing, name: `hackmud` },
				{ type: ActivityType.Watching, name: `Kick.tv` },
				{ type: ActivityType.Playing, name: `Stellaris` },
				{ type: ActivityType.Watching, name: `Twitch.tv` },
				{ type: ActivityType.Competing, name: `Global Thermonuclear War` },
				{ type: ActivityType.Playing, name: `Clair Obscur: Expedition 33` },
			];

			activityIndex = (activityIndex + 1) % activities.length;
			client.user.setActivity(activities[activityIndex]);
		}),

		Auth: new CronJob(config.authCron, () => {
			// Updates for Twitch and Kick simultaneously
			updateAuthKey();
		}),
	};
};
