// Server lifecycle reconciliation.
//
// Hachi keeps server rows even after leaving a guild so data can be inspected or
// restored intentionally. These helpers mark join/leave state and reconcile live
// Discord guilds against persisted rows at startup.
const fs = require(`node:fs`);
const path = require(`node:path`);
const { Op } = require(`sequelize`);
const {
	BirthdayConfigs,
	BirthdayUsers,
	Channels,
	CommandMonitorWhitelists,
	RaidConfigs,
	RaidIncidentFiles,
	RaidIncidentMessages,
	RaidIncidents,
	RaidIncidentUsers,
	ReactionRoleItems,
	ReactionRoleMessages,
	RulesVerificationMessages,
	Servers,
	TwitchRoleConfigs,
	TwitchRoleLinks,
	sequelize,
} = require(`../database/dbObjects.js`);
const { debug, info, warn } = require(`./writeLog.js`);

const LEFT_SERVER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const evidenceRoot = path.resolve(__dirname, `../data/evidence`);

async function supportsLeftAt() {
	try {
		const columns = await sequelize.getQueryInterface().describeTable(Servers.tableName);
		return Boolean(columns.leftAt);
	} catch {
		return false;
	}
}

function resetServerLifecycleColumnCache() {
	return null;
}

function getGuilds(client) {
	return [...client.guilds.cache.values()];
}

function whereGuildIds(guildIds) {
	return { guildId: { [Op.in]: guildIds } };
}

function guildMeta(guild) {
	return {
		id: guild.id,
		name: guild.name,
	};
}

function serverRowForGuild(guild, hasLeftAt) {
	if (!hasLeftAt) {
		return { guildId: guild.id };
	}

	return {
		guildId: guild.id,
		leftAt: null,
	};
}

async function markServerJoined(guild) {
	const hasLeftAt = await supportsLeftAt();

	await Servers.upsert(serverRowForGuild(guild, hasLeftAt));
}

async function markServerLeft(guild, { now = new Date() } = {}) {
	const hasLeftAt = await supportsLeftAt();

	if (!hasLeftAt) {
		await Servers.upsert({ guildId: guild.id });
		warn(`Server leftAt tracking is pending database migration; kept server row without leave timestamp.`, {
			meta: { guild: guildMeta(guild) },
			module: `server-lifecycle`,
		});

		return {
			guildId: guild.id,
			tracked: false,
		};
	}

	await Servers.upsert({
		guildId: guild.id,
		leftAt: now,
	});

	info(`Marked server as left: ${guild.name || `Unknown server`} | ID: ${guild.id}`, {
		meta: {
			guild: guildMeta(guild),
			leftAt: now.toISOString(),
		},
		module: `server-lifecycle`,
	});

	return {
		guildId: guild.id,
		leftAt: now,
		tracked: true,
	};
}

async function createMissingServerRows(missingGuilds, hasLeftAt) {
	if (!missingGuilds.length) {
		return;
	}

	await Servers.bulkCreate(
		missingGuilds.map(guild => serverRowForGuild(guild, hasLeftAt)),
		{ ignoreDuplicates: true },
	);
}

async function clearRejoinedServers(rejoinedGuilds) {
	if (!rejoinedGuilds.length) {
		return;
	}

	await Servers.update(
		{ leftAt: null },
		{ where: whereGuildIds(rejoinedGuilds.map(guild => guild.id)) },
	);
}

async function markMissingServersLeft(guildIds, now) {
	const missingServers = await Servers.findAll({
		attributes: [`guildId`],
		raw: true,
		where: {
			guildId: { [Op.notIn]: guildIds },
			leftAt: null,
		},
	});
	const missingGuildIds = missingServers.map(server => server.guildId);

	if (!missingGuildIds.length) {
		return [];
	}

	await Servers.update(
		{ leftAt: now },
		{ where: whereGuildIds(missingGuildIds) },
	);

	return missingGuildIds;
}

function logReconciliation({ guilds, markedLeftGuildIds, missingGuilds, rejoinedGuilds }) {
	if (!missingGuilds.length && !rejoinedGuilds.length && !markedLeftGuildIds.length) {
		debug(`Server table reconciliation complete: all ${guilds.length} guild(s) already have active server rows.`, {
			module: `server-lifecycle`,
		});
		return;
	}

	info(`Reconciled server table on startup.`, {
		meta: {
			created: missingGuilds.map(guildMeta),
			markedLeft: markedLeftGuildIds,
			rejoined: rejoinedGuilds.map(guildMeta),
		},
		module: `server-lifecycle`,
	});
}

function isInsideEvidenceRoot(targetPath) {
	const relativePath = path.relative(evidenceRoot, targetPath);

	return Boolean(relativePath) && !relativePath.startsWith(`..`) && !path.isAbsolute(relativePath);
}

async function deleteEvidenceDirectories(guildIds) {
	for (const guildId of guildIds) {
		const guildEvidencePath = path.resolve(evidenceRoot, guildId);

		if (!isInsideEvidenceRoot(guildEvidencePath)) {
			warn(`Skipped unsafe raid evidence cleanup path.`, {
				meta: {
					guildId,
					path: guildEvidencePath,
				},
				module: `server-lifecycle`,
			});
			continue;
		}

		try {
			await fs.promises.rm(guildEvidencePath, { force: true, recursive: true });
		} catch (err) {
			warn(`Failed to delete raid evidence folder for left server.`, {
				meta: {
					error: err.message,
					guildId,
					path: guildEvidencePath,
				},
				module: `server-lifecycle`,
			});
		}
	}
}

