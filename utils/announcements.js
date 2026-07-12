// Manual Hachi announcement and user-facing patch-note helpers.
//
// CHANGELOG.md is for exhaustive developer history. docs/patch-notes.md is the
// user-facing source this module reads when an owner or admin manually sends the
// latest Hachi update to opted-in servers.
const fs = require(`node:fs`);
const path = require(`node:path`);
const { Op } = require(`sequelize`);
const { PermissionFlagsBits } = require(`discord.js`);
const { Servers } = require(`../database/dbObjects.js`);
const { error, warn } = require(`./writeLog.js`);

const PATCH_NOTES_PATH = path.resolve(__dirname, `..`, `docs`, `patch-notes.md`);
const ANNOUNCEMENT_MESSAGE_LIMIT = 1900;

function normalizeNewlines(text) {
	return String(text || ``).replace(/\r\n?/gu, `\n`).trim();
}

function slugify(value) {
	return String(value || ``)
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, `-`)
		.replace(/^-|-$/gu, ``);
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
	const text = normalizeNewlines(documentText);
	const lines = text.split(`\n`);
	const firstReleaseIndex = lines.findIndex(line => /^##\s+/u.test(line));

	if (firstReleaseIndex === -1) {
		return null;
	}

	const nextReleaseIndex = lines.findIndex((line, index) => index > firstReleaseIndex && /^##\s+/u.test(line));
	const heading = lines[firstReleaseIndex].replace(/^##\s+/u, ``).trim();
	const bodyLines = lines.slice(firstReleaseIndex + 1, nextReleaseIndex === -1 ? undefined : nextReleaseIndex);
	const body = normalizeNewlines(bodyLines.join(`\n`));
	const version = heading.match(/v?\d+\.\d+\.\d+/u)?.[0] || ``;

	return {
		body,
		heading,
		id: version ? (version.startsWith(`v`) ? version : `v${version}`) : slugify(heading),
		version,
	};
}

function getLatestPatchNotes() {
	return parseLatestPatchNotes(readPatchNotesDocument());
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

	const text = `# Hachi ${note.heading}\n\n${note.body}`;
	const chunks = splitAnnouncementText(text);

	if (chunks.length <= 1) {
		return chunks;
	}

	return chunks.map((chunk, index) => `${chunk}\n\n_Part ${index + 1}/${chunks.length}_`);
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
	});
}

async function clearAnnouncementChannel(guildId) {
	return updateAnnouncementSettings(guildId, {
		hachiAnnouncementChannelId: null,
	});
}

async function fetchGuild(client, guildId) {
	return client.guilds.cache.get(guildId) || client.guilds.fetch(guildId).catch(() => null);
}

async function fetchAnnouncementChannel(guild, channelId) {
	if (!channelId) {
		return { ok: false, message: `No announcement channel is configured.` };
	}

	const channel = await guild.channels.fetch(channelId).catch(() => null);

	if (!channel?.send) {
		return { ok: false, message: `The configured announcement channel is unavailable.` };
	}

	const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
	const permissions = me ? channel.permissionsFor(me) : null;

	if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions?.has(PermissionFlagsBits.SendMessages)) {
		return { ok: false, message: `Hachi cannot view or send messages in the configured announcement channel.` };
	}

	return { channel, ok: true };
}

async function sendLatestPatchNotesToGuild(client, guildId, { force = false } = {}) {
	const settings = await getAnnouncementSettings(guildId);
	const note = getLatestPatchNotes();

	if (!note) {
		return { guildId, ok: false, sent: 0, skipped: true, message: `No patch notes were found.` };
	}

	if (!force && settings.hachiAnnouncementLastId === note.id) {
		return { guildId, ok: true, patchNoteId: note.id, sent: 0, skipped: true, message: `Latest patch notes were already sent.` };
	}

	const guild = await fetchGuild(client, guildId);

	if (!guild) {
		return { guildId, ok: false, patchNoteId: note.id, sent: 0, skipped: true, message: `Guild is unavailable.` };
	}

	const channelResult = await fetchAnnouncementChannel(guild, settings.hachiAnnouncementChannelId);

	if (!channelResult.ok) {
		return { guildId, ok: false, patchNoteId: note.id, sent: 0, skipped: true, message: channelResult.message };
	}

	const messages = formatPatchNotesMessages(note);

	for (const content of messages) {
		await channelResult.channel.send({ content });
	}

	await updateAnnouncementSettings(guildId, {
		hachiAnnouncementLastId: note.id,
	});

	return {
		guildId,
		ok: true,
		patchNoteId: note.id,
		sent: messages.length,
		skipped: false,
		message: `Sent ${messages.length} patch-note message(s).`,
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
			results.push({
				guildId: server.guildId,
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
	clearAnnouncementChannel,
	formatPatchNotesMessages,
	getAnnouncementSettings,
	getLatestPatchNotes,
	normalizeAnnouncementId,
	saveAnnouncementChannel,
	sendLatestPatchNotesToGuild,
	splitAnnouncementText,
};
