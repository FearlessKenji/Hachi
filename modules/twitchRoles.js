// Twitch role-sync feature.
//
// This module owns Twitch device-code authorization, broadcaster/member token
// validation, VIP/moderator role mappings, and synchronization from Twitch state
// to Discord roles.
const { PermissionFlagsBits } = require(`discord.js`);
const { URL, URLSearchParams } = require(`node:url`);
const {
	Servers,
	TwitchRoleConfigs,
	TwitchRoleLinks,
} = require(`../database/dbObjects.js`);
const { roleIsAssignable } = require(`../utils/reactionRoles.js`);
const { warn, error } = require(`../utils/writeLog.js`);

const TWITCH_AUTH_BASE = `https://id.twitch.tv/oauth2`;
const TWITCH_HELIX_BASE = `https://api.twitch.tv/helix`;
const DEVICE_GRANT_TYPE = `urn:ietf:params:oauth:grant-type:device_code`;
const BROADCASTER_SCOPES = [`channel:read:vips`, `moderation:read`];
const MEMBER_SCOPES = (process.env.twitchMemberScopes || ``)
	.split(/\s+/u)
	.map(scope => scope.trim())
	.filter(Boolean);
const MAX_INTERACTION_POLL_MS = 14 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

function requireTwitchClientId() {
	if (!process.env.twitchClientId) {
		throw new Error(`twitchClientId is required.`);
	}

	return process.env.twitchClientId;
}

function scopeText(scopes) {
	return (scopes || []).join(` `);
}

function normalizeScopes(scopes) {
	if (Array.isArray(scopes)) {
		return scopes;
	}

	if (!scopes) {
		return [];
	}

	return String(scopes).split(/\s+/u).filter(Boolean);
}

function hasRequiredScopes(grantedScopes, requiredScopes) {
	const granted = new Set(normalizeScopes(grantedScopes));

	return requiredScopes.every(scope => granted.has(scope));
}

function tokenExpiry(expiresIn) {
	return new Date(Date.now() + Math.max(Number(expiresIn) || 0, 0) * 1000);
}

function safeJson(value) {
	return JSON.stringify(value || []);
}

