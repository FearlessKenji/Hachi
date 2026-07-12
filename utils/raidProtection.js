// Raid-protection engine.
//
// The /raid command configures policy, but this utility performs the runtime
// detection and response work: join-spike tracking, quarantine, alerts, evidence,
// and incident persistence.
const {
	AttachmentBuilder,
	ChannelType,
	EmbedBuilder,
	PermissionFlagsBits,
	PermissionsBitField,
} = require(`discord.js`);
const crypto = require(`node:crypto`);
const { Buffer } = require(`node:buffer`);
const fs = require(`node:fs`);
const path = require(`node:path`);
const {
	RaidConfigs,
	RaidIncidentFiles,
	RaidIncidentMessages,
	RaidIncidents,
	RaidIncidentUsers,
	Servers,
} = require(`../database/dbObjects.js`);
const { info, warn } = require(`./writeLog.js`);

const RAID_COLOR = 0xed4245;
const RAID_DRILL_COLOR = 0x5865f2;
const RAID_OK_COLOR = 0x57f287;
const RAID_WARN_COLOR = 0xffb020;
const DEFAULT_MESSAGE_SPAM_COUNT = 5;
const DEFAULT_MESSAGE_SPAM_SECONDS = 5;
const DEFAULT_JOIN_SPIKE_COUNT = 5;
const DEFAULT_JOIN_SPIKE_SECONDS = 5;
const DEFAULT_TIMEOUT_MINUTES = 60;
const CONFIG_CACHE_MS = 10 * 1000;
const TRIGGER_COOLDOWN_MS = 30 * 1000;
const MAX_BUFFER_SECONDS = 30;
const MAX_ARCHIVE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_FIELD_VALUE_LENGTH = 1024;
const MAX_EVIDENCE_MESSAGES = 25;
const MAX_EVIDENCE_FILES_PER_MESSAGE = 10;
const EVIDENCE_CONTENT_CHUNK_LENGTH = 1000;
const EVIDENCE_CONTENT_CHUNK_COUNT = 3;
const evidenceRoot = path.join(__dirname, `../data/evidence`);
const messageBuffers = new Map();
const joinBuffers = new Map();
const triggerCooldowns = new Map();
const configCache = new Map();
const RAID_CONFIG_FIELDS = [
	`enabled`,
	`quarantineRoleId`,
	`alertChannelId`,
	`reportChannelId`,
	`moderatorRoleId`,
	`messageSpamCount`,
	`messageSpamSeconds`,
	`joinSpikeCount`,
	`joinSpikeSeconds`,
	`actionQuarantine`,
	`actionTimeout`,
	`actionDelete`,
	`timeoutMinutes`,
];

const MODERATED_CHANNEL_TYPES = new Set([
	ChannelType.GuildCategory,
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
	ChannelType.GuildForum,
	ChannelType.GuildMedia,
	ChannelType.GuildVoice,
	ChannelType.GuildStageVoice,
]);
const ALL_PERMISSION_NAMES = Object.keys(PermissionFlagsBits);
const QUARANTINE_OVERWRITE_DENIES = Object.fromEntries(
	ALL_PERMISSION_NAMES.map(permission => [permission, false]),
);
const ELEVATED_ROLE_PERMISSIONS = [
	{ flag: PermissionFlagsBits.Administrator, label: `Administrator` },
	{ flag: PermissionFlagsBits.ManageGuild, label: `Manage Server` },
	{ flag: PermissionFlagsBits.ManageRoles, label: `Manage Roles` },
	{ flag: PermissionFlagsBits.ManageChannels, label: `Manage Channels` },
	{ flag: PermissionFlagsBits.ManageMessages, label: `Manage Messages` },
	{ flag: PermissionFlagsBits.ModerateMembers, label: `Timeout Members` },
	{ flag: PermissionFlagsBits.KickMembers, label: `Kick Members` },
	{ flag: PermissionFlagsBits.BanMembers, label: `Ban Members` },
];
const QUARANTINE_RISK_PERMISSIONS = [
	...ELEVATED_ROLE_PERMISSIONS,
	{ flag: PermissionFlagsBits.ManageWebhooks, label: `Manage Webhooks` },
	{ flag: PermissionFlagsBits.MentionEveryone, label: `Mention Everyone` },
];
const QUARANTINE_CONFLICT_ALLOW_PERMISSIONS = [
	[`SendMessages`, `Send Messages`],
	[`SendMessagesInThreads`, `Send Messages in Threads`],
	[`SendTTSMessages`, `Send TTS Messages`],
	[`SendVoiceMessages`, `Send Voice Messages`],
	[`SendPolls`, `Send Polls`],
	[`CreatePublicThreads`, `Create Public Threads`],
	[`CreatePrivateThreads`, `Create Private Threads`],
	[`AddReactions`, `Add Reactions`],
	[`UseApplicationCommands`, `Use Application Commands`],
	[`UseExternalApps`, `Use External Apps`],
	[`ManageMessages`, `Manage Messages`],
	[`ManageThreads`, `Manage Threads`],
	[`ManageWebhooks`, `Manage Webhooks`],
	[`ManageChannels`, `Manage Channels`],
	[`ManageRoles`, `Manage Roles`],
	[`PinMessages`, `Pin Messages`],
	[`MentionEveryone`, `Mention Everyone`],
	[`AttachFiles`, `Attach Files`],
	[`Connect`, `Connect`],
	[`Speak`, `Speak`],
	[`Stream`, `Video`],
	[`RequestToSpeak`, `Request to Speak`],
	[`PrioritySpeaker`, `Priority Speaker`],
	[`UseVAD`, `Use Voice Activity`],
	[`UseSoundboard`, `Use Soundboard`],
	[`UseExternalSounds`, `Use External Sounds`],
	[`MuteMembers`, `Mute Members`],
	[`DeafenMembers`, `Deafen Members`],
	[`MoveMembers`, `Move Members`],
].map(([name, label]) => ({
	flag: PermissionFlagsBits[name],
	label,
})).filter(permission => permission.flag !== undefined);

function getDefaultRaidConfig(guildId) {
	return {
		guildId,
		enabled: false,
		quarantineRoleId: null,
		alertChannelId: null,
		reportChannelId: null,
		moderatorRoleId: null,
		messageSpamCount: DEFAULT_MESSAGE_SPAM_COUNT,
		messageSpamSeconds: DEFAULT_MESSAGE_SPAM_SECONDS,
		joinSpikeCount: DEFAULT_JOIN_SPIKE_COUNT,
		joinSpikeSeconds: DEFAULT_JOIN_SPIKE_SECONDS,
		actionQuarantine: true,
		actionTimeout: false,
		actionDelete: true,
		timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
	};
}

function normalizeBoolean(value) {
	return value === true || value === 1 || value === `1`;
}

function normalizeConfig(config, guildId = null) {
	const defaults = getDefaultRaidConfig(config?.guildId || guildId);
	const merged = {
		...defaults,
		...(config || {}),
	};

	return {
		...merged,
		enabled: normalizeBoolean(merged.enabled),
		actionQuarantine: normalizeBoolean(merged.actionQuarantine),
		actionTimeout: normalizeBoolean(merged.actionTimeout),
		actionDelete: normalizeBoolean(merged.actionDelete),
		messageSpamCount: Number(merged.messageSpamCount) || DEFAULT_MESSAGE_SPAM_COUNT,
		messageSpamSeconds: Number(merged.messageSpamSeconds) || DEFAULT_MESSAGE_SPAM_SECONDS,
		joinSpikeCount: Number(merged.joinSpikeCount) || DEFAULT_JOIN_SPIKE_COUNT,
		joinSpikeSeconds: Number(merged.joinSpikeSeconds) || DEFAULT_JOIN_SPIKE_SECONDS,
		timeoutMinutes: Number(merged.timeoutMinutes) || DEFAULT_TIMEOUT_MINUTES,
	};
}

function clearRaidConfigCache(guildId) {
	configCache.delete(guildId);
}

async function getRaidConfig(guildId, { create = false, cached = false } = {}) {
	if (cached) {
		const cachedEntry = configCache.get(guildId);

		if (cachedEntry && Date.now() - cachedEntry.cachedAt < CONFIG_CACHE_MS) {
			return cachedEntry.config;
		}
	}

	let config = await RaidConfigs.findOne({
		raw: true,
		where: { guildId },
	});

	if (!config && create) {
		await Servers.upsert({ guildId });
		config = (await RaidConfigs.create(getDefaultRaidConfig(guildId))).get({ plain: true });
	}

	const normalized = normalizeConfig(config, guildId);

	if (cached) {
		configCache.set(guildId, {
			cachedAt: Date.now(),
			config: normalized,
		});
	}

	return normalized;
}

async function saveRaidConfig(guildId, values) {
	const cleanedValues = {};
	const existingConfig = await getRaidConfig(guildId);

	for (const field of RAID_CONFIG_FIELDS) {
		if (Object.prototype.hasOwnProperty.call(values, field)) {
			cleanedValues[field] = values[field];
		}
	}

	await Servers.upsert({ guildId });
	await RaidConfigs.upsert({
		...existingConfig,
		...cleanedValues,
		guildId,
	});
	clearRaidConfigCache(guildId);
	return getRaidConfig(guildId);
}

function formatRole(id) {
	return id ? `<@&${id}>` : `Not set`;
}

function formatChannel(id) {
	return id ? `<#${id}>` : `Not set`;
}

function formatYesNo(value) {
	return value ? `Yes` : `No`;
}

function formatTriggerType(triggerType) {
	const labels = {
		join_spike: `Join Spike`,
		message_spam: `Message Spam`,
		manual_quarantine: `Manual Quarantine`,
	};

	return labels[triggerType] || triggerType;
}

