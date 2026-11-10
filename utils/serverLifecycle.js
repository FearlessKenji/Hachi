// Server lifecycle reconciliation.
//
// Hachi keeps server rows even after leaving a guild so data can be inspected or
// restored intentionally. These helpers mark join/leave state and reconcile live
// Discord guilds against persisted rows at startup.
const fs = require(`node:fs`);
const path = require(`node:path`);
const { Op, Transaction } = require(`sequelize`);
const {
	AnnouncementDeliveryProgress,
	BirthdayBoardRetiredMessages,
	BirthdayCards,
	BirthdayConfigs,
	BirthdayUsers,
	Channels,
	CommandMonitorWhitelists,
	KickLiveSessions,
	LinkBlockRules,
	LinkConfigs,
	LinkFixRules,
	ModmailConfigs,
	ModmailTickets,
	PendingStreamVods,
	RaidConfigs,
	RaidIncidentFiles,
	RaidIncidentMessages,
	RaidIncidents,
	RaidIncidentUsers,
	ReactionRoleItems,
	ReactionRoleMessages,
	RulesVerificationMessages,
	Servers,
	StreamChannelIdentities,
	TwitchRoleConfigs,
	TwitchRoleLinks,
	TwitchVerificationPanels,
	sequelize,
} = require(`../database/dbObjects.js`);
const { debug, info, warn } = require(`./writeLog.js`);
const { transferBirthdayCardsFromGuild } = require(`./birthdays.js`);

const LEFT_SERVER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const evidenceRoot = path.resolve(__dirname, `../data/evidence`);
const pendingEvidenceRoot = path.resolve(evidenceRoot, `.pending-delete`);
const SAFE_EVIDENCE_GUILD_ID = /^[A-Za-z0-9_-]+$/u;

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

	// A failed card transfer must leave the guild active in the database so a
	// later leave event or startup reconciliation can retry the entire change.
	await sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
		await Servers.upsert({
			guildId: guild.id,
			leftAt: now,
		}, { transaction });
		await transferBirthdayCardsFromGuild(guild.id, { transaction });
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
	return sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
		const missingServers = await Servers.findAll({
			attributes: [`guildId`],
			raw: true,
			transaction,
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
			{ transaction, where: whereGuildIds(missingGuildIds) },
		);
		for (const guildId of missingGuildIds) {
			await transferBirthdayCardsFromGuild(guildId, { transaction });
		}

		return missingGuildIds;
	});
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

function evidencePathsForGuild(guildId) {
	const safeGuildId = String(guildId);
	if (!SAFE_EVIDENCE_GUILD_ID.test(safeGuildId)) {
		throw new Error(`Refusing to clean an unsafe raid evidence guild ID: ${safeGuildId}.`);
	}

	const originalPath = path.resolve(evidenceRoot, safeGuildId);
	const stagedPath = path.resolve(pendingEvidenceRoot, safeGuildId);
	if (!isInsideEvidenceRoot(originalPath) || !isInsideEvidenceRoot(stagedPath)) {
		throw new Error(`Refusing to clean raid evidence outside its root for guild ${safeGuildId}.`);
	}
	return { originalPath, stagedPath };
}

async function directoryExistsWithoutSymlink(directoryPath) {
	try {
		const stats = await fs.promises.lstat(directoryPath);
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new Error(`Raid evidence path is not a regular directory: ${directoryPath}.`);
		}
		return true;
	} catch (err) {
		if (err.code === `ENOENT`) {
			return false;
		}
		throw err;
	}
}

async function stageEvidenceDirectories(guildIds, stagedGuildIds) {
	for (const guildId of guildIds) {
		const { originalPath, stagedPath } = evidencePathsForGuild(guildId);
		if (!await directoryExistsWithoutSymlink(originalPath)) {
			continue;
		}
		if (!await directoryExistsWithoutSymlink(evidenceRoot)) {
			throw new Error(`Raid evidence root disappeared before cleanup.`);
		}
		await fs.promises.mkdir(pendingEvidenceRoot, { recursive: true });
		await directoryExistsWithoutSymlink(pendingEvidenceRoot);
		if (await directoryExistsWithoutSymlink(stagedPath)) {
			throw new Error(`Raid evidence for guild ${guildId} is already staged for deletion.`);
		}
		// Rename is reversible and stays on the same filesystem. Permanent removal
		// happens only after the database commits its child-first deletion.
		await fs.promises.rename(originalPath, stagedPath);
		stagedGuildIds.push(guildId);
	}
}