function parseJsonArray(value) {
	if (!value) {
		return [];
	}

	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

async function readJson(res) {
	const text = await res.text();

	if (!text) {
		return {};
	}

	try {
		return JSON.parse(text);
	} catch {
		return { message: text };
	}
}

async function postForm(url, params) {
	const res = await fetch(url, {
		method: `POST`,
		headers: {
			'Content-Type': `application/x-www-form-urlencoded`,
		},
		body: params,
	});
	const data = await readJson(res);

	return { data, res };
}

async function startDeviceAuthorization(scopes) {
	const params = new URLSearchParams();
	params.set(`client_id`, requireTwitchClientId());
	params.set(`scopes`, scopeText(scopes));

	const { data, res } = await postForm(`${TWITCH_AUTH_BASE}/device`, params);

	if (!res.ok) {
		throw new Error(data.message || `Twitch device authorization failed with ${res.status}.`);
	}

	return data;
}

function classifyDeviceTokenError(data) {
	const message = String(data.message || data.error || ``).toLowerCase();

	if (message.includes(`authorization_pending`)) {
		return `pending`;
	}

	if (message.includes(`slow_down`)) {
		return `slowDown`;
	}

	if (message.includes(`access_denied`)) {
		return `denied`;
	}

	if (message.includes(`expired`)) {
		return `expired`;
	}

	if (message.includes(`invalid device code`)) {
		return `expired`;
	}

	return null;
}

async function exchangeDeviceCode(deviceCode, scopes) {
	const params = new URLSearchParams();
	params.set(`client_id`, requireTwitchClientId());
	params.set(`device_code`, deviceCode);
	params.set(`grant_type`, DEVICE_GRANT_TYPE);
	params.set(`scopes`, scopeText(scopes));

	const { data, res } = await postForm(`${TWITCH_AUTH_BASE}/token`, params);

	if (res.ok) {
		return { token: data };
	}

	return {
		errorType: classifyDeviceTokenError(data),
		message: data.message || data.error || `Twitch token exchange failed with ${res.status}.`,
	};
}

function delay(ms) {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

async function waitForDeviceAuthorization(device, scopes, options = {}) {
	const startedAt = Date.now();
	const expiresAt = startedAt + Math.min(
		Math.max(Number(device.expires_in) || 0, 1) * 1000,
		options.maxMs || MAX_INTERACTION_POLL_MS,
	);
	let intervalMs = Math.max(Number(device.interval) || 5, 5) * 1000;

	while (Date.now() + intervalMs < expiresAt) {
		await delay(intervalMs);

		const result = await exchangeDeviceCode(device.device_code, scopes);

		if (result.token) {
			return result.token;
		}

		if (result.errorType === `pending`) {
			continue;
		}

		if (result.errorType === `slowDown`) {
			intervalMs += 5000;
			continue;
		}

		if (result.errorType === `denied`) {
			throw new Error(`Twitch authorization was denied.`);
		}

		if (result.errorType === `expired`) {
			throw new Error(`The Twitch activation code expired. Run the command again.`);
		}

		throw new Error(result.message);
	}

	throw new Error(`The Twitch activation code timed out. Run the command again.`);
}

async function validateToken(accessToken) {
	const res = await fetch(`${TWITCH_AUTH_BASE}/validate`, {
		headers: {
			Authorization: `OAuth ${accessToken}`,
		},
	});
	const data = await readJson(res);

	if (!res.ok) {
		throw new Error(data.message || `Twitch token validation failed with ${res.status}.`);
	}

	return data;
}

async function refreshAccessToken(refreshToken) {
	const params = new URLSearchParams();
	params.set(`client_id`, requireTwitchClientId());
	params.set(`grant_type`, `refresh_token`);
	params.set(`refresh_token`, refreshToken);

	if (process.env.twitchSecret) {
		params.set(`client_secret`, process.env.twitchSecret);
	}

	const { data, res } = await postForm(`${TWITCH_AUTH_BASE}/token`, params);

	if (!res.ok) {
		throw new Error(data.message || `Twitch token refresh failed with ${res.status}.`);
	}

	return data;
}

async function revokeToken(token) {
	if (!token) {
		return false;
	}

	const params = new URLSearchParams();
	params.set(`client_id`, requireTwitchClientId());
	params.set(`token`, token);

	const { res } = await postForm(`${TWITCH_AUTH_BASE}/revoke`, params);
	return res.ok;
}

async function saveBroadcasterAuthorization({ guildId, requestedBy, token, validation }) {
	if (!validation.user_id) {
		throw new Error(`Twitch did not return a broadcaster user ID.`);
	}

	if (!hasRequiredScopes(validation.scopes, BROADCASTER_SCOPES)) {
		throw new Error(`Twitch did not grant the required VIP and Moderator scopes.`);
	}

	await Servers.upsert({ guildId });

	const fields = {
		guildId,
		broadcasterTwitchUserId: validation.user_id,
		broadcasterLogin: validation.login,
		broadcasterDisplayName: validation.login,
		accessToken: token.access_token,
		refreshToken: token.refresh_token,
		tokenExpiresAt: tokenExpiry(token.expires_in),
		scopes: safeJson(token.scope || validation.scopes),
		connectedBy: requestedBy,
		connectedAt: new Date(),
	};

	await TwitchRoleConfigs.upsert(fields);

	return TwitchRoleConfigs.findByPk(guildId);
}

async function saveMemberLink({ guildId, discordUserId, validation }) {
	if (!validation.user_id || !validation.login) {
		throw new Error(`Twitch did not return a user ID for this authorization.`);
	}

	await Servers.upsert({ guildId });

	const fields = {
		guildId,
		discordUserId,
		twitchUserId: validation.user_id,
		twitchLogin: validation.login,
		twitchDisplayName: validation.login,
		verifiedAt: new Date(),
	};

	const existing = await TwitchRoleLinks.findOne({
		where: { guildId, discordUserId },
	});

	if (existing) {
		await existing.update(fields);
		return existing;
	}

	return TwitchRoleLinks.create(fields);
}

async function ensureBroadcasterAccess(config, options = {}) {
	if (!config?.refreshToken) {
		throw new Error(`This server has no Twitch broadcaster authorization.`);
	}

	const expiresAt = config.tokenExpiresAt ? new Date(config.tokenExpiresAt).getTime() : 0;

	if (!options.force && config.accessToken && expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
		return config.accessToken;
	}

	const token = await refreshAccessToken(config.refreshToken);
	const validation = await validateToken(token.access_token);

	if (validation.user_id !== config.broadcasterTwitchUserId) {
		throw new Error(`Refreshed Twitch token belongs to a different broadcaster.`);
	}

	await config.update({
		accessToken: token.access_token,
		refreshToken: token.refresh_token || config.refreshToken,
		tokenExpiresAt: tokenExpiry(token.expires_in),
		scopes: safeJson(token.scope || validation.scopes),
	});

	return config.accessToken;
}

async function helixRequest(config, endpoint, options = {}) {
	const url = endpoint instanceof URL ?
		endpoint :
		new URL(`${TWITCH_HELIX_BASE}${endpoint}`);
	const body = options.body ? JSON.stringify(options.body) : undefined;

	for (let attempt = 0; attempt < 2; attempt += 1) {
		const accessToken = await ensureBroadcasterAccess(config, { force: attempt > 0 });
		const res = await fetch(url, {
			method: options.method || `GET`,
			headers: {
				'Authorization': `Bearer ${accessToken}`,
				'Client-ID': requireTwitchClientId(),
				...(body ? { 'Content-Type': `application/json` } : {}),
			},
			body,
		});
		const data = await readJson(res);

		if (res.status === 401 && attempt === 0) {
			continue;
		}

		if (options.acceptStatuses?.includes(res.status)) {
			return data;
		}

		if (!res.ok) {
			throw new Error(data.message || `Twitch API returned ${res.status}.`);
		}

		return data;
	}

	throw new Error(`Twitch API authorization failed.`);
}

async function fetchAllPages(config, endpoint, params = {}) {
	const results = [];
	let cursor = null;

	do {
		const url = new URL(`${TWITCH_HELIX_BASE}${endpoint}`);

		for (const [key, value] of Object.entries(params)) {
			if (value !== null && value !== undefined) {
				url.searchParams.set(key, value);
			}
		}

		url.searchParams.set(`first`, `100`);

		if (cursor) {
			url.searchParams.set(`after`, cursor);
		}

		const data = await helixRequest(config, url);
		results.push(...(data.data || []));
		cursor = data.pagination?.cursor || null;
	} while (cursor);

	return results;
}

async function fetchTwitchRoleSets(config) {
	const broadcasterId = config.broadcasterTwitchUserId;
	const [vipRows, moderatorRows] = await Promise.all([
		fetchAllPages(config, `/channels/vips`, { broadcaster_id: broadcasterId }),
		fetchAllPages(config, `/moderation/moderators`, { broadcaster_id: broadcasterId }),
	]);

	return {
		moderatorIds: new Set(moderatorRows.map(row => row.user_id)),
		vipIds: new Set(vipRows.map(row => row.user_id)),
	};
}

async function fetchGuildForRoleSync(client, guildId) {
	const guild = await client.guilds.fetch(guildId).catch(() => null);

	if (!guild) {
		throw new Error(`Discord server is unavailable.`);
	}

	await guild.roles.fetch().catch(err => warn(`Failed to refresh roles for ${guild.id}: ${err.message}`));
	await guild.members.fetchMe().catch(err => warn(`Failed to refresh bot member for ${guild.id}: ${err.message}`));

	return guild;
}

function emptySyncResult() {
	return {
		added: 0,
		removed: 0,
		unchanged: 0,
		skipped: 0,
		missingMembers: 0,
		errors: [],
	};
}

function mergeSyncResult(target, source) {
	for (const key of [`added`, `removed`, `unchanged`, `skipped`, `missingMembers`]) {
		target[key] += source[key] || 0;
	}

	target.errors.push(...(source.errors || []));
	return target;
}

async function setMemberRole({ guild, member, roleId, shouldHave, reason }) {
	const result = emptySyncResult();

	if (!roleId) {
		result.skipped += 1;
		return result;
	}

	const role = guild.roles.cache.get(roleId);

	if (!roleIsAssignable(guild, role)) {
		result.skipped += 1;
		result.errors.push(`Role ${roleId} is not assignable by Hachi.`);
		return result;
	}

	const hasRole = member.roles.cache.has(roleId);

	if (shouldHave && !hasRole) {
		await member.roles.add(roleId, reason);
		result.added += 1;
		return result;
	}

	if (!shouldHave && hasRole) {
		await member.roles.remove(roleId, reason);
		result.removed += 1;
		return result;
	}

	result.unchanged += 1;
	return result;
}

async function syncLinkRoles({ guild, config, link, roleSets }) {
	const result = emptySyncResult();
	const member = await guild.members.fetch(link.discordUserId).catch(() => null);

	if (!member) {
		result.missingMembers += 1;
		return result;
	}

	const twitchUserId = link.twitchUserId;
	const roleChecks = [
		{
			roleId: config.vipRoleId,
			shouldHave: roleSets.vipIds.has(twitchUserId),
			reason: `Twitch VIP role sync`,
		},
		{
			roleId: config.moderatorRoleId,
			shouldHave: roleSets.moderatorIds.has(twitchUserId),
			reason: `Twitch Moderator role sync`,
		},
	];

	for (const roleCheck of roleChecks) {
		try {
			mergeSyncResult(result, await setMemberRole({
				guild,
				member,
				...roleCheck,
			}));
		} catch (err) {
			result.errors.push(err.message);
		}
	}

	return result;
}

function configHasRoleMapping(config) {
	return Boolean(config?.vipRoleId || config?.moderatorRoleId);
}

async function syncGuildTwitchRoles(client, guildId) {
	const result = {
		...emptySyncResult(),
		guildId,
		linkedUsers: 0,
		reason: null,
	};
	const config = await TwitchRoleConfigs.findByPk(guildId);

	if (!config?.broadcasterTwitchUserId) {
		result.reason = `No Twitch broadcaster is connected.`;
		return result;
	}

	if (!configHasRoleMapping(config)) {
		result.reason = `No Discord VIP or Moderator role is configured.`;
		return result;
	}

	const guild = await fetchGuildForRoleSync(client, guildId);
	const roleSets = await fetchTwitchRoleSets(config);
	const links = await TwitchRoleLinks.findAll({
		where: { guildId },
		order: [[`discordUserId`, `ASC`]],
	});

	result.linkedUsers = links.length;

	for (const link of links) {
		mergeSyncResult(result, await syncLinkRoles({
			guild,
			config,
			link,
			roleSets,
		}));
	}

	await config.update({ lastSyncAt: new Date() });
	return result;
}

async function syncMemberTwitchRoles(client, guildId, discordUserId) {
	const result = {
		...emptySyncResult(),
		guildId,
		linkedUsers: 0,
		reason: null,
	};
	const [config, link] = await Promise.all([
		TwitchRoleConfigs.findByPk(guildId),
		TwitchRoleLinks.findOne({ where: { guildId, discordUserId } }),
	]);

	if (!link) {
		result.reason = `This Discord user has not verified Twitch.`;
		return result;
	}

	result.linkedUsers = 1;

	if (!config?.broadcasterTwitchUserId) {
		result.reason = `No Twitch broadcaster is connected.`;
		return result;
	}

	if (!configHasRoleMapping(config)) {
		result.reason = `No Discord VIP or Moderator role is configured.`;
		return result;
	}

	const guild = await fetchGuildForRoleSync(client, guildId);
	const roleSets = await fetchTwitchRoleSets(config);

	mergeSyncResult(result, await syncLinkRoles({
		guild,
		config,
		link,
		roleSets,
	}));

	return result;
}

async function syncAllTwitchRoles(client) {
	const configs = await TwitchRoleConfigs.findAll({
		order: [[`guildId`, `ASC`]],
	});
	const results = [];

	for (const config of configs) {
		if (!config.broadcasterTwitchUserId || !configHasRoleMapping(config)) {
			continue;
		}

		try {
			results.push(await syncGuildTwitchRoles(client, config.guildId));
		} catch (err) {
			error(`Failed to sync Twitch roles for guild ${config.guildId}:`, err);
			results.push({
				...emptySyncResult(),
				guildId: config.guildId,
				linkedUsers: 0,
				reason: err.message,
			});
		}
	}

	return results;
}

async function applyTwitchRoleEvent(client, event) {
	const configs = await TwitchRoleConfigs.findAll({
		where: { broadcasterTwitchUserId: event.broadcasterTwitchUserId },
	});
	const summary = {
		...emptySyncResult(),
		guilds: 0,
		linkedUsers: 0,
	};

	for (const config of configs) {
		const roleId = event.roleType === `vip` ? config.vipRoleId : config.moderatorRoleId;

		if (!roleId) {
			summary.skipped += 1;
			continue;
		}

		const link = await TwitchRoleLinks.findOne({
			where: {
				guildId: config.guildId,
				twitchUserId: event.twitchUserId,
			},
		});

		if (!link) {
			summary.skipped += 1;
			continue;
		}

		summary.guilds += 1;
		summary.linkedUsers += 1;

		try {
			const guild = await fetchGuildForRoleSync(client, config.guildId);
			const member = await guild.members.fetch(link.discordUserId).catch(() => null);

			if (!member) {
				summary.missingMembers += 1;
				continue;
			}

			mergeSyncResult(summary, await setMemberRole({
				guild,
				member,
				roleId,
				shouldHave: event.shouldHave,
				reason: `Twitch ${event.roleType === `vip` ? `VIP` : `Moderator`} EventSub sync`,
			}));
		} catch (err) {
			summary.errors.push(err.message);
		}
	}

	return summary;
}

function canManageTwitchRoleSync(interaction, permission = PermissionFlagsBits.ManageGuild) {
	if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
		return true;
	}

	return interaction.memberPermissions?.has(permission) || false;
}

function formatSyncResult(result) {
	const parts = [
		`added ${result.added}`,
		`removed ${result.removed}`,
		`unchanged ${result.unchanged}`,
	];

	if (result.skipped) {
		parts.push(`skipped ${result.skipped}`);
	}

	if (result.missingMembers) {
		parts.push(`missing members ${result.missingMembers}`);
	}

	return parts.join(`, `);
}

module.exports = {
	BROADCASTER_SCOPES,
	MEMBER_SCOPES,
	applyTwitchRoleEvent,
	canManageTwitchRoleSync,
	ensureBroadcasterAccess,
	fetchTwitchRoleSets,
	formatSyncResult,
	hasRequiredScopes,
	helixRequest,
	parseJsonArray,
	revokeToken,
	saveBroadcasterAuthorization,
	saveMemberLink,
	startDeviceAuthorization,
	syncAllTwitchRoles,
	syncGuildTwitchRoles,
	syncMemberTwitchRoles,
	validateToken,
	waitForDeviceAuthorization,
};