function randomInt(min, max) {
	const normalizedMin = Math.ceil(Number(min) || 0);
	const normalizedMax = Math.max(normalizedMin, Math.floor(Number(max) || normalizedMin));

	return Math.floor(Math.random() * (normalizedMax - normalizedMin + 1)) + normalizedMin;
}

function safeJson(value) {
	return JSON.stringify(value || null);
}

function parseJson(value, fallback = null) {
	if (!value) {
		return fallback;
	}

	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function trimForDiscord(value, limit = MAX_FIELD_VALUE_LENGTH) {
	if (!value) {
		return value;
	}

	return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function hashText(value) {
	if (!value) {
		return null;
	}

	return crypto
		.createHash(`sha256`)
		.update(value)
		.digest(`hex`);
}

function sanitizeFilename(filename) {
	return String(filename || `attachment`)
		.split(``)
		.map(character => {
			const code = character.charCodeAt(0);

			return code < 32 || `<>:"/\\|?*`.includes(character) ? `_` : character;
		})
		.join(``)
		.slice(0, 120);
}

function getEvidenceDirectory(guildId, incidentId) {
	return path.join(evidenceRoot, guildId, String(incidentId));
}

function ensureEvidenceDirectory(guildId, incidentId) {
	const directory = path.join(getEvidenceDirectory(guildId, incidentId), `files`);
	fs.mkdirSync(directory, { recursive: true });
	return directory;
}

function extractLinks(content) {
	if (!content) {
		return [];
	}

	return [...content.matchAll(/https?:\/\/[^\s<>()]+/giu)]
		.map(match => match[0])
		.slice(0, 20);
}

function summarizeEmbed(embed) {
	return {
		title: embed.title || null,
		description: embed.description ? trimForDiscord(embed.description, 500) : null,
		url: embed.url || null,
		type: embed.type || null,
		author: embed.author?.name || null,
		provider: embed.provider?.name || null,
		imageUrl: embed.image?.url || null,
		thumbnailUrl: embed.thumbnail?.url || null,
		videoUrl: embed.video?.url || null,
		fields: embed.fields?.slice(0, 5).map(field => ({
			name: field.name,
			value: trimForDiscord(field.value, 300),
		})) || [],
	};
}

function summarizeAttachment(attachment) {
	return {
		id: attachment.id,
		filename: attachment.name,
		contentType: attachment.contentType || null,
		size: attachment.size || 0,
		url: attachment.url,
		proxyUrl: attachment.proxyURL || null,
		height: attachment.height || null,
		width: attachment.width || null,
	};
}

function getTriggeringUserId(message, metadata = null) {
	return metadata?.user?.id || message.author?.id || null;
}

function getTriggeringUser(message, metadata = null) {
	return metadata?.user || message.author || null;
}

function getDisplayName(message, userId, user = null) {
	const member = userId ? message.guild.members.cache.get(userId) : null;

	return member?.displayName ||
		user?.globalName ||
		user?.displayName ||
		user?.username ||
		userId ||
		null;
}

function buildMessageFingerprint(entry) {
	const content = entry.content?.trim().toLowerCase() || ``;
	const attachments = entry.attachments.map(attachment => `${attachment.filename}:${attachment.size}`).join(`|`);
	const embeds = entry.embeds.map(embed => `${embed.title || ``}:${embed.url || embed.imageUrl || embed.videoUrl || ``}`).join(`|`);

	return [content, attachments, embeds].filter(Boolean).join(`\n`);
}

function buildMessageEvidence(message, metadata = null) {
	if (!message.guild || !message.channel || message.system) {
		return null;
	}

	if (message.author?.bot && !metadata) {
		return null;
	}

	const userId = getTriggeringUserId(message, metadata);
	const user = getTriggeringUser(message, metadata);

	if (!userId) {
		return null;
	}

	const entry = {
		message,
		guildId: message.guild.id,
		messageId: message.id,
		channelId: message.channel.id,
		userId,
		displayName: getDisplayName(message, userId, user),
		username: user?.tag || user?.username || null,
		content: message.content || null,
		attachments: [...message.attachments.values()].map(summarizeAttachment),
		embeds: message.embeds.map(summarizeEmbed),
		links: extractLinks(message.content),
		createdAt: message.createdAt || new Date(),
		metadata: metadata ?
			{
				applicationId: message.applicationId || message.author?.id || null,
				commandName: message.interaction?.commandName || null,
				interactionId: metadata.id || null,
			} :
			null,
	};

	entry.contentHash = hashText(buildMessageFingerprint(entry));
	return entry;
}

function pruneBuffer(entries, windowMs) {
	const cutoff = Date.now() - windowMs;
	return entries.filter(entry => entry.createdAt.getTime() >= cutoff);
}

function getBufferKey(guildId, userId) {
	return `${guildId}:${userId}`;
}

function isOnCooldown(key) {
	const lastTriggeredAt = triggerCooldowns.get(key) || 0;
	return Date.now() - lastTriggeredAt < TRIGGER_COOLDOWN_MS;
}

function setCooldown(key) {
	triggerCooldowns.set(key, Date.now());
}

async function fetchChannel(guild, channelId) {
	if (!channelId) {
		return null;
	}

	return guild.channels.fetch(channelId).catch(() => null);
}

function canSendToChannel(guild, channel) {
	if (!channel?.send) {
		return false;
	}

	const permissions = channel.permissionsFor(guild.members.me);

	return permissions?.has([
		PermissionFlagsBits.ViewChannel,
		PermissionFlagsBits.SendMessages,
		PermissionFlagsBits.EmbedLinks,
	]) || false;
}

function canAttachFilesToChannel(guild, channel) {
	const permissions = channel?.permissionsFor(guild.members.me);

	return canSendToChannel(guild, channel) &&
		permissions?.has(PermissionFlagsBits.AttachFiles);
}

function canEditPermissionOverwrites(guild, channel) {
	const permissions = channel.permissionsFor(guild.members.me);

	return permissions?.has(PermissionFlagsBits.ManageRoles) || false;
}

async function sendConfiguredAlert(guild, config, payload, { dryRun = false } = {}) {
	const channel = await fetchChannel(guild, config.alertChannelId);

	if (!channel || !canSendToChannel(guild, channel)) {
		return false;
	}

	if (dryRun) {
		return true;
	}

	await channel.send(payload);
	return true;
}

function getRaidConfigurationIssue(config) {
	if (!config.alertChannelId) {
		return `Mod alert channel is not configured.`;
	}

	if (!config.reportChannelId) {
		return `Raid report channel is not configured.`;
	}

	if (!config.moderatorRoleId) {
		return `Moderator alert role is not configured.`;
	}

	if (config.actionQuarantine && !config.quarantineRoleId) {
		return `Quarantine action is enabled, but no quarantine role is configured.`;
	}

	return null;
}

function formatRaidEnabledState(config) {
	if (config.enabled) {
		return `Yes`;
	}

	return getRaidConfigurationIssue(config) ?
		`No. Improper configuration.` :
		`No. Ready to enable.`;
}

function buildRaidStatusEmbed(config) {
	const configurationIssue = getRaidConfigurationIssue(config);

	return new EmbedBuilder()
		.setColor(config.enabled ? RAID_OK_COLOR : RAID_WARN_COLOR)
		.setTitle(`Raid Protection`)
		.addFields(
			{ name: `Enabled`, value: formatRaidEnabledState(config), inline: true },
			{ name: `Quarantine Role`, value: formatRole(config.quarantineRoleId), inline: true },
			{ name: `Moderator Role`, value: formatRole(config.moderatorRoleId), inline: true },
			{ name: `Alert Channel`, value: formatChannel(config.alertChannelId), inline: true },
			{ name: `Report Channel`, value: formatChannel(config.reportChannelId), inline: true },
			{ name: `Message Spam`, value: `${config.messageSpamCount} messages / ${config.messageSpamSeconds}s`, inline: true },
			{ name: `Join Spike`, value: `${config.joinSpikeCount} joins / ${config.joinSpikeSeconds}s`, inline: true },
			{ name: `Actions`, value: buildActionSummary(config), inline: false },
			...(configurationIssue ? [{ name: `Configuration Issue`, value: configurationIssue, inline: false }] : []),
		);
}

function buildActionSummary(config) {
	const actions = [];

	if (config.actionQuarantine) {
		actions.push(`Quarantine role`);
	}

	if (config.actionTimeout) {
		actions.push(`Timeout ${config.timeoutMinutes}m`);
	}

	if (config.actionDelete) {
		actions.push(`Delete spam messages`);
	}

	return actions.length ? actions.join(`, `) : `None`;
}

function inlineCode(value) {
	return `\`${String(value || `Unknown`).replace(/`/gu, `'`)}\``;
}

function roleLabel(role) {
	return inlineCode(role?.name || role?.id || `Unknown Role`);
}

function sortRolesHighestFirst(roles) {
	return roles.sort((left, right) => right.comparePositionTo(left));
}