async function restoreStagedEvidenceDirectories(guildIds) {
	const failures = [];
	for (const guildId of [...guildIds].reverse()) {
		const { originalPath, stagedPath } = evidencePathsForGuild(guildId);
		try {
			if (!await directoryExistsWithoutSymlink(stagedPath)) {
				continue;
			}
			if (await directoryExistsWithoutSymlink(originalPath)) {
				throw new Error(`Original raid evidence path already exists for guild ${guildId}.`);
			}
			await fs.promises.rename(stagedPath, originalPath);
		} catch (err) {
			failures.push(err);
			warn(`Could not restore staged raid evidence after database rollback.`, {
				meta: { guildId, error: err.message },
				module: `server-lifecycle`,
			});
		}
	}
	return failures;
}

async function purgeStagedEvidenceDirectories(guildIds) {
	for (const guildId of guildIds) {
		const { stagedPath } = evidencePathsForGuild(guildId);
		try {
			if (await directoryExistsWithoutSymlink(stagedPath)) {
				await fs.promises.rm(stagedPath, { force: true, recursive: true });
			}
		} catch (err) {
			// The server ID is already gone. Keep this directory in the pending area
			// for startup recovery rather than pretending the DB can roll back.
			warn(`Could not finish staged raid evidence deletion; startup will retry.`, {
				meta: { guildId, error: err.message },
				module: `server-lifecycle`,
			});
		}
	}
}

async function recoverStagedEvidenceDirectories() {
	if (!await directoryExistsWithoutSymlink(pendingEvidenceRoot)) {
		return;
	}
	const entries = await fs.promises.readdir(pendingEvidenceRoot, { withFileTypes: true });
	for (const entry of entries) {
		if (!SAFE_EVIDENCE_GUILD_ID.test(entry.name) || !entry.isDirectory()) {
			warn(`Preserved an unexpected pending raid evidence path for manual review.`, {
				meta: { name: entry.name },
				module: `server-lifecycle`,
			});
			continue;
		}
		const { originalPath, stagedPath } = evidencePathsForGuild(entry.name);
		const server = await Servers.findByPk(entry.name, { attributes: [`guildId`], raw: true });
		if (server) {
			if (await directoryExistsWithoutSymlink(originalPath)) {
				warn(`Preserved staged raid evidence because its original path already exists.`, {
					meta: { guildId: entry.name },
					module: `server-lifecycle`,
				});
				continue;
			}
			// SQLite rolled back or Hachi stopped before commit. Restore evidence
			// while the surviving server row still refers to its incident records.
			await fs.promises.rename(stagedPath, originalPath);
		} else {
			// The server ID was committed as deleted; finish the interrupted purge.
			await fs.promises.rm(stagedPath, { force: true, recursive: true });
		}
	}
}

