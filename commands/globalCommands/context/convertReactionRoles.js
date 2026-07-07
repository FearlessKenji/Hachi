const {
	ApplicationCommandType,
	ContextMenuCommandBuilder,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
} = require(`discord.js`);
const { Servers } = require(`../../../database/dbObjects.js`);
const { error } = require(`../../../utils/writeLog.js`);
const {
	canManageReactionRoles,
	DEFAULT_PANEL_DESCRIPTION,
	roleIsAssignable,
	trimForDiscord,
} = require(`../../../utils/reactionRoles.js`);

const CUSTOM_EMOJI_PATTERN = /^<a?:[^:\s]+:\d+>/;
const CUSTOM_EMOJI_ID_PATTERN = /^<a?:[^:\s]+:(\d+)>$/;
const EMOJI_ALIAS_PATTERN = /^:([a-z0-9_+-]+):/i;
const ROLE_MENTION_PATTERN = /<@&(\d+)>/;
const EMOJI_TOKEN_PATTERN = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{1F1E6}-\u{1F1FF}]/u;
const STANDARD_EMOJI_ALIASES = new Map([
	[`bell`, `🔔`],
	[`black_circle`, `⚫`],
	[`blue_circle`, `🔵`],
	[`brown_circle`, `🟤`],
	[`camera`, `📷`],
	[`gift`, `🎁`],
	[`green_circle`, `🟢`],
	[`gun`, `🔫`],
	[`heart`, `❤️`],
	[`knife`, `🔪`],
	[`large_blue_circle`, `🔵`],
	[`large_orange_circle`, `🟠`],
	[`loudspeaker`, `📢`],
	[`mega`, `📣`],
	[`newspaper`, `📰`],
	[`orange_circle`, `🟠`],
	[`purple_circle`, `🟣`],
	[`red_circle`, `🔴`],
	[`sailboat`, `⛵`],
	[`star`, `⭐`],
	[`tada`, `🎉`],
	[`video_game`, `🎮`],
	[`white_circle`, `⚪`],
	[`yellow_circle`, `🟡`],
]);
const emojiSegmenter = new Intl.Segmenter(undefined, { granularity: `grapheme` });

function findImageAttachment(message) {
	return [...message.attachments.values()].find(attachment => attachment.contentType?.startsWith(`image/`)) || null;
}

function buildAttachmentLines(message, imageAttachment) {
	return [...message.attachments.values()]
		.filter(attachment => attachment.id !== imageAttachment?.id)
		.map(attachment => attachment.url);
}

function addSourcePart(parts, value) {
	const trimmed = value?.trim();

	if (trimmed && !parts.includes(trimmed)) {
		parts.push(trimmed);
	}
}

function buildDescription(message, sourceEmbed, attachmentLines) {
	const parts = [];

	addSourcePart(parts, message.content);
	addSourcePart(parts, sourceEmbed?.description);

	if (attachmentLines.length) {
		parts.push(`Attachments:\n${attachmentLines.join(`\n`)}`);
	}

	return trimForDiscord(parts.join(`\n\n`) || `Select your roles below.`, 3500);
}

