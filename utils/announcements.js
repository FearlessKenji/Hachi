// Manual Hachi announcement and user-facing patch-note helpers.
//
// CHANGELOG.md is for exhaustive developer history. docs/patch-notes.md is the
// user-facing source this module reads when an owner or admin manually sends the
// latest Hachi update to opted-in servers.
const fs = require(`node:fs`);
const path = require(`node:path`);
const crypto = require(`node:crypto`);
const { Op } = require(`sequelize`);
const { MessageFlags, PermissionFlagsBits } = require(`discord.js`);
const { AnnouncementDeliveryProgress, Servers, sequelize } = require(`../database/dbObjects.js`);
const { error, warn } = require(`./writeLog.js`);

const PATCH_NOTES_PATH = path.resolve(__dirname, `..`, `docs`, `patch-notes.md`);
const ANNOUNCEMENT_MESSAGE_LIMIT = 1900;
const MANAGER_WARNING_LIMIT = 3;
const MANAGER_WARNING_INTERVAL_MS = 15 * 60 * 1000;
const MANAGER_WARNING_WINDOW_MS = 24 * 60 * 60 * 1000;
const RELEASE_HEADING_PATTERN = /^#\s+(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/u;
const DELIVERY_PROGRESS_VERSION = 1;
const MAX_RECOVERY_HISTORY_PAGES = 50;
const announcementDeliveryTails = new Map();

const CLEARED_WARNING_STATE = {
	hachiAnnouncementWarningCount: 0,
	hachiAnnouncementWarningKey: null,
	hachiAnnouncementWarningLastSentAt: null,
	hachiAnnouncementWarningWindowStartedAt: null,
};

function normalizeNewlines(text) {
	return String(text || ``).replace(/\r\n?/gu, `\n`).trim();
}

function normalizeAnnouncementId(value) {
	// Discord select interactions normally provide snowflake strings, but some
	// resolved interaction shapes carry channel/guild objects. SQLite cannot
	// bind objects, so announcement IDs are reduced before they reach Sequelize.
	if (value === null || value === undefined || value === ``) {
		return null;
	}

	if (typeof value === `object`) {
		if (`id` in value) {
			return normalizeAnnouncementId(value.id);
		}

		if (`value` in value) {
			return normalizeAnnouncementId(value.value);
		}
	}

	const normalized = String(value).trim();
	return normalized || null;
}

function requireAnnouncementId(value, label) {
	const normalized = normalizeAnnouncementId(value);

	if (!normalized) {
		throw new Error(`${label} is required.`);
	}

	return normalized;
}

function readPatchNotesDocument(filePath = PATCH_NOTES_PATH) {
	if (!fs.existsSync(filePath)) {
		return ``;
	}

	return fs.readFileSync(filePath, `utf8`);
}

function parseLatestPatchNotes(documentText) {
	const releases = parsePatchNoteReleases(documentText);

	return releases[0] || null;
}

