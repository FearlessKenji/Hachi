const { CronJob } = require(`cron`);
const kick = require(`../modules/getKick.js`);
const twitch = require(`../modules/getTwitch.js`);
const config = require(`../config/config.json`);
const { ActivityType } = require(`discord.js`);
const kickAuth = require(`../auth/updateKickAuthConfig.js`);
const twitchAuth = require(`../auth/updateTwitchAuthConfig.js`);

module.exports = (client) => {
	let activityIndex = -1;

	return {
		Twitch: new CronJob(config.twitchCron, async () => {
			await twitch.checkTwitch(client);
		}),

		Kick: new CronJob(config.kickCron, async () => {
			await kick.checkKick(client);
		}),

		Status: new CronJob(config.statusCron, () => {
			let totalMembers = 0;
			client.guilds.cache.forEach(g => totalMembers += g.memberCount);

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

		Auth: new CronJob(config.authCron, () => {
			twitchAuth.updateTwitchAuthConfig();
			kickAuth.updateKickAuthConfig();
		}),
	};
};