async function deleteGuildScopedRows(guildIds) {
	const guildWhere = whereGuildIds(guildIds);

	await sequelize.transaction(async transaction => {
		const incidentRows = await RaidIncidents.findAll({
			attributes: [`id`],
			raw: true,
			transaction,
			where: guildWhere,
		});
		const incidentIds = incidentRows.map(incident => incident.id);

		if (incidentIds.length) {
			const incidentWhere = { incidentId: { [Op.in]: incidentIds } };

			await RaidIncidentFiles.destroy({ transaction, where: incidentWhere });
			await RaidIncidentMessages.destroy({ transaction, where: incidentWhere });
			await RaidIncidentUsers.destroy({ transaction, where: incidentWhere });
		}

		await RaidIncidentFiles.destroy({ transaction, where: guildWhere });
		await RaidIncidentMessages.destroy({ transaction, where: guildWhere });
		await RaidIncidentUsers.destroy({ transaction, where: guildWhere });
		await RaidIncidents.destroy({ transaction, where: guildWhere });
		await RaidConfigs.destroy({ transaction, where: guildWhere });
		await TwitchRoleLinks.destroy({ transaction, where: guildWhere });
		await TwitchRoleConfigs.destroy({ transaction, where: guildWhere });
		await CommandMonitorWhitelists.destroy({ transaction, where: guildWhere });
		await BirthdayConfigs.destroy({ transaction, where: guildWhere });
		await BirthdayUsers.destroy({ transaction, where: guildWhere });
		await RulesVerificationMessages.destroy({ transaction, where: guildWhere });
		await ReactionRoleItems.destroy({ transaction, where: guildWhere });
		await ReactionRoleMessages.destroy({ transaction, where: guildWhere });
		await Channels.destroy({ transaction, where: guildWhere });
		await Servers.destroy({ transaction, where: guildWhere });
	});
}

async function deleteExpiredLeftServers({ now = new Date() } = {}) {
	const hasLeftAt = await supportsLeftAt();

	if (!hasLeftAt) {
		return {
			deleted: 0,
			guildIds: [],
		};
	}

	const cutoff = new Date(now.getTime() - LEFT_SERVER_RETENTION_MS);
	const expiredServers = await Servers.findAll({
		attributes: [`guildId`, `leftAt`],
		raw: true,
		where: {
			leftAt: {
				[Op.ne]: null,
				[Op.lte]: cutoff,
			},
		},
	});
	const guildIds = expiredServers.map(server => server.guildId);

	if (!guildIds.length) {
		return {
			deleted: 0,
			guildIds: [],
		};
	}

	await deleteGuildScopedRows(guildIds);
	await deleteEvidenceDirectories(guildIds);

	info(`Deleted ${guildIds.length} server record(s) left for at least 7 days.`, {
		meta: {
			cutoff: cutoff.toISOString(),
			guildIds,
		},
		module: `server-lifecycle`,
	});

	return {
		deleted: guildIds.length,
		guildIds,
	};
}

async function reconcileServerRows(client, { now = new Date() } = {}) {
	const guilds = getGuilds(client);

	if (!guilds.length) {
		debug(`Server table reconciliation skipped: bot is not in any guilds.`, {
			module: `server-lifecycle`,
		});

		return {
			created: 0,
			deleted: 0,
			rejoined: 0,
			total: 0,
		};
	}

	const hasLeftAt = await supportsLeftAt();
	const guildIds = guilds.map(guild => guild.id);
	const attributes = hasLeftAt ? [`guildId`, `leftAt`] : [`guildId`];
	const existingServers = await Servers.findAll({
		attributes,
		raw: true,
		where: whereGuildIds(guildIds),
	});
	const existingByGuildId = new Map(existingServers.map(server => [server.guildId, server]));
	const missingGuilds = guilds.filter(guild => !existingByGuildId.has(guild.id));
	const rejoinedGuilds = hasLeftAt ?
		guilds.filter(guild => existingByGuildId.get(guild.id)?.leftAt) :
		[];
	const markedLeftGuildIds = hasLeftAt ?
		await markMissingServersLeft(guildIds, now) :
		[];

	await createMissingServerRows(missingGuilds, hasLeftAt);
	await clearRejoinedServers(rejoinedGuilds);

	if (!hasLeftAt) {
		warn(`Server leftAt tracking is pending database migration; leave cleanup is disabled until servers.leftAt exists.`, {
			module: `server-lifecycle`,
		});
	}

	logReconciliation({ guilds, markedLeftGuildIds, missingGuilds, rejoinedGuilds });

	const cleanupResult = hasLeftAt ?
		await deleteExpiredLeftServers({ now }) :
		{ deleted: 0, guildIds: [] };

	return {
		created: missingGuilds.length,
		deleted: cleanupResult.deleted,
		markedLeft: markedLeftGuildIds.length,
		rejoined: rejoinedGuilds.length,
		total: guilds.length,
	};
}

module.exports = {
	LEFT_SERVER_RETENTION_MS,
	deleteExpiredLeftServers,
	markServerJoined,
	markServerLeft,
	reconcileServerRows,
	resetServerLifecycleColumnCache,
	supportsLeftAt,
};
