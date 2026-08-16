// Manual Hachi announcement and user-facing patch-note helpers.
//
// CHANGELOG.md is for exhaustive developer history. docs/patch-notes.md is the
// user-facing source this module reads when an owner or admin manually sends the
// latest Hachi update to opted-in servers.
const fs = require(`node:fs`);
const path = require(`node:path`);
const { Op } = require(`sequelize`);
const { MessageFlags, PermissionFlagsBits } = require(`discord.js`);
const { Servers } = require(`../database/dbObjects.js`);
const { error, warn } = require(`./writeLog.js`);

const PATCH_NOTES_PATH = path.resolve(__dirname, `..`, `docs`, `patch-notes.md`);
const ANNOUNCEMENT_MESSAGE_LIMIT = 1900;
const MANAGER_WARNING_LIMIT = 3;
const MANAGER_WARNING_INTERVAL_MS = 15 * 60 * 1000;
const MANAGER_WARNING_WINDOW_MS = 24 * 60 * 60 * 1000;
const RELEASE_HEADING_PATTERN = /^#\s+(v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/u;

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
	return updateAnnouncementSettings(guildId, {
		hachiAnnouncementChannelId: normalizeAnnouncementId(channelId),
		...CLEARED_WARNING_STATE,
	});
}

async function clearAnnouncementChannel(guildId) {
	return updateAnnouncementSettings(guildId, {
		hachiAnnouncementChannelId: null,
		...CLEARED_WARNING_STATE,
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

async function sendLatestPatchNotesToGuild(client, guildId, { force = false } = {}) {
	const guild = await fetchGuild(client, guildId);
	const guildName = guild?.name || `Unknown Server`;
	const settings = await getAnnouncementSettings(guildId);
	const notes = getPatchNotesForAnnouncement(settings.hachiAnnouncementLastId, { force });
	const latestNote = getLatestPatchNotes();

	if (!latestNote) {
		return { guildId, guildName, ok: false, sent: 0, skipped: true, message: `No patch notes were found.` };
	}

	if (!notes.length) {
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

	const messages = notes.flatMap(note => formatPatchNotesMessages(note));
	const latestSentNote = notes.at(-1);

	for (const content of messages) {
		await channelResult.channel.send({ content });
	}

	await updateAnnouncementSettings(guildId, {
		hachiAnnouncementLastId: latestSentNote.id,
		...CLEARED_WARNING_STATE,
	});

	return {
		guildId,
		guildName,
		ok: true,
		patchNoteId: latestSentNote.id,
		patchNoteIds: notes.map(note => note.id),
		releaseCount: notes.length,
		sent: messages.length,
		skipped: false,
		message: `Sent ${messages.length} patch-note message(s) for ${notes.length} release(s).`,
	};
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

	for (const server of servers) {
		try {
			results.push(await sendLatestPatchNotesToGuild(client, server.guildId, { force }));
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
