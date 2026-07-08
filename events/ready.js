const { Events, ActivityType } = require(`discord.js`);
const { Servers } = require(`../database/dbObjects.js`);
const { debug, error, info } = require(`../utils/writeLog.js`);
const { dbInit } = require(`../database/dbInit.js`);
const { updateKick, updateTwitch } = require(`../auth/refreshAuthTokens.js`);
const { startTwitchRoleEventSub } = require(`../modules/twitchRoleEventSub.js`);
const { syncAllTwitchRoles } = require(`../modules/twitchRoles.js`);

async function reconcileServerRows(client) {
	const guilds = [...client.guilds.cache.values()];

	if (!guilds.length) {
		debug(`Server table reconciliation skipped: bot is not in any guilds.`, { module: `ready` });
		return { created: 0, total: 0 };
	}

	const guildIds = guilds.map(guild => guild.id);
	const existingServers = await Servers.findAll({
		attributes: [`guildId`],
		raw: true,
		where: { guildId: guildIds },
	});
	const existingGuildIds = new Set(existingServers.map(server => server.guildId));
	const missingGuilds = guilds.filter(guild => !existingGuildIds.has(guild.id));

	if (!missingGuilds.length) {
		debug(`Server table reconciliation complete: all ${guilds.length} guild(s) already have server rows.`, { module: `ready` });
		return { created: 0, total: guilds.length };
	}

	await Servers.bulkCreate(
		missingGuilds.map(guild => ({ guildId: guild.id })),
		{ ignoreDuplicates: true },
	);

	info(`Reconciled server table on startup: created ${missingGuilds.length} missing server row(s).`, {
		meta: {
			guilds: missingGuilds.map(guild => ({
				id: guild.id,
				name: guild.name,
			})),
		},
		module: `ready`,
	});

	return { created: missingGuilds.length, total: guilds.length };
}

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