function formatRoleList(roles, limit = 5) {
	if (!roles.length) {
		return `None`;
	}

	const shown = roles.slice(0, limit).map(roleLabel).join(`, `);
	const remaining = roles.length - limit;

	return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

function formatPermissionLabelList(permissionDefinitions) {
	return permissionDefinitions.map(permission => permission.label).join(`, `);
}

function roleHasAnyPermission(role, permissionDefinitions) {
	return permissionDefinitions.some(permission => role.permissions.has(permission.flag));
}

function getRolePermissionLabels(role, permissionDefinitions) {
	return permissionDefinitions
		.filter(permission => role.permissions.has(permission.flag))
		.map(permission => permission.label);
}

function getHierarchyLimitedRoles(guild, botMember) {
	if (!botMember?.roles?.highest) {
		return [];
	}

	return sortRolesHighestFirst([...guild.roles.cache.values()].filter(role =>
		role.id !== guild.id &&
		!role.managed &&
		role.comparePositionTo(botMember.roles.highest) >= 0,
	));
}

function getAdministratorRoles(guild) {
	return sortRolesHighestFirst([...guild.roles.cache.values()].filter(role =>
		role.id !== guild.id &&
		!role.managed &&
		role.permissions.has(PermissionFlagsBits.Administrator),
	));
}

function getManagedApplicationRoles(guild, botMember) {
	return sortRolesHighestFirst([...guild.roles.cache.values()].filter(role =>
		role.id !== guild.id &&
		role.managed &&
		role.tags?.botId &&
		!botMember?.roles.cache.has(role.id),
	));
}

function getHierarchyLimitedManagedApplicationRoles(guild, botMember) {
	if (!botMember?.roles?.highest) {
		return [];
	}

	return getManagedApplicationRoles(guild, botMember)
		.filter(role => role.comparePositionTo(botMember.roles.highest) >= 0);
}

function getElevatedManagedApplicationRoles(guild, botMember) {
	return getManagedApplicationRoles(guild, botMember)
		.filter(role => roleHasAnyPermission(role, QUARANTINE_RISK_PERMISSIONS));
}

async function getManagedApplicationMembers(guild, roles) {
	const members = [];

	for (const role of roles) {
		const botId = role.tags?.botId;

		if (!botId) {
			continue;
		}

		const member = guild.members.cache.get(botId) ||
			await guild.members.fetch(botId).catch(() => null);

		if (member) {
			members.push(member);
		}
	}

	return members;
}

function getSharedApplicationRoles(guild, botMember, members) {
	if (!members.length || !botMember?.roles?.highest) {
		return [];
	}

	const [firstMember, ...remainingMembers] = members;

	return sortRolesHighestFirst([...firstMember.roles.cache.values()].filter(role =>
		role.id !== guild.id &&
		!role.managed &&
		role.comparePositionTo(botMember.roles.highest) < 0 &&
		remainingMembers.every(member => member.roles.cache.has(role.id)),
	));
}

async function buildElevatedApplicationRoleDetail(guild, botMember, roles) {
	const reviewText = `${formatRoleList(roles, 6)}.`;
	const members = await getManagedApplicationMembers(guild, roles);
	const sharedRoles = getSharedApplicationRoles(guild, botMember, members);

	if (sharedRoles.length) {
		return `${reviewText} Shared application role detected: ${formatRoleList(sharedRoles, 6)}.`;
	}

	if (roles.length > 1) {
		return `${reviewText} Use a shared role under Hachi when practical.`;
	}

	return `${reviewText} Keep application roles under Hachi when practical.`;
}

function incrementCount(counts, key) {
	counts.set(key, (counts.get(key) || 0) + 1);
}

function formatCountedRoles(guild, counts, limit = 5) {
	const roles = [...counts.entries()]
		.map(([roleId, count]) => ({
			count,
			role: guild.roles.cache.get(roleId),
		}))
		.filter(entry => entry.role)
		.sort((left, right) => {
			if (right.count !== left.count) {
				return right.count - left.count;
			}

			return right.role.comparePositionTo(left.role);
		});

	if (!roles.length) {
		return `None`;
	}

	const shown = roles.slice(0, limit)
		.map(entry => `${roleLabel(entry.role)} (${entry.count})`)
		.join(`, `);
	const remaining = roles.length - limit;

	return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

function formatCountedLabels(counts, limit = 5) {
	const labels = [...counts.entries()]
		.sort((left, right) => {
			if (right[1] !== left[1]) {
				return right[1] - left[1];
			}

			return left[0].localeCompare(right[0]);
		});

	if (!labels.length) {
		return `None`;
	}

	const shown = labels.slice(0, limit)
		.map(([label, count]) => `${label} (${count})`)
		.join(`, `);
	const remaining = labels.length - limit;

	return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

function channelAuditLabel(channel) {
	const name = channel.name || channel.id;

	if (channel.type === ChannelType.GuildCategory) {
		return `category ${name}`;
	}

	return `#${name}`;
}

function formatSampledLocations(locations, limit = 6) {
	if (!locations.length) {
		return `None`;
	}

	const shown = locations.slice(0, limit).join(`, `);
	const remaining = locations.length - limit;

	return remaining > 0 ? `${shown}, +${remaining} more` : shown;
}

function addSampledLocation(locations, channel) {
	const label = channelAuditLabel(channel);

	if (!locations.includes(label)) {
		locations.push(label);
	}
}

function buildOverwritePermissionWarningDetail(locations) {
	return `Needed: Manage Permissions in Discord's channel UI, which maps to Hachi's Manage Roles permission. Sample: ${formatSampledLocations(locations)}.`;
}

function buildConflictingAllowDetail(permissionText, roleText, locations, hasMemberSpecificAllows) {
	const parts = [];

	if (permissionText !== `None`) {
		parts.push(`Explicit allow permissions: ${permissionText}.`);
	}

	if (roleText !== `None`) {
		parts.push(`Role/member sources: ${roleText}${hasMemberSpecificAllows ? `, member-specific overwrites` : ``}.`);
	} else if (hasMemberSpecificAllows) {
		parts.push(`Role/member sources: member-specific overwrites.`);
	}

	parts.push(`Sample locations: ${formatSampledLocations(locations)}.`);

	return trimForDiscord(parts.join(` `));
}

function createChannelTypeStats() {
	return {
		categories: 0,
		channels: 0,
	};
}

function incrementChannelTypeStats(stats, channel) {
	if (channel.type === ChannelType.GuildCategory) {
		stats.categories += 1;
	} else {
		stats.channels += 1;
	}
}

function formatChannelTypeStats(stats) {
	const parts = [];

	if (stats.categories) {
		parts.push(`${stats.categories} categor${stats.categories === 1 ? `y` : `ies`}`);
	}

	if (stats.channels) {
		parts.push(`${stats.channels} channel${stats.channels === 1 ? `` : `s`}`);
	}

	return parts.length ? parts.join(` and `) : `0 channels/categories`;
}

function hasChannelTypeStats(stats) {
	return stats.categories > 0 || stats.channels > 0;
}

function channelTypeStatsVerb(stats, singular, plural) {
	return stats.categories + stats.channels === 1 ? singular : plural;
}

function addAuditIssue(collection, message, detail = null) {
	collection.push({ message, detail });
}

function denyBitsHaveAllPermissions(denyBits) {
	return ALL_PERMISSION_NAMES.every(permission => denyBits.has(PermissionFlagsBits[permission]));
}

function channelNeedsQuarantineOverwrite(channel, quarantineRoleId) {
	if (!MODERATED_CHANNEL_TYPES.has(channel.type)) {
		return false;
	}

	const overwrite = channel.permissionOverwrites.cache.get(quarantineRoleId);
	const denyBits = overwrite?.deny || new PermissionsBitField();

	return !denyBitsHaveAllPermissions(denyBits);
}

function getOverwriteConflictAllowLabels(overwrite) {
	return QUARANTINE_CONFLICT_ALLOW_PERMISSIONS
		.filter(permission => overwrite.allow.has(permission.flag))
		.map(permission => permission.label);
}

function getConflictingAllowDetails(channel, quarantineRoleId) {
	const details = {
		hasMemberSpecificAllows: false,
		permissionLabels: [],
		roleIds: [],
	};

	for (const overwrite of channel.permissionOverwrites.cache.values()) {
		if (overwrite.id === quarantineRoleId) {
			continue;
		}

		if (overwrite.id === channel.guild.id) {
			continue;
		}

		const permissionLabels = getOverwriteConflictAllowLabels(overwrite);

		if (!permissionLabels.length) {
			continue;
		}

		details.permissionLabels.push(...permissionLabels);

		if (channel.guild.roles.cache.has(overwrite.id)) {
			details.roleIds.push(overwrite.id);
		} else {
			details.hasMemberSpecificAllows = true;
		}
	}

	return details;
}

async function auditRaidConfiguration(guild, config = null) {
	const raidConfig = config || await getRaidConfig(guild.id);
	const issues = {
		errors: [],
		hierarchy: [],
		warnings: [],
		ok: [],
		stats: {
			conflictingAllows: createChannelTypeStats(),
			conflictingAllowPermissions: new Map(),
			conflictingAllowRoles: new Map(),
			conflictingAllowHasMemberSpecific: false,
			conflictingAllowLocations: [],
			missingQuarantineOverwrites: createChannelTypeStats(),
			missingOverwriteEditPermission: createChannelTypeStats(),
			missingOverwriteEditPermissionLocations: [],
			unsyncedChildren: 0,
		},
	};

	await guild.members.fetchMe().catch(() => null);
	await guild.roles.fetch().catch(() => null);
	await guild.channels.fetch().catch(() => null);

	const botMember = guild.members.me;
	const quarantineRole = raidConfig.quarantineRoleId ? guild.roles.cache.get(raidConfig.quarantineRoleId) : null;
	const moderatorRole = raidConfig.moderatorRoleId ? guild.roles.cache.get(raidConfig.moderatorRoleId) : null;
	const alertChannel = await fetchChannel(guild, raidConfig.alertChannelId);
	const reportChannel = await fetchChannel(guild, raidConfig.reportChannelId);
	const administratorRoles = getAdministratorRoles(guild);
	const elevatedManagedApplicationRoles = getElevatedManagedApplicationRoles(guild, botMember);
	const hierarchyLimitedApplicationRoles = getHierarchyLimitedManagedApplicationRoles(guild, botMember);
	const hierarchyLimitedRoles = getHierarchyLimitedRoles(guild, botMember);

	const configurationIssue = getRaidConfigurationIssue(raidConfig);

	if (!raidConfig.enabled && configurationIssue) {
		addAuditIssue(issues.warnings, `Raid protection is disabled. Improper configuration.`, configurationIssue);
	} else if (!raidConfig.enabled) {
		addAuditIssue(issues.warnings, `Raid protection is disabled. Ready to enable.`);
	} else {
		addAuditIssue(issues.ok, `Raid protection is enabled.`);
	}

	addAuditIssue(
		issues.hierarchy,
		`Elevated roles are roles with higher-risk permissions.`,
		formatPermissionLabelList(ELEVATED_ROLE_PERMISSIONS),
	);

	if (!botMember) {
		addAuditIssue(issues.errors, `Hachi could not resolve its own server member record.`);
	} else if (!hierarchyLimitedRoles.length) {
		addAuditIssue(
			issues.hierarchy,
			`Hachi is above all roles.`,
			`Max enforcement; keep staff above Hachi if bot-compromise containment matters more.`,
		);
	} else {
		addAuditIssue(
			issues.hierarchy,
			`Actions may fail due to role hierarchy or elevated permissions:`,
			`${formatRoleList(hierarchyLimitedRoles, 6)}. This is fine for trusted staff.`,
		);
	}

	if (hierarchyLimitedApplicationRoles.length) {
		addAuditIssue(
			issues.hierarchy,
			`Application role(s) may limit Hachi by hierarchy.`,
			`Actions may fail against application members whose highest role is ${formatRoleList(hierarchyLimitedApplicationRoles, 6)}.`,
		);
	}

	if (elevatedManagedApplicationRoles.length) {
		addAuditIssue(
			issues.hierarchy,
			`Elevated application role(s):`,
			await buildElevatedApplicationRoleDetail(guild, botMember, elevatedManagedApplicationRoles),
		);
	}

	if (administratorRoles.length) {
		addAuditIssue(
			issues.hierarchy,
			`Administrator roles bypass channel quarantine:`,
			formatRoleList(administratorRoles, 6),
		);
	}

	if (!alertChannel) {
		addAuditIssue(issues.errors, `Alert channel is not configured or cannot be fetched.`);
	} else if (!canSendToChannel(guild, alertChannel)) {
		addAuditIssue(issues.errors, `Hachi cannot send embeds in the alert channel.`, `Channel: #${alertChannel.name || alertChannel.id}`);
	} else {
		addAuditIssue(issues.ok, `Alert channel is reachable.`);
	}

	if (!reportChannel) {
		addAuditIssue(issues.errors, `Report channel is not configured or cannot be fetched.`);
	} else if (!canSendToChannel(guild, reportChannel)) {
		addAuditIssue(issues.errors, `Hachi cannot send embeds in the report channel.`, `Channel: #${reportChannel.name || reportChannel.id}`);
	} else {
		addAuditIssue(issues.ok, `Report channel is reachable.`);
	}

	if (raidConfig.actionQuarantine) {
		if (!quarantineRole) {
			addAuditIssue(issues.errors, `Quarantine action is enabled, but the quarantine role is missing.`);
		} else if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
			addAuditIssue(issues.errors, `Hachi needs Manage Roles to assign the quarantine role.`);
		} else if (quarantineRole.comparePositionTo(botMember.roles.highest) >= 0) {
			addAuditIssue(issues.errors, `The quarantine role must be below Hachi's highest role.`);
		} else {
			addAuditIssue(issues.ok, `Quarantine role is assignable by Hachi.`);
		}
	}

	if (quarantineRole) {
		const quarantineRiskPermissions = getRolePermissionLabels(quarantineRole, QUARANTINE_RISK_PERMISSIONS);

		if (quarantineRole.permissions.has(PermissionFlagsBits.Administrator)) {
			addAuditIssue(issues.errors, `The quarantine role has Administrator and will bypass channel quarantine.`);
		} else if (quarantineRiskPermissions.length) {
			addAuditIssue(
				issues.hierarchy,
				`Quarantine role has elevated permission(s):`,
				quarantineRiskPermissions.join(`, `),
			);
		} else {
			addAuditIssue(issues.hierarchy, `Quarantine role has no obvious elevated permissions.`);
		}
	}

	if (moderatorRole && botMember?.roles?.highest) {
		if (moderatorRole.comparePositionTo(botMember.roles.highest) >= 0) {
			addAuditIssue(
				issues.hierarchy,
				`Moderator alert role may limit Hachi by hierarchy.`,
				`Good containment; hierarchy-limited actions may fail against members whose highest role is ${roleLabel(moderatorRole)}.`,
			);
		} else {
			addAuditIssue(
				issues.hierarchy,
				`Moderator alert role is below Hachi.`,
				`Hachi can act on those members; move staff above Hachi if containment matters more.`,
			);
		}
	}

	if (raidConfig.actionTimeout) {
		if (!botMember?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
			addAuditIssue(issues.errors, `Timeout action is enabled, but Hachi lacks Timeout Members.`);
		} else {
			addAuditIssue(issues.ok, `Timeout permission is available.`);
		}
	}

	if (raidConfig.actionDelete) {
		if (!botMember?.permissions.has(PermissionFlagsBits.ManageMessages)) {
			addAuditIssue(issues.errors, `Delete spam action is enabled, but Hachi lacks Manage Messages.`);
		} else {
			addAuditIssue(issues.ok, `Manage Messages permission is available.`);
		}
	}

	if (quarantineRole) {
		for (const channel of guild.channels.cache.values()) {
			if (!MODERATED_CHANNEL_TYPES.has(channel.type)) {
				continue;
			}

			if (channel.type !== ChannelType.GuildCategory && channel.parentId && channel.permissionsLocked === false) {
				issues.stats.unsyncedChildren += 1;
			}

			if (channelNeedsQuarantineOverwrite(channel, quarantineRole.id)) {
				incrementChannelTypeStats(issues.stats.missingQuarantineOverwrites, channel);
			}

			if (!canEditPermissionOverwrites(guild, channel)) {
				incrementChannelTypeStats(issues.stats.missingOverwriteEditPermission, channel);
				addSampledLocation(issues.stats.missingOverwriteEditPermissionLocations, channel);
			}

			const conflictingAllowDetails = getConflictingAllowDetails(channel, quarantineRole.id);

			if (conflictingAllowDetails.roleIds.length || conflictingAllowDetails.hasMemberSpecificAllows) {
				incrementChannelTypeStats(issues.stats.conflictingAllows, channel);
				addSampledLocation(issues.stats.conflictingAllowLocations, channel);
				issues.stats.conflictingAllowHasMemberSpecific = issues.stats.conflictingAllowHasMemberSpecific ||
					conflictingAllowDetails.hasMemberSpecificAllows;

				for (const roleId of conflictingAllowDetails.roleIds) {
					incrementCount(issues.stats.conflictingAllowRoles, roleId);
				}

				for (const permissionLabel of conflictingAllowDetails.permissionLabels) {
					incrementCount(issues.stats.conflictingAllowPermissions, permissionLabel);
				}
			}
		}

		const missingOverwriteText = formatChannelTypeStats(issues.stats.missingQuarantineOverwrites);
		const conflictingAllowsText = formatChannelTypeStats(issues.stats.conflictingAllows);
		const missingOverwriteEditPermissionText = formatChannelTypeStats(issues.stats.missingOverwriteEditPermission);

		if (hasChannelTypeStats(issues.stats.missingQuarantineOverwrites)) {
			addAuditIssue(
				issues.warnings,
				`${missingOverwriteText} ${channelTypeStatsVerb(issues.stats.missingQuarantineOverwrites, `does`, `do`)} not directly deny all permissions for the quarantine role.`,
			);
		} else {
			addAuditIssue(issues.ok, `Quarantine role has full direct denies on checked channels/categories.`);
		}

		if (hasChannelTypeStats(issues.stats.missingOverwriteEditPermission)) {
			addAuditIssue(
				issues.warnings,
				`Hachi cannot edit permission overwrites in ${missingOverwriteEditPermissionText}.`,
				buildOverwritePermissionWarningDetail(issues.stats.missingOverwriteEditPermissionLocations),
			);
		} else {
			addAuditIssue(issues.ok, `Overwrite sync permission is available on checked channels/categories.`);
		}

		if (hasChannelTypeStats(issues.stats.conflictingAllows)) {
			const permissionText = formatCountedLabels(issues.stats.conflictingAllowPermissions);
			const conflictingRoleText = formatCountedRoles(guild, issues.stats.conflictingAllowRoles);
			const conflictVerb = channelTypeStatsVerb(issues.stats.conflictingAllows, `has`, `have`);

			addAuditIssue(
				issues.warnings,
				`${conflictingAllowsText} ${conflictVerb} risky explicit channel/category allows that may weaken full-deny quarantine in some server layouts.`,
				buildConflictingAllowDetail(
					permissionText,
					conflictingRoleText,
					issues.stats.conflictingAllowLocations,
					issues.stats.conflictingAllowHasMemberSpecific,
				),
			);

			addAuditIssue(
				issues.hierarchy,
				`Roles or members with explicit channel/category allows may override quarantine denies.`,
				conflictingRoleText === `None` ? `Review member-specific overwrites on affected channels.` : `Review: ${conflictingRoleText}.`,
			);
		}

		if (issues.stats.unsyncedChildren) {
			addAuditIssue(issues.warnings, `${issues.stats.unsyncedChildren} child channel(s) are unsynced from their category and should be reviewed manually.`);
		}
	}

	return issues;
}

async function syncQuarantineOverwrites(guild, config = null) {
	const raidConfig = config || await getRaidConfig(guild.id);

	if (!raidConfig.quarantineRoleId) {
		return {
			applied: 0,
			errors: [`No quarantine role is configured.`],
			skipped: 0,
		};
	}

	await guild.members.fetchMe().catch(() => null);
	await guild.channels.fetch().catch(() => null);

	const role = guild.roles.cache.get(raidConfig.quarantineRoleId);

	if (!role) {
		return {
			applied: 0,
			errors: [`Configured quarantine role could not be found.`],
			skipped: 0,
		};
	}

	let applied = 0;
	let skipped = 0;
	const errors = [];

	for (const channel of guild.channels.cache.values()) {
		if (!MODERATED_CHANNEL_TYPES.has(channel.type)) {
			continue;
		}

		if (!canEditPermissionOverwrites(guild, channel)) {
			skipped += 1;
			errors.push(`${channelAuditLabel(channel)}: missing Manage Permissions (Manage Roles) for overwrites.`);
			continue;
		}

		try {
			await channel.permissionOverwrites.edit(role.id, QUARANTINE_OVERWRITE_DENIES, {
				reason: `Raid protection quarantine overwrite sync`,
			});
			applied += 1;
		} catch (err) {
			skipped += 1;
			errors.push(`#${channel.name || channel.id}: ${err.message}`);
		}
	}

	return {
		applied,
		errors,
		skipped,
	};
}

function formatAuditLines(items) {
	if (!items.length) {
		return `None`;
	}

	return trimForDiscord(items.map(item => item.detail ? `- ${item.message} ${item.detail}` : `- ${item.message}`).join(`\n`));
}

function buildRaidAuditEmbed(config, audit, { drill = false } = {}) {
	const color = audit.errors.length ? RAID_COLOR : audit.warnings.length ? RAID_WARN_COLOR : RAID_OK_COLOR;

	return new EmbedBuilder()
		.setColor(drill ? RAID_DRILL_COLOR : color)
		.setTitle(drill ? `Raid Drill` : `Raid Audit`)
		.setDescription(drill ? `No administrative actions were performed and no roles were pinged.` : `Current raid-protection readiness.`)
		.addFields(
			{ name: `Configuration`, value: `Enabled: ${formatYesNo(config.enabled)}\nActions: ${buildActionSummary(config)}`, inline: false },
			{ name: `Role Hierarchy`, value: formatAuditLines(audit.hierarchy || []), inline: false },
			{ name: `Errors`, value: formatAuditLines(audit.errors), inline: false },
			{ name: `Warnings`, value: formatAuditLines(audit.warnings), inline: false },
			{ name: `Ready`, value: formatAuditLines(audit.ok), inline: false },
		);
}

function getUserLabel(user) {
	const tag = user.username || user.displayName || user.userId;

	return `${tag} (${user.userId})`;
}

async function recordIncidentUser(incident, guild, userId, actions = {}, joinedAt = null) {
	const member = await guild.members.fetch(userId).catch(() => null);
	const user = member?.user || await guild.client.users.fetch(userId).catch(() => null);

	return RaidIncidentUsers.create({
		incidentId: incident.id,
		guildId: guild.id,
		userId,
		displayName: member?.displayName || user?.globalName || user?.displayName || user?.username || null,
		username: user?.tag || user?.username || null,
		joinedAt,
		actionTaken: safeJson(actions.taken || []),
		actionError: safeJson(actions.errors || []),
		releasedAt: null,
	});
}

async function applyConfiguredUserActions(guild, config, userId, reason) {
	const taken = [];
	const errors = [];
	const member = await guild.members.fetch(userId).catch(() => null);

	if (!member) {
		return {
			taken,
			errors: [`Member could not be fetched.`],
		};
	}

	if (config.actionQuarantine && config.quarantineRoleId) {
		try {
			await member.roles.add(config.quarantineRoleId, reason);
			taken.push(`quarantine_role`);
		} catch (err) {
			errors.push(`Quarantine failed: ${err.message}`);
		}
	}

	if (config.actionTimeout) {
		try {
			await member.timeout(config.timeoutMinutes * 60 * 1000, reason);
			taken.push(`timeout`);
		} catch (err) {
			errors.push(`Timeout failed: ${err.message}`);
		}
	}

	return { taken, errors };
}

async function deleteIncidentMessage(entry) {
	if (!entry.message?.deletable) {
		return null;
	}

	await entry.message.delete().catch(err => {
		throw new Error(`Delete failed for ${entry.messageId}: ${err.message}`);
	});

	return new Date();
}

async function archiveAttachment(incident, entry, attachment) {
	if (!attachment.url || attachment.size > MAX_ARCHIVE_ATTACHMENT_BYTES) {
		return RaidIncidentFiles.create({
			incidentId: incident.id,
			guildId: incident.guildId,
			messageId: entry.messageId,
			attachmentId: attachment.id,
			filename: attachment.filename || `attachment`,
			contentType: attachment.contentType,
			size: attachment.size || 0,
			hash: null,
			localPath: null,
			originalUrl: attachment.url,
			seenCount: 1,
		});
	}

	const response = await fetch(attachment.url);

	if (!response.ok) {
		throw new Error(`HTTP ${response.status} while downloading attachment ${attachment.id}`);
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	const hash = crypto.createHash(`sha256`).update(buffer).digest(`hex`);
	const existing = await RaidIncidentFiles.findOne({
		where: {
			incidentId: incident.id,
			hash,
		},
	});

	if (existing) {
		await existing.increment(`seenCount`);
		return existing;
	}

	const directory = ensureEvidenceDirectory(incident.guildId, incident.id);
	const filename = `${hash.slice(0, 12)}-${sanitizeFilename(attachment.filename)}`;
	const localPath = path.join(directory, filename);

	await fs.promises.writeFile(localPath, buffer);

	return RaidIncidentFiles.create({
		incidentId: incident.id,
		guildId: incident.guildId,
		messageId: entry.messageId,
		attachmentId: attachment.id,
		filename: attachment.filename || filename,
		contentType: attachment.contentType,
		size: attachment.size || buffer.length,
		hash,
		localPath,
		originalUrl: attachment.url,
		seenCount: 1,
	});
}

async function archiveMessageAttachments(incident, entry) {
	const archived = [];

	for (const attachment of entry.attachments) {
		try {
			archived.push(await archiveAttachment(incident, entry, attachment));
		} catch (err) {
			warn(`Failed to archive raid attachment ${attachment.id}: ${err.message}`, {
				meta: {
					guildId: incident.guildId,
					incidentId: incident.id,
					messageId: entry.messageId,
				},
				module: `raid`,
			});
		}
	}

	return archived;
}

async function recordIncidentMessage(incident, entry, deletedAt = null) {
	const [record] = await RaidIncidentMessages.findOrCreate({
		defaults: {
			incidentId: incident.id,
			guildId: incident.guildId,
			messageId: entry.messageId,
			channelId: entry.channelId,
			userId: entry.userId,
			content: entry.content,
			contentHash: entry.contentHash,
			attachmentsJson: safeJson(entry.attachments),
			embedsJson: safeJson(entry.embeds),
			linksJson: safeJson(entry.links),
			deletedAt,
			createdAt: entry.createdAt,
		},
		where: {
			incidentId: incident.id,
			messageId: entry.messageId,
		},
	});

	return record;
}

function summarizeMessageEntries(entries) {
	const uniqueContent = new Set(entries.map(entry => entry.contentHash).filter(Boolean));
	const attachmentCount = entries.reduce((total, entry) => total + entry.attachments.length, 0);
	const embedCount = entries.reduce((total, entry) => total + entry.embeds.length, 0);

	return {
		messageCount: entries.length,
		uniqueContentCount: uniqueContent.size,
		attachmentCount,
		embedCount,
	};
}

function buildRaidAlertEmbed(incident, config, summary, { drill = false } = {}) {
	const embed = new EmbedBuilder()
		.setColor(drill ? RAID_DRILL_COLOR : RAID_COLOR)
		.setTitle(drill ? `Raid Drill Alert` : `Raid Protection Triggered`)
		.setDescription(drill ? `This is a dry run. No administrative actions were performed.` : `Hachi detected suspicious activity and opened an incident.`)
		.addFields(
			{ name: `Incident`, value: `#${incident.id}`, inline: true },
			{ name: `Trigger`, value: formatTriggerType(incident.triggerType), inline: true },
			{ name: `Actions`, value: buildActionSummary(config), inline: true },
		)
		.setTimestamp(new Date());

	if (summary.userCount !== undefined) {
		embed.addFields({ name: `Users`, value: String(summary.userCount), inline: true });
	}

	if (summary.messageCount !== undefined) {
		embed.addFields(
			{ name: `Messages`, value: String(summary.messageCount), inline: true },
			{ name: `Unique Content`, value: String(summary.uniqueContentCount || 0), inline: true },
			{ name: `Attachments`, value: String(summary.attachmentCount || 0), inline: true },
		);
	}

	return embed;
}

async function updateIncidentSummary(incident, summary) {
	incident.summary = safeJson(summary);
	await incident.save();
	return summary;
}

async function createMessageSpamIncident(guild, config, userId, entries) {
	const uniqueEntries = [...new Map(entries.map(entry => [entry.messageId, entry])).values()];
	const initialSummary = {
		triggerUserId: userId,
		...summarizeMessageEntries(uniqueEntries),
		actionFailures: 0,
		archivedFiles: 0,
		deletedMessages: 0,
	};
	const incident = await RaidIncidents.create({
		guildId: guild.id,
		triggerType: `message_spam`,
		status: `open`,
		startedAt: new Date(),
		endedAt: null,
		summary: safeJson(initialSummary),
	});
	const actions = await applyConfiguredUserActions(guild, config, userId, `Raid protection incident #${incident.id}`);

	await recordIncidentUser(incident, guild, userId, actions);

	let archivedFiles = 0;
	let deletedMessages = 0;

	for (const entry of uniqueEntries) {
		const archived = await archiveMessageAttachments(incident, entry);
		archivedFiles += archived.length;

		let deletedAt = null;

		if (config.actionDelete) {
			try {
				deletedAt = await deleteIncidentMessage(entry);

				if (deletedAt) {
					deletedMessages += 1;
				}
			} catch (err) {
				warn(err.message, { module: `raid` });
			}
		}

		await recordIncidentMessage(incident, entry, deletedAt);
	}

	const summary = await updateIncidentSummary(incident, {
		...initialSummary,
		actionFailures: actions.errors.length,
		archivedFiles,
		deletedMessages,
	});
	const content = config.moderatorRoleId ? `<@&${config.moderatorRoleId}>` : null;

	await sendConfiguredAlert(guild, config, {
		allowedMentions: config.moderatorRoleId ? { roles: [config.moderatorRoleId] } : { parse: [] },
		content,
		embeds: [buildRaidAlertEmbed(incident, config, summary)],
	}).catch(err => warn(`Failed to send raid alert for incident ${incident.id}: ${err.message}`));

	info(`Raid incident #${incident.id} created for message spam.`, {
		meta: {
			guildId: guild.id,
			incidentId: incident.id,
			summary,
			userId,
		},
		module: `raid`,
	});

	return incident;
}

async function createJoinSpikeIncident(guild, config, entries) {
	const uniqueEntries = [...new Map(entries.map(entry => [entry.userId, entry])).values()];
	const initialSummary = {
		userCount: uniqueEntries.length,
		actionFailures: 0,
	};
	const incident = await RaidIncidents.create({
		guildId: guild.id,
		triggerType: `join_spike`,
		status: `open`,
		startedAt: new Date(),
		endedAt: null,
		summary: safeJson(initialSummary),
	});
	let actionFailures = 0;

	for (const entry of uniqueEntries) {
		const actions = await applyConfiguredUserActions(guild, config, entry.userId, `Raid protection incident #${incident.id}`);
		actionFailures += actions.errors.length;
		await recordIncidentUser(incident, guild, entry.userId, actions, entry.joinedAt);
	}

	const summary = await updateIncidentSummary(incident, {
		...initialSummary,
		actionFailures,
	});
	const content = config.moderatorRoleId ? `<@&${config.moderatorRoleId}>` : null;

	await sendConfiguredAlert(guild, config, {
		allowedMentions: config.moderatorRoleId ? { roles: [config.moderatorRoleId] } : { parse: [] },
		content,
		embeds: [buildRaidAlertEmbed(incident, config, summary)],
	}).catch(err => warn(`Failed to send raid alert for incident ${incident.id}: ${err.message}`));

	info(`Raid incident #${incident.id} created for join spike.`, {
		meta: {
			guildId: guild.id,
			incidentId: incident.id,
			summary,
		},
		module: `raid`,
	});

	return incident;
}

async function observeMessageForRaid(message, metadata = null) {
	if (!message.guild) {
		return;
	}

	const config = await getRaidConfig(message.guild.id, { cached: true });

	if (!config.enabled) {
		return;
	}

	const evidence = buildMessageEvidence(message, metadata);

	if (!evidence) {
		return;
	}

	const key = getBufferKey(evidence.guildId, evidence.userId);
	const windowMs = Math.min(config.messageSpamSeconds, MAX_BUFFER_SECONDS) * 1000;
	const buffered = pruneBuffer(messageBuffers.get(key) || [], windowMs);

	buffered.push(evidence);
	messageBuffers.set(key, buffered);

	if (buffered.length < config.messageSpamCount || isOnCooldown(key)) {
		return;
	}

	setCooldown(key);
	await createMessageSpamIncident(message.guild, config, evidence.userId, buffered);
	messageBuffers.set(key, []);
}

async function observeGuildMemberAdd(member) {
	const config = await getRaidConfig(member.guild.id, { cached: true });

	if (!config.enabled) {
		return;
	}

	const key = member.guild.id;
	const windowMs = Math.min(config.joinSpikeSeconds, MAX_BUFFER_SECONDS) * 1000;
	const buffered = pruneBuffer(joinBuffers.get(key) || [], windowMs);

	buffered.push({
		createdAt: new Date(),
		userId: member.id,
		joinedAt: member.joinedAt || new Date(),
	});
	joinBuffers.set(key, buffered);

	const cooldownKey = `${key}:join_spike`;

	if (buffered.length < config.joinSpikeCount || isOnCooldown(cooldownKey)) {
		return;
	}

	setCooldown(cooldownKey);
	await createJoinSpikeIncident(member.guild, config, buffered);
	joinBuffers.set(key, []);
}

async function listRecentIncidents(guildId, limit = 10) {
	return RaidIncidents.findAll({
		limit,
		order: [[`startedAt`, `DESC`]],
		raw: true,
		where: { guildId },
	});
}

async function getIncidentDetails(guildId, incidentId) {
	const incident = await RaidIncidents.findOne({
		raw: true,
		where: {
			guildId,
			id: incidentId,
		},
	});

	if (!incident) {
		return null;
	}

	const [users, messages, files] = await Promise.all([
		RaidIncidentUsers.findAll({
			order: [[`id`, `ASC`]],
			raw: true,
			where: { incidentId: incident.id },
		}),
		RaidIncidentMessages.findAll({
			order: [[`createdAt`, `ASC`]],
			raw: true,
			where: { incidentId: incident.id },
		}),
		RaidIncidentFiles.findAll({
			order: [[`id`, `ASC`]],
			raw: true,
			where: { incidentId: incident.id },
		}),
	]);

	return {
		incident,
		users,
		messages,
		files,
		summary: parseJson(incident.summary, {}),
	};
}

function buildIncidentEmbed(details) {
	const { incident, users, messages, files, summary } = details;
	const userLines = users.slice(0, 10).map(user => `- ${getUserLabel(user)}`);

	return new EmbedBuilder()
		.setColor(RAID_COLOR)
		.setTitle(`Raid Incident #${incident.id}`)
		.setDescription(formatTriggerType(incident.triggerType))
		.addFields(
			{ name: `Status`, value: incident.status, inline: true },
			{ name: `Started`, value: `<t:${Math.floor(new Date(incident.startedAt).getTime() / 1000)}:F>`, inline: true },
			{ name: `Users`, value: String(users.length || summary.userCount || 0), inline: true },
			{ name: `Messages`, value: String(messages.length || summary.messageCount || 0), inline: true },
			{ name: `Files`, value: String(files.length || summary.archivedFiles || 0), inline: true },
			{ name: `Deleted`, value: String(summary.deletedMessages || 0), inline: true },
			{ name: `Affected Users`, value: userLines.length ? trimForDiscord(userLines.join(`\n`)) : `None recorded`, inline: false },
		);
}

function getUniqueMessageSummaries(messages) {
	const seen = new Set();
	const summaries = [];

	for (const message of messages) {
		const attachments = parseJson(message.attachmentsJson, []);
		const links = parseJson(message.linksJson, []);
		const fingerprint = message.contentHash || `${message.content || ``}:${attachments.length}:${links.join(`|`)}`;

		if (seen.has(fingerprint)) {
			continue;
		}

		seen.add(fingerprint);
		summaries.push({
			content: message.content || `[No text content]`,
			attachmentCount: attachments.length,
			linkCount: links.length,
			channelId: message.channelId,
			messageId: message.messageId,
		});
	}

	return summaries;
}

function buildIncidentReportEmbed(details) {
	const { incident, users, messages, files, summary } = details;
	const uniqueMessages = getUniqueMessageSummaries(messages);
	const messageLines = uniqueMessages.slice(0, 5).map(message => {
		const extras = [
			message.attachmentCount ? `${message.attachmentCount} attachment(s)` : null,
			message.linkCount ? `${message.linkCount} link(s)` : null,
		].filter(Boolean).join(`, `);

		return trimForDiscord(`- ${message.content}${extras ? ` (${extras})` : ``}`, 300);
	});

	return new EmbedBuilder()
		.setColor(RAID_COLOR)
		.setTitle(`Raid Report #${incident.id}`)
		.setDescription(`Post-incident summary for ${formatTriggerType(incident.triggerType)}.`)
		.addFields(
			{ name: `Status`, value: incident.status, inline: true },
			{ name: `Started`, value: `<t:${Math.floor(new Date(incident.startedAt).getTime() / 1000)}:F>`, inline: true },
			{ name: `Users`, value: String(users.length || summary.userCount || 0), inline: true },
			{ name: `Messages`, value: String(messages.length || summary.messageCount || 0), inline: true },
			{ name: `Unique Message Types`, value: String(uniqueMessages.length), inline: true },
			{ name: `Archived Files`, value: String(files.length || summary.archivedFiles || 0), inline: true },
			{ name: `Sampled Unique Messages`, value: messageLines.length ? trimForDiscord(messageLines.join(`\n`)) : `No message evidence recorded.`, inline: false },
		)
		.setFooter({ text: `Duplicate spam is collapsed in this report, but individual evidence rows remain stored.` });
}

function getMessageEvidenceFingerprint(message) {
	const attachments = parseJson(message.attachmentsJson, []);
	const links = parseJson(message.linksJson, []);

	return message.contentHash || `${message.content || ``}:${attachments.length}:${links.join(`|`)}`;
}

function getIncidentEvidenceGroups(messages) {
	const groups = [];
	const seen = new Map();

	for (const message of messages) {
		const fingerprint = getMessageEvidenceFingerprint(message);
		const parsedMessage = {
			...message,
			attachments: parseJson(message.attachmentsJson, []),
			embeds: parseJson(message.embedsJson, []),
			links: parseJson(message.linksJson, []),
		};
		let group = seen.get(fingerprint);

		if (!group) {
			group = {
				fingerprint,
				messages: [],
				representative: parsedMessage,
			};
			seen.set(fingerprint, group);
			groups.push(group);
		}

		group.messages.push(parsedMessage);
	}

	return groups;
}

function formatBytes(size) {
	const value = Number(size) || 0;

	if (value >= 1024 * 1024) {
		return `${(value / (1024 * 1024)).toFixed(1)} MB`;
	}

	if (value >= 1024) {
		return `${(value / 1024).toFixed(1)} KB`;
	}

	return `${value} B`;
}

function splitEvidenceContent(content) {
	const value = content || `[No text content]`;
	const chunks = [];
	let index = 0;

	while (index < value.length && chunks.length < EVIDENCE_CONTENT_CHUNK_COUNT) {
		chunks.push(value.slice(index, index + EVIDENCE_CONTENT_CHUNK_LENGTH));
		index += EVIDENCE_CONTENT_CHUNK_LENGTH;
	}

	if (!chunks.length) {
		chunks.push(`[No text content]`);
	}

	if (index < value.length) {
		const lastIndex = chunks.length - 1;
		chunks[lastIndex] = trimForDiscord(`${chunks[lastIndex]}\n[Content truncated]`, EVIDENCE_CONTENT_CHUNK_LENGTH);
	}

	return chunks;
}

function addEvidenceContentFields(embed, content) {
	const chunks = splitEvidenceContent(content);

	chunks.forEach((chunk, index) => {
		embed.addFields({
			name: index === 0 ? `Original Content` : `Original Content Continued`,
			value: chunk || `[Empty]`,
			inline: false,
		});
	});
}

function getIncidentFilesForMessage(files, messageId) {
	return files.filter(file => file.messageId === messageId);
}

function hasLocalEvidenceFile(file) {
	return file.localPath && fs.existsSync(file.localPath);
}

function buildEvidenceFileAttachments(files) {
	return files
		.filter(hasLocalEvidenceFile)
		.slice(0, MAX_EVIDENCE_FILES_PER_MESSAGE)
		.map(file => new AttachmentBuilder(file.localPath, {
			name: sanitizeFilename(file.filename),
		}));
}

function formatAttachmentEvidence(attachments, files, includeFiles) {
	if (!attachments.length && !files.length) {
		return `None`;
	}

	const filesByAttachmentId = new Map(files.map(file => [file.attachmentId, file]));
	const lines = attachments.map(attachment => {
		const archivedFile = filesByAttachmentId.get(attachment.id);
		const archivedLabel = archivedFile && hasLocalEvidenceFile(archivedFile) ?
			(includeFiles ? `attached` : `archived`) :
			`metadata only`;

		return `- ${attachment.filename || attachment.id || `attachment`} (${formatBytes(attachment.size)}) - ${archivedLabel}`;
	});
	const unmatchedFiles = files.filter(file => !attachments.some(attachment => attachment.id === file.attachmentId));

	for (const file of unmatchedFiles) {
		const archivedLabel = hasLocalEvidenceFile(file) ?
			(includeFiles ? `attached` : `archived`) :
			`metadata only`;

		lines.push(`- ${file.filename || file.attachmentId || `attachment`} (${formatBytes(file.size)}) - ${archivedLabel}`);
	}

	return trimForDiscord(lines.join(`\n`));
}

function formatStoredEmbeds(embeds) {
	if (!embeds.length) {
		return null;
	}

	const lines = embeds.map((embed, index) => {
		const parts = [
			embed.title ? `title: ${embed.title}` : null,
			embed.description ? `description: ${embed.description}` : null,
			embed.url ? `url: ${embed.url}` : null,
			embed.imageUrl ? `image: ${embed.imageUrl}` : null,
			embed.thumbnailUrl ? `thumbnail: ${embed.thumbnailUrl}` : null,
			embed.videoUrl ? `video: ${embed.videoUrl}` : null,
			embed.provider ? `provider: ${embed.provider}` : null,
		].filter(Boolean);

		return `- Embed ${index + 1}: ${parts.length ? parts.join(` | `) : embed.type || `stored embed`}`;
	});

	return trimForDiscord(lines.join(`\n`));
}

function buildIncidentEvidenceSummaryEmbed(details) {
	const embed = buildIncidentReportEmbed(details);

	return embed
		.setTitle(`Raid Evidence Summary #${details.incident.id}`)
		.setDescription(`Stored evidence summary for ${formatTriggerType(details.incident.triggerType)}.`);
}

function buildIncidentEvidenceHeaderEmbed(details, groups, options) {
	const { incident, messages, files, summary } = details;
	const limitedCount = Math.min(groups.length, options.limit);

	return new EmbedBuilder()
		.setColor(RAID_COLOR)
		.setTitle(`Raid Evidence #${incident.id}`)
		.setDescription(`Sensitive evidence reconstruction. Duplicate spam is collapsed to one post per unique message type.`)
		.addFields(
			{ name: `Mode`, value: options.mode, inline: true },
			{ name: `Messages Stored`, value: String(messages.length || summary.messageCount || 0), inline: true },
			{ name: `Unique Message Types`, value: String(groups.length), inline: true },
			{ name: `Posting`, value: `${limitedCount} of ${groups.length}`, inline: true },
			{ name: `Files`, value: `${files.length || summary.archivedFiles || 0} archived record(s)`, inline: true },
			{ name: `Include Files`, value: formatYesNo(options.includeFiles), inline: true },
		)
		.setFooter({ text: `Only locally archived files can be re-uploaded. Evidence is posted by Hachi, not the original sender.` });
}

function buildEvidenceMessageEmbed(details, group, index, total, files, includeFiles) {
	const message = group.representative;
	const started = Math.floor(new Date(message.createdAt).getTime() / 1000);
	const embedSummary = formatStoredEmbeds(message.embeds);
	const evidenceEmbed = new EmbedBuilder()
		.setColor(RAID_WARN_COLOR)
		.setTitle(`Raid Evidence #${details.incident.id} - Message Type ${index + 1}/${total}`)
		.setDescription(`Verbatim stored message evidence. This is a reconstruction posted by Hachi.`)
		.addFields(
			{ name: `Original User`, value: `<@${message.userId}> (${message.userId})`, inline: true },
			{ name: `Original Channel`, value: `<#${message.channelId}>`, inline: true },
			{ name: `Original Message ID`, value: message.messageId, inline: true },
			{ name: `Original Time`, value: `<t:${started}:F>`, inline: true },
			{ name: `Duplicate Count`, value: String(group.messages.length), inline: true },
			{ name: `Deleted`, value: message.deletedAt ? `Yes` : `No/unknown`, inline: true },
		);

	addEvidenceContentFields(evidenceEmbed, message.content);

	evidenceEmbed.addFields({
		name: `Attachments`,
		value: formatAttachmentEvidence(message.attachments, files, includeFiles),
		inline: false,
	});

	if (embedSummary) {
		evidenceEmbed.addFields({
			name: `Stored Embed Summary`,
			value: embedSummary,
			inline: false,
		});
	}

	return evidenceEmbed;
}

function buildEvidenceCompletionEmbed(details, stats) {
	const lines = [];

	if (stats.truncatedMessages > 0) {
		lines.push(`- ${stats.truncatedMessages} unique message type(s) were not posted because of the limit.`);
	}

	if (stats.skippedFiles > 0) {
		lines.push(`- ${stats.skippedFiles} archived file(s) were not attached because of Discord's per-message file limit.`);
	}

	if (stats.fileSendFailures > 0) {
		lines.push(`- ${stats.fileSendFailures} file attachment(s) failed to upload; the evidence embeds were still posted.`);
	}

	return new EmbedBuilder()
		.setColor(lines.length ? RAID_WARN_COLOR : RAID_OK_COLOR)
		.setTitle(`Raid Evidence Complete #${details.incident.id}`)
		.setDescription(lines.length ? lines.join(`\n`) : `All selected evidence entries were posted.`);
}

async function sendEvidencePayload(channel, payload, stats, fileCount = 0) {
	try {
		await channel.send(payload);
		stats.postedMessages += 1;
		stats.postedFiles += fileCount;
	} catch (err) {
		if (!fileCount) {
			throw err;
		}

		stats.fileSendFailures += fileCount;
		warn(`Failed to upload raid evidence files: ${err.message}`, { module: `raid` });

		await channel.send({
			...payload,
			files: [],
		});
		stats.postedMessages += 1;
	}
}

async function postIncidentEvidence(guild, config, incidentId, options = {}) {
	const details = await getIncidentDetails(guild.id, incidentId);

	if (!details) {
		return { ok: false, reason: `Incident not found.` };
	}

	const channel = await fetchChannel(guild, config.reportChannelId);

	if (!channel || !canSendToChannel(guild, channel)) {
		return { ok: false, reason: `Report channel is unavailable or not writable.` };
	}

	const mode = options.mode === `verbatim` ? `verbatim` : `summary`;
	const includeFiles = Boolean(options.includeFiles);
	const limit = Math.min(Math.max(Number(options.limit) || MAX_EVIDENCE_MESSAGES, 1), MAX_EVIDENCE_MESSAGES);

	if (mode === `verbatim` && includeFiles && !canAttachFilesToChannel(guild, channel)) {
		return { ok: false, reason: `Report channel does not allow Hachi to attach files.` };
	}

	if (mode === `summary`) {
		const message = await channel.send({
			allowedMentions: { parse: [] },
			embeds: [buildIncidentEvidenceSummaryEmbed(details)],
		});

		return {
			ok: true,
			message,
			mode,
			postedFiles: 0,
			postedMessages: 1,
			truncatedMessages: 0,
			uniqueMessages: getIncidentEvidenceGroups(details.messages).length,
		};
	}

	const groups = getIncidentEvidenceGroups(details.messages);

	if (!groups.length) {
		return { ok: false, reason: `Incident has no stored message evidence to post.` };
	}

	const selectedGroups = groups.slice(0, limit);
	const stats = {
		fileSendFailures: 0,
		mode,
		postedFiles: 0,
		postedMessages: 0,
		skippedFiles: 0,
		truncatedMessages: groups.length - selectedGroups.length,
		uniqueMessages: groups.length,
	};

	await sendEvidencePayload(channel, {
		allowedMentions: { parse: [] },
		embeds: [buildIncidentEvidenceHeaderEmbed(details, groups, { includeFiles, limit, mode })],
	}, stats);

	for (let index = 0; index < selectedGroups.length; index += 1) {
		const group = selectedGroups[index];
		const files = getIncidentFilesForMessage(details.files, group.representative.messageId);
		const attachments = includeFiles ? buildEvidenceFileAttachments(files) : [];
		const skippedFiles = includeFiles ?
			Math.max(files.filter(hasLocalEvidenceFile).length - attachments.length, 0) :
			0;

		stats.skippedFiles += skippedFiles;

		await sendEvidencePayload(channel, {
			allowedMentions: { parse: [] },
			embeds: [buildEvidenceMessageEmbed(details, group, index, selectedGroups.length, files, includeFiles)],
			files: attachments,
		}, stats, attachments.length);
	}

	await sendEvidencePayload(channel, {
		allowedMentions: { parse: [] },
		embeds: [buildEvidenceCompletionEmbed(details, stats)],
	}, stats);

	return {
		ok: true,
		...stats,
	};
}

async function postIncidentReport(guild, config, incidentId) {
	const details = await getIncidentDetails(guild.id, incidentId);

	if (!details) {
		return { ok: false, reason: `Incident not found.` };
	}

	const channel = await fetchChannel(guild, config.reportChannelId);

	if (!channel || !canSendToChannel(guild, channel)) {
		return { ok: false, reason: `Report channel is unavailable or not writable.` };
	}

	const message = await channel.send({
		allowedMentions: { parse: [] },
		embeds: [buildIncidentReportEmbed(details)],
	});

	return {
		ok: true,
		message,
	};
}

async function quarantineUser(guild, userId, reason = `Manual raid quarantine`) {
	const config = await getRaidConfig(guild.id);

	if (!config.quarantineRoleId) {
		return { ok: false, reason: `No quarantine role is configured.` };
	}

	const member = await guild.members.fetch(userId).catch(() => null);

	if (!member) {
		return { ok: false, reason: `Member could not be fetched.` };
	}

	await member.roles.add(config.quarantineRoleId, reason);
	return { ok: true };
}

async function releaseUser(guild, userId) {
	const config = await getRaidConfig(guild.id);
	const member = await guild.members.fetch(userId).catch(() => null);

	if (!member) {
		return { ok: false, reason: `Member could not be fetched.` };
	}

	if (config.quarantineRoleId && member.roles.cache.has(config.quarantineRoleId)) {
		await member.roles.remove(config.quarantineRoleId, `Raid quarantine release`);
	}

	if (member.communicationDisabledUntilTimestamp) {
		await member.timeout(null, `Raid quarantine release`).catch(err => warn(`Failed to clear timeout for ${userId}: ${err.message}`));
	}

	await RaidIncidentUsers.update(
		{ releasedAt: new Date() },
		{
			where: {
				guildId: guild.id,
				userId,
				releasedAt: null,
			},
		},
	);

	return { ok: true };
}

function buildDrillIncidentId() {
	return `DRILL-${Date.now().toString(36).toUpperCase()}-${randomInt(100, 999)}`;
}

function buildDrillMessageContent(index, drillId) {
	const samples = [
		`Raid drill sample message ${index + 1} for ${drillId}.`,
		`Raid drill simulated application response ${index + 1}.`,
		`Raid drill repeated spam pattern ${index + 1}.`,
	];

	return samples[index % samples.length];
}

function buildDrillMessageRecords(guild, config, drillId, messageCount, uniqueContentCount, attachmentCount) {
	const channelId = config.alertChannelId || config.reportChannelId || guild.systemChannelId || guild.rulesChannelId || guild.id;
	const userId = guild.client.user?.id || guild.ownerId;
	const now = Date.now();

	return Array.from({ length: messageCount }, (_, index) => {
		const uniqueIndex = index % uniqueContentCount;
		const content = buildDrillMessageContent(uniqueIndex, drillId);
		const attachments = index < attachmentCount ?
			[
				{
					filename: `drill-evidence-${index + 1}.png`,
					id: `drill-attachment-${index + 1}`,
					size: randomInt(64 * 1024, 3 * 1024 * 1024),
				},
			] :
			[];
		const links = index === 0 ? [`https://example.com/raid-drill/${drillId.toLowerCase()}`] : [];

		return {
			attachmentsJson: safeJson(attachments),
			channelId,
			content,
			contentHash: hashText(content),
			createdAt: new Date(now - ((messageCount - index) * 1000)),
			deletedAt: config.actionDelete ? new Date(now) : null,
			embedsJson: safeJson([]),
			guildId: guild.id,
			id: index + 1,
			incidentId: drillId,
			linksJson: safeJson(links),
			messageId: `drill-message-${index + 1}`,
			userId,
		};
	});
}

function buildDrillDetails(guild, config) {
	const drillId = buildDrillIncidentId();
	const triggerType = Math.random() < 0.5 ? `message_spam` : `join_spike`;
	const startedAt = new Date();
	const messageCount = triggerType === `message_spam` ?
		randomInt(config.messageSpamCount, config.messageSpamCount + 4) :
		0;
	const uniqueContentCount = triggerType === `message_spam` ?
		randomInt(1, Math.min(messageCount, 3)) :
		0;
	const attachmentCount = triggerType === `message_spam` ?
		randomInt(0, Math.min(messageCount, 2)) :
		0;
	const userCount = triggerType === `join_spike` ?
		randomInt(config.joinSpikeCount, config.joinSpikeCount + 5) :
		1;
	const messages = triggerType === `message_spam` ?
		buildDrillMessageRecords(guild, config, drillId, messageCount, uniqueContentCount, attachmentCount) :
		[];
	const files = Array.from({ length: attachmentCount }, (_, index) => ({
		attachmentId: `drill-attachment-${index + 1}`,
		filename: `drill-evidence-${index + 1}.png`,
		guildId: guild.id,
		id: index + 1,
		incidentId: drillId,
		messageId: `drill-message-${index + 1}`,
		seenCount: 1,
		size: randomInt(64 * 1024, 3 * 1024 * 1024),
	}));
	const summary = triggerType === `message_spam` ?
		{
			actionFailures: 0,
			archivedFiles: files.length,
			attachmentCount,
			deletedMessages: config.actionDelete ? messageCount : 0,
			messageCount,
			uniqueContentCount,
		} :
		{
			actionFailures: 0,
			userCount,
		};

	return {
		files,
		incident: {
			guildId: guild.id,
			id: drillId,
			startedAt,
			status: `drill`,
			summary: safeJson(summary),
			triggerType,
		},
		messages,
		summary,
		users: Array.from({ length: userCount }, (_, index) => ({
			actionError: safeJson([]),
			actionTaken: safeJson([]),
			displayName: `Drill User ${index + 1}`,
			guildId: guild.id,
			id: index + 1,
			incidentId: drillId,
			joinedAt: triggerType === `join_spike` ? new Date(startedAt.getTime() - (index * 1000)) : null,
			userId: `drill-user-${index + 1}`,
			username: `drill-user-${index + 1}`,
		})),
	};
}

function buildDrillReportEmbed(details) {
	return buildIncidentReportEmbed(details)
		.setTitle(`Raid Drill Report #${details.incident.id}`)
		.setDescription(`Dry-run post-incident summary for ${formatTriggerType(details.incident.triggerType)}.`)
		.setFooter({ text: `Drill only. No roles, timeouts, deletions, pings, or database incidents were created.` });
}

async function buildRaidDrill(guild) {
	const config = await getRaidConfig(guild.id);
	const audit = await auditRaidConfiguration(guild, config);
	const details = buildDrillDetails(guild, config);
	const alertChannel = await fetchChannel(guild, config.alertChannelId);
	const reportChannel = await fetchChannel(guild, config.reportChannelId);

	if (!alertChannel || !canSendToChannel(guild, alertChannel)) {
		return {
			audit,
			config,
			ok: false,
			reason: `Alert channel is unavailable or not writable.`,
		};
	}

	if (!reportChannel || !canSendToChannel(guild, reportChannel)) {
		return {
			audit,
			config,
			ok: false,
			reason: `Report channel is unavailable or not writable.`,
		};
	}

	const alertContent = config.moderatorRoleId ? `<@&${config.moderatorRoleId}>` : null;
	const alertMessage = await alertChannel.send({
		allowedMentions: { parse: [] },
		content: alertContent,
		embeds: [buildRaidAlertEmbed(details.incident, config, details.summary)],
	});
	const reportMessage = await reportChannel.send({
		allowedMentions: { parse: [] },
		embeds: [buildDrillReportEmbed(details)],
	});

	return {
		audit,
		config,
		alertMessage,
		details,
		ok: true,
		reportMessage,
	};
}

module.exports = {
	auditRaidConfiguration,
	buildIncidentEmbed,
	buildIncidentReportEmbed,
	buildRaidAuditEmbed,
	buildRaidDrill,
	buildRaidStatusEmbed,
	clearRaidConfigCache,
	formatChannel,
	formatRole,
	formatYesNo,
	getDefaultRaidConfig,
	getIncidentDetails,
	getRaidConfig,
	listRecentIncidents,
	observeGuildMemberAdd,
	observeMessageForRaid,
	postIncidentEvidence,
	postIncidentReport,
	quarantineUser,
	releaseUser,
	saveRaidConfig,
	syncQuarantineOverwrites,
};