function parsePatchNoteReleases(documentText) {
	const text = normalizeNewlines(documentText);
	const lines = text.split(`\n`);
	const releaseIndexes = lines
		.map((line, index) => RELEASE_HEADING_PATTERN.test(line) ? index : -1)
		.filter(index => index !== -1);

	return releaseIndexes.map((releaseIndex, index) => {
		const nextReleaseIndex = releaseIndexes[index + 1];
		const releaseMatch = lines[releaseIndex].match(RELEASE_HEADING_PATTERN);
		const heading = lines[releaseIndex].replace(/^#\s+/u, ``).trim();
		const bodyLines = lines.slice(releaseIndex + 1, nextReleaseIndex === undefined ? undefined : nextReleaseIndex);
		const body = normalizeNewlines(bodyLines.join(`\n`));
		const version = releaseMatch?.[1] || ``;

		return {
			body,
			heading,
			id: version.startsWith(`v`) ? version : `v${version}`,
			version,
		};
	});
}

function getLatestPatchNotes() {
	return parseLatestPatchNotes(readPatchNotesDocument());
}

function selectPatchNotesForAnnouncement(releases, lastSentId, { force = false } = {}) {
	const normalizedReleases = Array.isArray(releases) ? releases.filter(note => note?.id) : [];
	const latest = normalizedReleases[0];

	if (!latest) {
		return [];
	}

	if (force || !lastSentId) {
		return [latest];
	}

	if (lastSentId === latest.id) {
		return [];
	}

	const lastSentIndex = normalizedReleases.findIndex(note => note.id === lastSentId);

	if (lastSentIndex === -1) {
		return [latest];
	}

	return normalizedReleases.slice(0, lastSentIndex).reverse();
}

function getPatchNotesForAnnouncement(lastSentId, options = {}) {
	return selectPatchNotesForAnnouncement(parsePatchNoteReleases(readPatchNotesDocument()), lastSentId, options);
}

function splitLongLine(line, limit) {
	const chunks = [];
	let remaining = String(line || ``);

	while (remaining.length > limit) {
		let splitAt = remaining.lastIndexOf(`. `, limit);

		if (splitAt < Math.floor(limit * 0.5)) {
			splitAt = remaining.lastIndexOf(` `, limit);
		}

		if (splitAt < 1) {
			splitAt = limit;
		}

		chunks.push(remaining.slice(0, splitAt + 1).trim());
		remaining = remaining.slice(splitAt + 1).trim();
	}

	if (remaining) {
		chunks.push(remaining);
	}

	return chunks;
}

function splitAnnouncementText(text, limit = ANNOUNCEMENT_MESSAGE_LIMIT) {
	const chunks = [];
	let current = ``;

	for (const line of normalizeNewlines(text).split(`\n`)) {
		const candidate = current ? `${current}\n${line}` : line;

		if (candidate.length <= limit) {
			current = candidate;
			continue;
		}

		if (current) {
			chunks.push(current);
		}

		if (line.length <= limit) {
			current = line;
			continue;
		}

		const longLineChunks = splitLongLine(line, limit);
		chunks.push(...longLineChunks.slice(0, -1));
		current = longLineChunks.at(-1) || ``;
	}

	if (current) {
		chunks.push(current);
	}

	return chunks;
}

function formatPatchNotesMessages(note) {
	if (!note?.body) {
		return [];
	}

	const body = normalizeNewlines(note.body);
	const text = `## Hachi ${note.heading}${body ? `\n\n${body}` : ``}`;
	return splitAnnouncementText(text);
}

async function getAnnouncementSettings(guildId) {
	const normalizedGuildId = requireAnnouncementId(guildId, `Guild ID`);
	const server = await Servers.findOne({
		raw: true,
		where: { guildId: normalizedGuildId },
	});

	return {
		guildId: normalizedGuildId,
		hachiAnnouncementChannelId: server?.hachiAnnouncementChannelId || null,
		hachiAnnouncementLastId: server?.hachiAnnouncementLastId || null,
	};
}

async function updateAnnouncementSettings(guildId, values) {
	const normalizedGuildId = requireAnnouncementId(guildId, `Guild ID`);
	const server = await Servers.findByPk(normalizedGuildId);

	if (server) {
		await server.update(values);
		return getAnnouncementSettings(normalizedGuildId);
	}

	await Servers.create({
		guildId: normalizedGuildId,
		...values,
	});
	return getAnnouncementSettings(normalizedGuildId);
}

async function saveAnnouncementChannel(guildId, channelId) {
	return serializeGuildAnnouncement(guildId, async () => {
		const normalizedChannelId = normalizeAnnouncementId(channelId);
		const existing = await getAnnouncementSettings(guildId);
		const settings = await updateAnnouncementSettings(guildId, {
			hachiAnnouncementChannelId: normalizedChannelId,
			...CLEARED_WARNING_STATE,
		});
		if (existing.hachiAnnouncementChannelId !== normalizedChannelId) {
			await AnnouncementDeliveryProgress.destroy({ where: { guildId: settings.guildId } });
		}
		return settings;
	});
}

async function clearAnnouncementChannel(guildId) {
	return serializeGuildAnnouncement(guildId, async () => {
		const settings = await updateAnnouncementSettings(guildId, {
			hachiAnnouncementChannelId: null,
			...CLEARED_WARNING_STATE,
		});
		await AnnouncementDeliveryProgress.destroy({ where: { guildId: settings.guildId } });
		return settings;
	});
}

async function fetchGuild(client, guildId) {
	return client.guilds.cache.get(guildId) || client.guilds.fetch(guildId).catch(() => null);
}

function missingPermissionResult(cannotView, cannotSend) {
	if (!cannotView && !cannotSend) {
		return null;
	}

	const missing = [];
	if (cannotView) {
		missing.push(`view`);
	}
	if (cannotSend) {
		missing.push(`send`);
	}

	let ability = `send messages in`;
	if (missing.length === 2) {
		ability = `view or send messages in`;
	} else if (missing[0] === `view`) {
		ability = `view`;
	}

	return {
		code: missing.join(`-`),
		ok: false,
		message: `Hachi cannot ${ability} the configured updates channel.`,
	};
}

async function checkAnnouncementChannelAccess(guild, channel) {
	if (!channel?.send || !channel.isTextBased?.()) {
		return { code: `unavailable`, ok: false, message: `The configured Hachi Updates channel is unavailable.` };
	}

	const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
	const permissions = me ? channel.permissionsFor(me) : null;
	const cannotView = !permissions?.has(PermissionFlagsBits.ViewChannel);
	const cannotSend = !permissions?.has(PermissionFlagsBits.SendMessages);

	return missingPermissionResult(cannotView, cannotSend) || { channel, ok: true };
}

async function fetchAnnouncementChannel(guild, channelId) {
	if (!channelId) {
		return { code: `missing`, ok: false, message: `No Hachi Updates channel is configured.` };
	}

	const channel = await guild.channels.fetch(channelId).catch(() => null);
	return checkAnnouncementChannelAccess(guild, channel);
}

async function recordAnnouncementFailure(guild, channelId, channelResult) {
	const server = await Servers.findByPk(guild.id);
	const warningKey = `${channelId || `none`}:${channelResult.code || `unknown`}`;

	if (server && server.hachiAnnouncementWarningKey !== warningKey) {
		// A materially different failure receives a fresh warning budget immediately.
		await server.update({
			...CLEARED_WARNING_STATE,
			hachiAnnouncementWarningKey: warningKey,
		});
	}
}

function managerWarningContent(warningKey) {
	const failureCode = String(warningKey || ``).split(`:`).at(-1);

	if (failureCode === `unavailable`) {
		return [
			`You are seeing this message because Hachi has patch note updates enabled on this server,`,
			`but the configured channel is no longer available. Use /setup to select another Hachi Updates`,
			`channel or clear the existing setting.`,
		].join(` `);
	}

	const permissionNames = [];
	if (failureCode.split(`-`).includes(`view`)) {
		permissionNames.push(`View Channel`);
	}
	if (failureCode.split(`-`).includes(`send`)) {
		permissionNames.push(`Send Messages`);
	}
	const missingPermissions = permissionNames.length ? permissionNames.join(`, `) : `Unknown`;

	return [
		`You are seeing this message because Hachi has patch note updates enabled on this server,`,
		`but it cannot post to the configured channel due to current permissions. Use /setup to repair`,
		`or clear the Hachi Updates channel, or modify the destination channel's permissions.`,
	].join(` `) + `\n\n**Missing permissions:** ${missingPermissions}`;
}

function isEligibleManagerInteraction(interaction) {
	return interaction.isChatInputCommand?.() && interaction.guildId &&
		interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function availableManagerWarningBudget(server, now) {
	const windowStartedAt = server.hachiAnnouncementWarningWindowStartedAt;
	const lastSentAt = server.hachiAnnouncementWarningLastSentAt;
	const windowExpired = !windowStartedAt || now - new Date(windowStartedAt) >= MANAGER_WARNING_WINDOW_MS;
	const warningCount = windowExpired ? 0 : server.hachiAnnouncementWarningCount;
	const intervalActive = lastSentAt && now - new Date(lastSentAt) < MANAGER_WARNING_INTERVAL_MS;

	if (warningCount >= MANAGER_WARNING_LIMIT || intervalActive) {
		return null;
	}

	return { warningCount, windowExpired, windowStartedAt };
}

async function sendAnnouncementWarningToManager(interaction, now = new Date()) {
	if (!isEligibleManagerInteraction(interaction)) {
		return false;
	}

	const server = await Servers.findByPk(interaction.guildId);
	if (!server?.hachiAnnouncementChannelId || !server.hachiAnnouncementWarningKey) {
		return false;
	}

	const budget = availableManagerWarningBudget(server, now);
	if (!budget) {
		return false;
	}

	const payload = {
		content: `## Hachi updates need attention:\n\n${managerWarningContent(server.hachiAnnouncementWarningKey)}`,
		flags: MessageFlags.Ephemeral,
	};

	if (interaction.replied || interaction.deferred) {
		await interaction.followUp(payload);
	} else {
		await interaction.reply(payload);
	}

	await server.update({
		hachiAnnouncementWarningCount: budget.warningCount + 1,
		hachiAnnouncementWarningLastSentAt: now,
		hachiAnnouncementWarningWindowStartedAt: budget.windowExpired ? now : budget.windowStartedAt,
	});
	return true;
}

function parseDeliveryProgress(row) {
	if (!row?.progressJson) {
		return null;
	}
	try {
		const progress = JSON.parse(row.progressJson);
		if (progress.version === DELIVERY_PROGRESS_VERSION &&
			typeof progress.releaseId === `string` &&
			typeof progress.channelId === `string` &&
			typeof progress.runId === `string` &&
			Number.isFinite(new Date(progress.startedAt).getTime()) &&
			Array.isArray(progress.messages) &&
			progress.messages.every(message => typeof message === `string`) &&
			Array.isArray(progress.sentMessageIds) &&
			Number.isInteger(progress.nextChunkIndex) &&
			progress.nextChunkIndex >= 0 &&
			progress.nextChunkIndex <= progress.messages.length) {
			return progress;
		}
	} catch {
		// A malformed checkpoint is handled as a failed delivery below.
	}
	return null;
}

function createDeliveryProgress(note, channelId) {
	return {
		version: DELIVERY_PROGRESS_VERSION,
		releaseId: note.id,
		channelId,
		runId: crypto.randomUUID(),
		startedAt: new Date().toISOString(),
		messages: formatPatchNotesMessages(note),
		nextChunkIndex: 0,
		sentMessageIds: [],
	};
}

function deliveryNonce(progress, chunkIndex) {
	// Discord caps a nonce at 25 characters. The readable UUID and chunk mapping
	// remain in the checkpoint; this short hash is used only for API deduplication.
	return crypto.createHash(`sha256`)
		.update(`${progress.runId}:${chunkIndex}`)
		.digest(`base64url`)
		.slice(0, 25);
}

async function findRecoveredChunk(channel, progress, chunkIndex) {
	if (typeof channel.messages?.fetch !== `function`) {
		throw new Error(`Cannot inspect channel history before retrying a patch-note chunk.`);
	}
	const nonce = deliveryNonce(progress, chunkIndex);
	const startedAt = new Date(progress.startedAt).getTime();
	const content = progress.messages[chunkIndex];
	const botUserId = channel.client?.user?.id;
	if (!botUserId) {
		throw new Error(`Cannot verify the bot author before reconciling patch-note delivery.`);
	}
	let before;

	// A send can succeed while the database checkpoint fails. Search the bot's
	// messages from this delivery run before asking Discord to send that chunk
	// again. If history cannot be checked completely, stop rather than duplicate.
	for (let page = 0; page < MAX_RECOVERY_HISTORY_PAGES; page += 1) {
		const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
		const messages = [...batch.values()];
		const recovered = messages.find(message =>
			message.author?.id === botUserId && String(message.nonce || ``) === nonce);
		if (recovered) {
			return recovered;
		}
		if (messages.some(message =>
			(message.nonce === null || message.nonce === undefined) && message.content === content &&
			message.createdTimestamp >= startedAt &&
			message.author?.id === botUserId)) {
			throw new Error(`Discord omitted the nonce from a matching patch-note message; delivery needs manual review before retrying.`);
		}
		const oldest = messages.at(-1);
		if (!oldest || batch.size < 100 || oldest.createdTimestamp < startedAt) {
			return null;
		}
		before = oldest.id;
	}

	throw new Error(`Could not verify patch-note delivery history before retrying chunk ${chunkIndex + 1}.`);
}

async function saveDeliveryProgress(guildId, progress) {
	await AnnouncementDeliveryProgress.upsert({
		guildId,
		progressJson: JSON.stringify(progress),
	});
}

async function completeDeliveredRelease(guildId, releaseId, channelId) {
	await sequelize.transaction(async transaction => {
		const [updatedCount] = await Servers.update({
			hachiAnnouncementLastId: releaseId,
			...CLEARED_WARNING_STATE,
		}, { where: { guildId, hachiAnnouncementChannelId: channelId }, transaction });
		if (updatedCount !== 1) {
			throw new Error(`The announcement channel changed during delivery; release progress was left intact.`);
		}
		await AnnouncementDeliveryProgress.destroy({ where: { guildId }, transaction });
	});
}

async function sendLatestPatchNotesToGuildUnlocked(client, guildId, { force = false, patchNoteReleases } = {}) {
	const guild = await fetchGuild(client, guildId);
	const guildName = guild?.name || `Unknown Server`;
	const settings = await getAnnouncementSettings(guildId);
	const availableReleases = patchNoteReleases ?? parsePatchNoteReleases(readPatchNotesDocument());
	const notes = selectPatchNotesForAnnouncement(availableReleases, settings.hachiAnnouncementLastId, { force });
	const latestNote = availableReleases[0] || null;
	const progressRow = await AnnouncementDeliveryProgress.findByPk(guildId);
	const savedProgress = parseDeliveryProgress(progressRow);

	if (!latestNote) {
		return { guildId, guildName, ok: false, sent: 0, skipped: true, message: `No patch notes were found.` };
	}

	if (progressRow && !savedProgress) {
		return { guildId, guildName, ok: false, sent: 0, skipped: true, message: `Patch-note delivery checkpoint is invalid; inspect it before retrying.` };
	}
	const shouldClearProgress = savedProgress &&
		(savedProgress.channelId !== settings.hachiAnnouncementChannelId ||
			savedProgress.releaseId === settings.hachiAnnouncementLastId);
	if (shouldClearProgress) {
		await AnnouncementDeliveryProgress.destroy({ where: { guildId } });
	}
	const progress = shouldClearProgress ? null : savedProgress;
	if (!notes.length && !progress) {
		return { guildId, guildName, ok: true, patchNoteId: latestNote.id, sent: 0, skipped: true, message: `Latest patch notes were already sent.` };
	}

	if (!guild) {
		return { guildId, guildName, ok: false, patchNoteId: latestNote.id, sent: 0, skipped: true, message: `Guild is unavailable.` };
	}

	const channelResult = await fetchAnnouncementChannel(guild, settings.hachiAnnouncementChannelId);

	if (!channelResult.ok) {
		await recordAnnouncementFailure(guild, settings.hachiAnnouncementChannelId, channelResult);

		return { guildId, guildName, ok: false, patchNoteId: latestNote.id, sent: 0, skipped: true, message: channelResult.message };
	}

	const releases = progress ?
		[{ id: progress.releaseId }, ...notes.filter(note => note.id !== progress.releaseId)] :
		notes;
	let sent = 0;
	let releaseCount = 0;
	let latestSentId = settings.hachiAnnouncementLastId;
	try {
		for (const note of releases) {
			const resumed = progress?.releaseId === note.id;
			const releaseProgress = resumed ? progress : createDeliveryProgress(note, channelResult.channel.id);
			if (!resumed) {
				// Persist the run identity before any Discord send so a restart can
				// reconcile a chunk that was accepted but not checkpointed.
				await saveDeliveryProgress(guildId, releaseProgress);
			}
			let needsRecoveryCheck = resumed;
			for (let chunkIndex = releaseProgress.nextChunkIndex; chunkIndex < releaseProgress.messages.length; chunkIndex += 1) {
				const content = releaseProgress.messages[chunkIndex];
				let message = needsRecoveryCheck ?
					await findRecoveredChunk(channelResult.channel, releaseProgress, chunkIndex) :
					null;
				needsRecoveryCheck = false;
				if (!message) {
					message = await channelResult.channel.send({
						content,
						allowedMentions: { parse: [] },
						nonce: deliveryNonce(releaseProgress, chunkIndex),
						enforceNonce: true,
					});
					sent += 1;
				}
				releaseProgress.sentMessageIds[chunkIndex] = message.id;
				releaseProgress.nextChunkIndex = chunkIndex + 1;
				await saveDeliveryProgress(guildId, releaseProgress);
			}
			await completeDeliveredRelease(guildId, note.id, releaseProgress.channelId);
			latestSentId = note.id;
			releaseCount += 1;
		}
	} catch (err) {
		error(`Failed to finish patch-note delivery for guild ${guildId}:`, err);
		return {
			guildId,
			guildName,
			ok: false,
			patchNoteId: latestNote.id,
			sent,
			skipped: false,
			message: `Sent ${sent} patch-note message(s) in this attempt; delivery will resume from its saved checkpoint. ${err.message}`,
		};
	}

	return {
		guildId,
		guildName,
		ok: true,
		patchNoteId: latestSentId,
		patchNoteIds: releases.map(note => note.id),
		releaseCount,
		sent,
		skipped: false,
		message: `Sent ${sent} patch-note message(s) for ${releaseCount} release(s).`,
	};
}

function serializeGuildAnnouncement(guildId, operation) {
	// A channel setting change and a delivery must not interleave in one bot
	// process; the conditional completion update also guards another process.
	const key = String(guildId);
	const previous = announcementDeliveryTails.get(key) || Promise.resolve();
	const result = previous.catch(() => null).then(operation);
	announcementDeliveryTails.set(key, result);
	result.then(
		() => {
			if (announcementDeliveryTails.get(key) === result) {
				announcementDeliveryTails.delete(key);
			}
		},
		() => {
			if (announcementDeliveryTails.get(key) === result) {
				announcementDeliveryTails.delete(key);
			}
		},
	);
	return result;
}

function sendLatestPatchNotesToGuild(client, guildId, options = {}) {
	return serializeGuildAnnouncement(guildId, () => sendLatestPatchNotesToGuildUnlocked(client, guildId, options));
}

async function broadcastLatestPatchNotes(client, { force = false } = {}) {
	const servers = await Servers.findAll({
		attributes: [`guildId`],
		raw: true,
		where: {
			hachiAnnouncementChannelId: { [Op.ne]: null },
			leftAt: null,
		},
	});
	const results = [];
	// Use one document snapshot for the whole broadcast so every server sees the
	// same release, even if the patch-note file changes while messages are sent.
	const patchNoteReleases = servers.length ? parsePatchNoteReleases(readPatchNotesDocument()) : [];

	for (const server of servers) {
		try {
			results.push(await sendLatestPatchNotesToGuild(client, server.guildId, { force, patchNoteReleases }));
		} catch (err) {
			error(`Failed to send Hachi patch notes for guild ${server.guildId}:`, err);
			const guild = client.guilds.cache.get(server.guildId);
			results.push({
				guildId: server.guildId,
				guildName: guild?.name || `Unknown Server`,
				ok: false,
				sent: 0,
				skipped: true,
				message: err.message,
			});
		}
	}

	if (!servers.length) {
		warn(`Patch-note broadcast skipped because no servers have announcement channels configured.`);
	}

	return results;
}

module.exports = {
	broadcastLatestPatchNotes,
	checkAnnouncementChannelAccess,
	clearAnnouncementChannel,
	formatPatchNotesMessages,
	getAnnouncementSettings,
	getLatestPatchNotes,
	getPatchNotesForAnnouncement,
	normalizeAnnouncementId,
	parseLatestPatchNotes,
	parsePatchNoteReleases,
	saveAnnouncementChannel,
	sendAnnouncementWarningToManager,
	sendLatestPatchNotesToGuild,
	selectPatchNotesForAnnouncement,
	splitAnnouncementText,
};