async function deleteGuildScopedRows(guildIds, cutoff) {
	const stagedGuildIds = [];
	let deletedGuildIds;
	try {
		deletedGuildIds = await sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
			// Recheck the cutoff under the write lock. A guild that rejoined while
			// cleanup was waiting must keep its server ID and all dependent rows.
			const expiredServers = await Servers.findAll({
				attributes: [`guildId`],
				raw: true,
				transaction,
				where: {
					guildId: { [Op.in]: guildIds },
					leftAt: { [Op.ne]: null, [Op.lte]: cutoff },
				},
			});
			const expiredGuildIds = expiredServers.map(server => server.guildId);
			if (!expiredGuildIds.length) {
				return [];
			}
			const guildWhere = whereGuildIds(expiredGuildIds);
			const associatedCardRows = await BirthdayCards.findAll({
				attributes: [`userId`],
				raw: true,
				transaction,
				where: {
					[Op.or]: [
						guildWhere,
						{ deliveryGuildId: { [Op.in]: expiredGuildIds } },
					],
				},
			});
			// Transfer cards only for guilds that are still expired under the lock.
			// This keeps card ownership changes in the same transaction as cleanup.
			for (const guildId of expiredGuildIds) {
				await transferBirthdayCardsFromGuild(guildId, { transaction });
			}
			const channelRows = await Channels.findAll({ attributes: [`id`], raw: true, transaction, where: guildWhere });
			const birthdayRows = await BirthdayUsers.findAll({ attributes: [`userId`], raw: true, transaction, where: guildWhere });
			const channelIds = channelRows.map(channel => channel.id);
			const candidateUserIds = [...new Set([...birthdayRows, ...associatedCardRows].map(row => row.userId))];
			if (candidateUserIds.length) {
				const retainedBirthdayRows = await BirthdayUsers.findAll({
					attributes: [`userId`],
					raw: true,
					transaction,
					where: {
						guildId: { [Op.notIn]: expiredGuildIds },
						userId: { [Op.in]: candidateUserIds },
					},
				});
				const retainedUserIds = new Set(retainedBirthdayRows.map(row => row.userId));
				const orphanedUserIds = candidateUserIds.filter(userId => !retainedUserIds.has(userId));
				if (orphanedUserIds.length) {
					await BirthdayCards.destroy({
						transaction,
						where: { userId: { [Op.in]: orphanedUserIds } },
					});
				}
			}

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
			await AnnouncementDeliveryProgress.destroy({ transaction, where: guildWhere });
			await LinkBlockRules.destroy({ transaction, where: guildWhere });
			await LinkFixRules.destroy({ transaction, where: guildWhere });
			await LinkConfigs.destroy({ transaction, where: guildWhere });
			await TwitchRoleLinks.destroy({ transaction, where: guildWhere });
			await TwitchVerificationPanels.destroy({ transaction, where: guildWhere });
			await TwitchRoleConfigs.destroy({ transaction, where: guildWhere });
			await CommandMonitorWhitelists.destroy({ transaction, where: guildWhere });
			await ModmailTickets.destroy({ transaction, where: guildWhere });
			await ModmailConfigs.destroy({ transaction, where: guildWhere });
			await BirthdayBoardRetiredMessages.destroy({ transaction, where: guildWhere });
			await BirthdayConfigs.destroy({ transaction, where: guildWhere });
			await BirthdayUsers.destroy({ transaction, where: guildWhere });
			await RulesVerificationMessages.destroy({ transaction, where: guildWhere });
			await ReactionRoleItems.destroy({ transaction, where: guildWhere });
			await ReactionRoleMessages.destroy({ transaction, where: guildWhere });
			if (channelIds.length) {
				const channelWhere = { channelId: { [Op.in]: channelIds } };
				await StreamChannelIdentities.destroy({ transaction, where: channelWhere });
				await PendingStreamVods.destroy({ transaction, where: channelWhere });
				await KickLiveSessions.destroy({ transaction, where: channelWhere });
			}
			await Channels.destroy({ transaction, where: guildWhere });
			await stageEvidenceDirectories(expiredGuildIds, stagedGuildIds);
			await Servers.destroy({ transaction, where: guildWhere });
			return expiredGuildIds;
		});
	} catch (err) {
		const restorationFailures = await restoreStagedEvidenceDirectories(stagedGuildIds);
		if (restorationFailures.length) {
			throw new AggregateError([err, ...restorationFailures], `Server cleanup failed and some raid evidence could not be restored.`, { cause: err });
		}
		throw err;
	}

	await purgeStagedEvidenceDirectories(stagedGuildIds);
	return deletedGuildIds;
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

	const deletedGuildIds = await deleteGuildScopedRows(guildIds, cutoff);

	if (deletedGuildIds.length) {
		info(`Deleted ${deletedGuildIds.length} server record(s) left for at least 7 days.`, {
			meta: {
				cutoff: cutoff.toISOString(),
				guildIds: deletedGuildIds,
			},
			module: `server-lifecycle`,
		});
	}

	return {
		deleted: deletedGuildIds.length,
		guildIds: deletedGuildIds,
	};
}

async function reconcileServerRows(client, { now = new Date() } = {}) {
	// Resolve a crash between staging evidence and committing or purging the
	// database deletion before changing any server rows on this startup.
	await recoverStagedEvidenceDirectories();
	const guilds = getGuilds(client);

	if (!guilds.length) {
		const hasLeftAt = await supportsLeftAt();
		const markedLeftGuildIds = hasLeftAt ? await markMissingServersLeft([], now) : [];
		const cleanupResult = hasLeftAt ? await deleteExpiredLeftServers({ now }) : { deleted: 0 };
		debug(`Server table reconciliation found no current guilds.`, {
			module: `server-lifecycle`,
		});

		return {
			created: 0,
			deleted: cleanupResult.deleted,
			markedLeft: markedLeftGuildIds.length,
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
