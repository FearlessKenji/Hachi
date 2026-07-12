// Shared reaction-role helpers.
//
// Commands and reaction events both need consistent role assignability checks,
// emoji normalization, and database cleanup behavior for reaction-role panels.
const {
	EmbedBuilder,
	PermissionFlagsBits,
} = require(`discord.js`);
const { ReactionRoleItems, ReactionRoleMessages } = require(`../database/dbObjects.js`);
const { warn, error } = require(`./writeLog.js`);

const REACTION_ROLE_EMBED_COLOR = 0xfee75c;
const DEFAULT_PANEL_DESCRIPTION = `Select your roles below.`;
const DEFAULT_EMOJIS = [
	`1️⃣`,
	`2️⃣`,
	`3️⃣`,
	`4️⃣`,
	`5️⃣`,
	`6️⃣`,
	`7️⃣`,
	`8️⃣`,
	`9️⃣`,
	`🔟`,
	`🇦`,
	`🇧`,
	`🇨`,
	`🇩`,
	`🇪`,
	`🇫`,
	`🇬`,
	`🇭`,
	`🇮`,
	`🇯`,
	`🇰`,
	`🇱`,
	`🇲`,
	`🇳`,
	`🇴`,
];

function trimForDiscord(value, limit) {
	if (!value) {
		return value;
	}

	return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function getPanelRoleLimit() {
	return DEFAULT_EMOJIS.length;
}

function chunkItems(items, size) {
	const chunks = [];

	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}

	return chunks;
}

function getDefaultEmoji(index) {
	return DEFAULT_EMOJIS[index] || null;
}

function getCustomEmojiId(emoji) {
	if (!emoji) {
		return null;
	}

	const match = emoji.match(/^<a?:[^:]+:(\d+)>$/);

	return match?.[1] || null;
}

function canManageReactionRoles(interaction) {
	return interaction.memberPermissions?.has([
		PermissionFlagsBits.ManageGuild,
		PermissionFlagsBits.ManageRoles,
	]) || false;
}

function roleIsAssignable(guild, role, actorMember = null) {
	if (!role || role.id === guild.id || role.managed) {
		return false;
	}

	const botMember = guild.members.me;

	if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
		return false;
	}

	if (role.comparePositionTo(botMember.roles.highest) >= 0) {
		return false;
	}

	if (actorMember && guild.ownerId !== actorMember.id && role.comparePositionTo(actorMember.roles.highest) >= 0) {
		return false;
	}

	return true;
}

function getAssignableRoles(guild, actorMember, excludedRoleIds = []) {
	const excluded = new Set(excludedRoleIds);

	return [...guild.roles.cache.values()]
		.filter(role => !excluded.has(role.id))
		.filter(role => roleIsAssignable(guild, role, actorMember))
		.sort((left, right) => {
			if (right.position !== left.position) {
				return right.position - left.position;
			}

			return left.name.localeCompare(right.name);
		});
}

function buildRoleLines(items) {
	return items.map((item, index) => {
		const fallbackIndex = Number.isInteger(item.sortOrder) ? item.sortOrder : index;
		const prefix = item.emoji ||
			getDefaultEmoji(fallbackIndex % getPanelRoleLimit()) ||
			`•`;
		const label = item.label || `Role ${item.roleId}`;

		return `${prefix} ${label}`;
	});
}

function getPanelFooter() {
	return `React to add a role. Remove your reaction to remove it.`;
}

function groupItemsByCategory(items) {
	const groups = [];
	const groupByCategory = new Map();
	const hasCategories = items.some(item => item.category);

	if (!hasCategories) {
		return [{ name: null, items }];
	}

	for (const item of items) {
		const category = item.category || `Roles`;

		if (!groupByCategory.has(category)) {
			const group = { name: category, items: [] };
			groupByCategory.set(category, group);
			groups.push(group);
		}

		groupByCategory.get(category).items.push(item);
	}

	return groups;
}

function addRoleFields(embed, items, panelIndex, totalPanels) {
	const groups = groupItemsByCategory(items);

	if (!items.length) {
		embed.addFields({
			name: `Roles`,
			value: `No roles configured yet.`,
		});
		return;
	}

	for (const group of groups) {
		const defaultTitle = totalPanels > 1 ?
			`Roles (${panelIndex + 1}/${totalPanels})` :
			`Roles`;

		embed.addFields({
			name: trimForDiscord(group.name || defaultTitle, 256),
			value: trimForDiscord(buildRoleLines(group.items).join(`\n`), 1024),
		});
	}
}