function stripMarkdown(value) {
	return value
		.replace(/^#{1,6}\s+/, ``)
		.replace(/\*\*/g, ``)
		.replace(/__/g, ``)
		.trim();
}

function normalizeRoleText(value) {
	return stripMarkdown(value)
		.normalize(`NFKD`)
		.toLowerCase()
		.replace(/<@&\d+>/g, ``)
		.replace(/[^\p{Letter}\p{Number}]+/gu, ` `)
		.trim();
}

function getSourceText(message, sourceEmbed, attachmentLines) {
	const parts = [];

	addSourcePart(parts, message.content);
	addSourcePart(parts, sourceEmbed?.description);

	for (const field of sourceEmbed?.fields || []) {
		parts.push(`${field.name}:\n${field.value}`);
	}

	if (attachmentLines.length) {
		parts.push(`Attachments:\n${attachmentLines.join(`\n`)}`);
	}

	return parts.join(`\n\n`);
}

function getCategoryName(line) {
	const cleaned = stripMarkdown(line);

	if (!cleaned.endsWith(`:`)) {
		return null;
	}

	const category = cleaned.slice(0, -1).trim();

	return category || null;
}

function isEmojiToken(token) {
	return CUSTOM_EMOJI_PATTERN.test(token) || EMOJI_TOKEN_PATTERN.test(token);
}

function getCustomEmojiId(emoji) {
	const match = emoji?.match(CUSTOM_EMOJI_ID_PATTERN);

	return match?.[1] || null;
}

function customEmojiBelongsToGuild(emoji, guild) {
	const customEmojiId = getCustomEmojiId(emoji);

	if (!customEmojiId) {
		return true;
	}

	return guild.emojis.cache.has(customEmojiId);
}

function resolveEmojiAlias(aliasName, guild) {
	const normalizedAlias = aliasName.toLowerCase();
	const standardEmoji = STANDARD_EMOJI_ALIASES.get(normalizedAlias);

	if (standardEmoji) {
		return standardEmoji;
	}

	const guildEmoji = [...(guild?.emojis.cache.values() || [])]
		.find(emoji => emoji.name?.toLowerCase() === normalizedAlias);

	return guildEmoji?.toString() || null;
}

function getLeadingEmoji(value, guild) {
	const customEmoji = value.match(CUSTOM_EMOJI_PATTERN);

	if (customEmoji) {
		return {
			emoji: customEmoji[0],
			label: value.slice(customEmoji[0].length).trim(),
		};
	}

	const emojiAlias = value.match(EMOJI_ALIAS_PATTERN);

	if (emojiAlias) {
		return {
			emoji: resolveEmojiAlias(emojiAlias[1], guild),
			label: value.slice(emojiAlias[0].length).trim(),
			unresolvedEmoji: emojiAlias[0],
		};
	}

	const [firstSegment] = emojiSegmenter.segment(value);

	if (!firstSegment?.segment || !isEmojiToken(firstSegment.segment)) {
		return null;
	}

	return {
		emoji: firstSegment.segment,
		label: value.slice(firstSegment.segment.length).trim(),
	};
}

function parseRoleLine(line, guild) {
	const cleaned = stripMarkdown(line).replace(/^[-*•]\s+/, ``);
	const leadingEmoji = getLeadingEmoji(cleaned, guild);
	let emoji = null;
	let label = cleaned;
	let unresolvedEmoji = null;

	if (leadingEmoji) {
		emoji = leadingEmoji.emoji;
		label = leadingEmoji.label;
		unresolvedEmoji = leadingEmoji.emoji ? null : leadingEmoji.unresolvedEmoji;
	}

	const roleMention = cleaned.match(ROLE_MENTION_PATTERN);

	if (roleMention) {
		label = label.replace(ROLE_MENTION_PATTERN, ``).trim();
	}

	if (!emoji && !roleMention && !unresolvedEmoji) {
		return null;
	}

	return {
		emoji,
		label: label.replace(/[.。]+$/u, ``).trim(),
		roleId: roleMention?.[1] || null,
		unresolvedEmoji,
	};
}

function buildRoleIndex(guild, member) {
	const exact = new Map();
	const roles = [...guild.roles.cache.values()]
		.filter(role => roleIsAssignable(guild, role, member));

	for (const role of roles) {
		const normalized = normalizeRoleText(role.name);

		if (normalized) {
			const matches = exact.get(normalized) || [];
			matches.push(role);
			exact.set(normalized, matches);
		}
	}

	return { exact, roles };
}

function findMatchingRole(parsedLine, roleIndex, guild) {
	if (parsedLine.roleId) {
		const role = guild.roles.cache.get(parsedLine.roleId);

		if (role && roleIndex.roles.some(assignableRole => assignableRole.id === role.id)) {
			return role;
		}
	}

	const normalizedLabel = normalizeRoleText(parsedLine.label);

	if (!normalizedLabel) {
		return null;
	}

	const exactRoles = roleIndex.exact.get(normalizedLabel) || [];

	if (exactRoles.length === 1) {
		return exactRoles[0];
	}

	if (normalizedLabel.length < 3) {
		return null;
	}

	const fuzzyMatches = roleIndex.roles.filter(role => {
		const normalizedRole = normalizeRoleText(role.name);

		return normalizedRole.length >= 3 &&
			(normalizedRole.includes(normalizedLabel) || normalizedLabel.includes(normalizedRole));
	});

	return fuzzyMatches.length === 1 ? fuzzyMatches[0] : null;
}

function formatParsedLine(parsedLine) {
	const emoji = parsedLine.emoji || parsedLine.unresolvedEmoji || `•`;
	const category = parsedLine.category ? ` (${parsedLine.category})` : ``;

	return `${emoji} ${parsedLine.label}${category}`;
}

function parseSourceForRoles(sourceText, guild, member) {
	const roleIndex = buildRoleIndex(guild, member);
	const descriptionLines = [];
	const roles = [];
	const unmatched = [];
	const externalEmojis = [];
	const unresolvedEmojis = [];
	const seenRoleIds = new Set();
	let roleLineCount = 0;
	let currentCategory = null;
	let foundCategory = false;

	for (const rawLine of sourceText.split(/\r?\n/)) {
		const line = rawLine.trim();

		if (!line) {
			continue;
		}

		const category = getCategoryName(line);

		if (category) {
			currentCategory = category;
			foundCategory = true;
			continue;
		}

		const parsedLine = parseRoleLine(line, guild);

		if (!parsedLine) {
			if (!foundCategory) {
				descriptionLines.push(line);
			}

			continue;
		}

		roleLineCount += 1;

		const role = findMatchingRole(parsedLine, roleIndex, guild);
		const sourceOrder = roleLineCount - 1;
		const parsedLineDetails = {
			category: currentCategory,
			emoji: parsedLine.emoji,
			label: parsedLine.label || line,
			sourceOrder,
			unresolvedEmoji: parsedLine.unresolvedEmoji || null,
		};

		if (!customEmojiBelongsToGuild(parsedLine.emoji, guild)) {
			externalEmojis.push(parsedLineDetails);
			continue;
		}

		if (!role || seenRoleIds.has(role.id)) {
			unmatched.push(parsedLineDetails);
			continue;
		}

		seenRoleIds.add(role.id);

		if (parsedLine.unresolvedEmoji) {
			unresolvedEmojis.push(`${parsedLine.unresolvedEmoji} ${role.name}`);
		}

		roles.push({
			category: currentCategory,
			emoji: parsedLine.emoji,
			label: parsedLine.label || role.name,
			roleId: role.id,
			sourceOrder,
		});
	}

	return {
		description: trimForDiscord(descriptionLines.join(`\n`) || DEFAULT_PANEL_DESCRIPTION, 3500),
		assignableRoleCount: roleIndex.roles.length,
		externalEmojis,
		roles,
		roleLineCount,
		unmatched,
		unresolvedEmojis,
	};
}

function buildStatusMessage(parsed) {
	const issues = [];

	if (parsed.unmatched.length) {
		const unmatchedLines = parsed.unmatched.map(formatParsedLine);

		issues.push(`Could not match ${parsed.unmatched.length} line(s): ${trimForDiscord(unmatchedLines.join(`, `), 900)}`);
	}

	if (parsed.unresolvedEmojis.length) {
		issues.push(`Could not resolve ${parsed.unresolvedEmojis.length} emoji alias(es), so default reactions were used: ${trimForDiscord(parsed.unresolvedEmojis.join(`, `), 900)}`);
	}

	return issues.join(`\n`) || null;
}

function buildUnmatchedRolesMessage(pending) {
	const unmatchedLines = trimForDiscord(
		pending.unmatchedRoleLines
			.map(formatParsedLine)
			.join(`\n`),
		900,
	);

	return [
		`I found ${pending.parseStats.roleLineCount} reaction-role line(s), but ${pending.unmatchedRoleLines.length} could not be converted.`,
		``,
		`Could not convert:`,
		unmatchedLines,
		``,
		`Possible causes:`,
		`- The server role does not exist.`,
		`- The role name is too different from the message text.`,
		`- The role is above the bot in the Roles list.`,
		`- The role is above your highest role.`,
		`- The role is managed by an integration.`,
		``,
		`No reaction-role panel was created.`,
	].join(`\n`);
}

function buildExternalEmojiMessage(pending) {
	const emojiLines = trimForDiscord(
		pending.externalEmojiLines
			.map(formatParsedLine)
			.join(`\n`),
		900,
	);

	return [
		`I found ${pending.parseStats.roleLineCount} reaction-role line(s), but ${pending.externalEmojiLines.length} use custom emoji from outside this server.`,
		``,
		`Custom emoji must belong to this server:`,
		emojiLines,
		``,
		`No reaction-role panel was created.`,
	].join(`\n`);
}

async function getTargetMessage(interaction) {
	const message = interaction.targetMessage;

	if (!message.partial) {
		return message;
	}

	return message.fetch().catch(() => message);
}

function buildNoRolesMessage(pending) {
	if (!pending.sourceTextLength) {
		return `I could not read any text from that message. Make sure the Message Content intent is enabled for the bot ` +
			`in code and in the Discord Developer Portal, then restart the bot.`;
	}

	if (!pending.parseStats.roleLineCount) {
		return `I could read the message text, but I did not find any emoji/role lines. ` +
			`Put an emoji or supported :emoji_name: shortcode before each role name, then try again.`;
	}

	if (!pending.parseStats.assignableRoleCount) {
		return `I found ${pending.parseStats.roleLineCount} emoji/role line(s), but this bot cannot assign any roles ` +
			`in this server. Check that the bot has Manage Roles and that its highest role is above the target roles.`;
	}

	return `I found ${pending.parseStats.roleLineCount} emoji/role line(s), but none matched assignable roles. ` +
		`Make sure the role names in the message match server roles and that both you and the bot can manage those roles.`;
}

async function buildPendingFromMessage(interaction) {
	const message = await getTargetMessage(interaction);
	const sourceEmbed = message.embeds[0] || null;
	const imageAttachment = findImageAttachment(message);
	const attachmentLines = buildAttachmentLines(message, imageAttachment);
	const sourceText = getSourceText(message, sourceEmbed, attachmentLines);
	const parsed = parseSourceForRoles(sourceText, interaction.guild, interaction.member);
	const emojis = parsed.roles.map(role => role.emoji || null);

	return {
		baseRoleEmojis: emojis,
		channelId: message.channelId,
		description: parsed.description || buildDescription(message, sourceEmbed, attachmentLines),
		guildId: interaction.guild.id,
		imageUrl: sourceEmbed?.image?.url || imageAttachment?.url || null,
		isEditing: false,
		reactionEmojis: [...emojis],
		roles: parsed.roles,
		parseStats: {
			assignableRoleCount: parsed.assignableRoleCount,
			roleLineCount: parsed.roleLineCount,
		},
		externalEmojiLines: parsed.externalEmojis,
		setupReactionEmojis: [],
		sourceTextLength: sourceText.trim().length,
		setupMessageId: null,
		statusMessage: buildStatusMessage(parsed),
		thumbnailUrl: sourceEmbed?.thumbnail?.url || null,
		title: sourceEmbed?.title || `Reaction Roles`,
		unmatchedRoleLines: parsed.unmatched,
		userId: interaction.user.id,
	};
}

module.exports = {
	data: new ContextMenuCommandBuilder()
		.setName(`Convert to Reaction Roles`)
		.setType(ApplicationCommandType.Message)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild),

	help: {
		category: `management`,
		permissions: [
			PermissionFlagsBits.ManageGuild,
			PermissionFlagsBits.ManageRoles,
		],
		entries: [
			{
				command: `Convert to Reaction Roles`,
				description: `message context menu for converting role-list messages into reaction-role panels.`,
			},
		],
	},

	async execute(interaction) {
		try {
			if (!canManageReactionRoles(interaction)) {
				await interaction.reply({
					content: `You need both Manage Server and Manage Roles to convert messages into reaction roles.`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			await Servers.upsert({ guildId: interaction.guild.id });
			await interaction.guild.roles.fetch().catch(() => null);
			await interaction.guild.emojis.fetch().catch(() => null);

			const reactionCommand = interaction.client.commands.get(`reaction`) || require(`../utility/reaction.js`);
			const pending = await buildPendingFromMessage(interaction);

			if (!pending.roles.length && !pending.unmatchedRoleLines?.length && !pending.externalEmojiLines?.length) {
				await interaction.reply({
					content: buildNoRolesMessage(pending),
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			if (pending.externalEmojiLines.length) {
				await interaction.reply({
					content: buildExternalEmojiMessage(pending),
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			if (pending.unmatchedRoleLines.length) {
				await interaction.reply({
					content: buildUnmatchedRolesMessage(pending),
					flags: MessageFlags.Ephemeral,
				});
				return;
			}

			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			await reactionCommand.createFromContext(interaction, pending);
		} catch (err) {
			error(`Failed to convert message to reaction roles:`, err);

			const payload = {
				content: `Failed to convert that message into reaction roles: ${err.message}`,
				flags: MessageFlags.Ephemeral,
			};

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp(payload);
			} else {
				await interaction.reply(payload);
			}
		}
	},
};