function buildPanelEmbed(panel, items, options = {}) {
	const panelIndex = options.panelIndex ?? panel.panelIndex ?? 0;
	const totalPanels = options.totalPanels ?? 1;
	const preview = options.preview || false;
	const isContinuation = panelIndex > 0;
	const embed = new EmbedBuilder()
		.setColor(REACTION_ROLE_EMBED_COLOR);

	if (!isContinuation && panel.title) {
		embed.setTitle(panel.title);
	}

	if (!isContinuation) {
		embed.setDescription(panel.description || DEFAULT_PANEL_DESCRIPTION);
	}

	if (panel.imageUrl) {
		embed.setImage(panel.imageUrl);
	}

	if (panel.thumbnailUrl) {
		embed.setThumbnail(panel.thumbnailUrl);
	}

	addRoleFields(embed, items, panelIndex, totalPanels);

	const footerParts = [getPanelFooter()];

	if (preview) {
		footerParts.push(`Reaction preview`);
	}

	embed.setFooter({ text: footerParts.join(` `) });

	return embed;
}

function buildPanelPayload(panel, items, options = {}) {
	return {
		embeds: [buildPanelEmbed(panel, items, options)],
		components: [],
	};
}

async function getPanelItems(panelId) {
	return ReactionRoleItems.findAll({
		where: { reactionRoleMessageId: panelId },
		order: [[`sortOrder`, `ASC`], [`id`, `ASC`]],
	});
}

async function reactToMessageForPanel(message, panel, items) {
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		const emoji = item.emoji || getDefaultEmoji(index);

		if (!emoji) {
			continue;
		}

		try {
			await message.react(emoji);
		} catch (err) {
			warn(`Failed to add reaction-role emoji ${emoji} to message ${message.id}: ${err.message}`);
		}
	}
}

async function fetchPanelChannel(client, panel) {
	const guild = await client.guilds.fetch(panel.guildId).catch(() => null);

	if (!guild) {
		return null;
	}

	return guild.channels.fetch(panel.channelId).catch(() => null);
}

async function refreshPanelMessage(client, panel) {
	const channel = await fetchPanelChannel(client, panel);

	if (!channel?.messages || !panel.messageId) {
		return false;
	}

	const message = await channel.messages.fetch(panel.messageId).catch(() => null);

	if (!message) {
		return false;
	}

	const items = await getPanelItems(panel.id);
	const payloadOptions = await getPanelPayloadOptions(panel);
	await message.edit(buildPanelPayload(panel, items, payloadOptions));
	await reactToMessageForPanel(message, panel, items);

	return true;
}

async function getPanelPayloadOptions(panel) {
	if (!panel.groupKey) {
		return {
			panelIndex: panel.panelIndex || 0,
			totalPanels: 1,
		};
	}

	const panels = await getPanelGroup(panel);
	const panelIndex = panels.findIndex(groupPanel => groupPanel.id === panel.id);

	return {
		panelIndex: panelIndex >= 0 ? panelIndex : panel.panelIndex || 0,
		totalPanels: panels.length || 1,
	};
}

async function deletePanelRecords(panelIds) {
	await ReactionRoleItems.destroy({
		where: { reactionRoleMessageId: panelIds },
	});

	await ReactionRoleMessages.destroy({
		where: { id: panelIds },
	});
}

async function getPanelGroup(panel) {
	if (!panel.groupKey) {
		return [panel];
	}

	return ReactionRoleMessages.findAll({
		where: {
			guildId: panel.guildId,
			groupKey: panel.groupKey,
		},
		order: [[`panelIndex`, `ASC`], [`id`, `ASC`]],
	});
}

async function deletePanelMessages(client, panels) {
	for (const panel of panels) {
		const channel = await fetchPanelChannel(client, panel);

		if (!channel?.messages || !panel.messageId) {
			continue;
		}

		const message = await channel.messages.fetch(panel.messageId).catch(() => null);

		if (!message) {
			continue;
		}

		await message.delete().catch(err => warn(`Failed to delete reaction-role message ${panel.messageId}: ${err.message}`));
	}
}

async function syncReactionRolePanel(client, panel) {
	const guild = await client.guilds.fetch(panel.guildId).catch(() => null);

	if (!guild) {
		return { removed: 0, refreshed: false, reason: `Guild unavailable` };
	}

	await guild.roles.fetch().catch(err => warn(`Failed to refresh roles for ${guild.id}: ${err.message}`));
	await guild.members.fetchMe().catch(err => warn(`Failed to refresh bot member for ${guild.id}: ${err.message}`));
	await guild.emojis.fetch().catch(err => warn(`Failed to refresh emojis for ${guild.id}: ${err.message}`));

	const items = await getPanelItems(panel.id);
	const removedIds = [];
	let refreshedEmojis = 0;

	for (const [index, item] of items.entries()) {
		const role = guild.roles.cache.get(item.roleId);

		if (!roleIsAssignable(guild, role)) {
			removedIds.push(item.id);
			continue;
		}

		const customEmojiId = getCustomEmojiId(item.emoji);

		if (customEmojiId && !guild.emojis.cache.has(customEmojiId)) {
			const fallbackEmoji = getDefaultEmoji(index % getPanelRoleLimit());

			await item.update({
				emoji: fallbackEmoji,
			});
			refreshedEmojis += 1;
		}
	}

	if (removedIds.length) {
		await ReactionRoleItems.destroy({
			where: { id: removedIds },
		});
	}

	const refreshed = await refreshPanelMessage(client, panel);

	return {
		refreshedEmojis,
		removed: removedIds.length,
		refreshed,
		reason: refreshed ? null : `Message unavailable`,
	};
}

async function syncReactionRolePanels(client, guildId = null) {
	const where = { status: `active` };

	if (guildId) {
		where.guildId = guildId;
	}

	const panels = await ReactionRoleMessages.findAll({
		where,
		order: [[`guildId`, `ASC`], [`id`, `ASC`]],
	});

	const results = [];

	for (const panel of panels) {
		try {
			const result = await syncReactionRolePanel(client, panel);
			results.push({ panel, ...result });
		} catch (err) {
			error(`Failed to sync reaction-role panel ${panel.id}:`, err);
			results.push({ panel, refreshedEmojis: 0, removed: 0, refreshed: false, reason: err.message });
		}
	}

	return results;
}

async function disablePanelsForDeletedChannel(guildId, channelId) {
	const panels = await ReactionRoleMessages.findAll({
		where: {
			guildId,
			channelId,
			status: `active`,
		},
	});

	if (!panels.length) {
		return [];
	}

	await ReactionRoleMessages.update(
		{ status: `disabled` },
		{
			where: {
				guildId,
				channelId,
				status: `active`,
			},
		},
	);

	return panels;
}

async function handleReactionRoleReaction(reaction, user, shouldAdd) {
	if (user.bot) {
		return;
	}

	if (reaction.partial) {
		await reaction.fetch().catch(() => null);
	}

	const message = reaction.message;
	const emoji = reaction.emoji.toString();
	const item = await ReactionRoleItems.findOne({
		where: {
			messageId: message.id,
			emoji,
		},
	});

	if (!item) {
		return;
	}

	const panel = await ReactionRoleMessages.findByPk(item.reactionRoleMessageId);

	if (!panel || panel.status !== `active`) {
		return;
	}

	const guild = await message.client.guilds.fetch(panel.guildId).catch(() => null);

	if (!guild) {
		return;
	}

	const member = await guild.members.fetch(user.id).catch(() => null);
	const role = guild.roles.cache.get(item.roleId);

	if (!member || !roleIsAssignable(guild, role)) {
		return;
	}

	if (shouldAdd && member.roles.cache.has(role.id)) {
		await member.roles.remove(role);
		await reaction.users.remove(user.id).catch(() => null);
		return;
	}

	if (shouldAdd) {
		await member.roles.add(role);
		return;
	}

	if (member.roles.cache.has(role.id)) {
		await member.roles.remove(role);
	}
}

module.exports = {
	DEFAULT_PANEL_DESCRIPTION,
	DEFAULT_EMOJIS,
	REACTION_ROLE_EMBED_COLOR,
	buildPanelEmbed,
	buildPanelPayload,
	canManageReactionRoles,
	chunkItems,
	deletePanelMessages,
	deletePanelRecords,
	disablePanelsForDeletedChannel,
	getAssignableRoles,
	getDefaultEmoji,
	getPanelGroup,
	getPanelItems,
	getPanelRoleLimit,
	handleReactionRoleReaction,
	reactToMessageForPanel,
	refreshPanelMessage,
	roleIsAssignable,
	syncReactionRolePanel,
	syncReactionRolePanels,
	trimForDiscord,
};
