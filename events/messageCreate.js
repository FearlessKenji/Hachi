const {
	ApplicationIntegrationType,
	EmbedBuilder,
	Events,
	InteractionType,
} = require(`discord.js`);
const { CommandMonitorWhitelists, Servers } = require(`../database/dbObjects.js`);
const { observeMessageForRaid } = require(`../utils/raidProtection.js`);
const { error, info } = require(`../utils/writeLog.js`);

const COMMAND_MONITOR_COLOR = 0xffb020;
const MAX_INTERNAL_CONTENT_LENGTH = 1000;
const WHITELIST_TYPES = {
	APPLICATION: `application`,
	CHANNEL: `channel`,
};

function trimContent(content) {
	if (!content) {
		return null;
	}

	if (content.length <= MAX_INTERNAL_CONTENT_LENGTH) {
		return content;
	}

	return `${content.slice(0, MAX_INTERNAL_CONTENT_LENGTH)}...`;
}

function getInteractionMetadata(message) {
	return message.interactionMetadata || message.interaction || null;
}

function getCommandName(message) {
	return message.interaction?.commandName || null;
}

function getUserTag(user) {
	return user?.tag || user?.username || null;
}

function getUserDisplayName(user, member = null) {
	return member?.displayName ||
		user?.globalName ||
		user?.displayName ||
		user?.username ||
		null;
}

function getCachedMember(message, userId) {
	if (!userId) {
		return null;
	}

	return message.guild.members.cache.get(userId) || null;
}

function getCachedUser(message, userId) {
	if (!userId) {
		return null;
	}

	return message.client.users.cache.get(userId) || null;
}

function buildUserInfo(message, user, userId = null) {
	const id = user?.id || userId || null;
	const member = getCachedMember(message, id);

	return {
		id,
		displayName: getUserDisplayName(user, member),
		tag: getUserTag(user),
		username: user?.username || null,
	};
}

function buildUserInfoById(message, userId) {
	const user = getCachedUser(message, userId);

	return buildUserInfo(message, user, userId);
}

function buildGuildInfo(message) {
	return {
		id: message.guild.id,
		name: message.guild.name,
	};
}

function buildChannelInfo(channel) {
	return {
		id: channel?.id || null,
		name: channel?.name || null,
	};
}

function buildChannelInfoById(message, channelId) {
	const channel = message.client.channels.cache.get(channelId);

	return {
		id: channelId || null,
		name: channel?.name || null,
	};
}

function buildApplicationInfo(message) {
	return {
		id: getApplicationId(message),
		name: message.author?.username || null,
		tag: getUserTag(message.author),
	};
}

function getUserSummary(userInfo) {
	if (!userInfo?.id) {
		return `Unknown user`;
	}

	const name = userInfo.displayName || userInfo.tag || userInfo.username || userInfo.id;
	const handle = userInfo.tag || userInfo.username;

	return handle && handle !== name ?
		`${name} (${handle}, ${userInfo.id})` :
		`${name} (${userInfo.id})`;
}

function getApplicationSummary(applicationInfo) {
	if (!applicationInfo?.id) {
		return `Unknown app`;
	}

	const name = applicationInfo.name || applicationInfo.tag || applicationInfo.id;

	return `${name} (${applicationInfo.id})`;
}

function getTargetMessageId(message, metadata) {
	return metadata.targetMessageId ||
		metadata.target_message_id ||
		message.reference?.messageId ||
		null;
}

function getTargetChannelId(message) {
	return message.reference?.channelId || message.channel.id;
}

function getTargetUserId(metadata) {
	return metadata.targetUser?.id ||
		metadata.target_user?.id ||
		null;
}

function getCommandSurface(message, metadata) {
	if (getTargetMessageId(message, metadata)) {
		return `Message Context Menu`;
	}

	if (getTargetUserId(metadata)) {
		return `User Context Menu`;
	}

	return `Slash Command`;
}

function formatCommandName(commandName, commandSurface) {
	if (!commandName) {
		return `Unavailable`;
	}

	return commandSurface === `Slash Command` ?
		`/${commandName}` :
		commandName;
}

function formatCommandLabel(commandName, commandSurface) {
	const commandText = formatCommandName(commandName, commandSurface);

	if (commandText !== `Unavailable`) {
		return commandText;
	}

	return `${commandSurface}: unavailable`;
}

function getApplicationId(message) {
	return message.applicationId || message.author?.id || null;
}

function getApplicationLabel(message) {
	const applicationId = getApplicationId(message);
	const authorName = message.author?.tag || message.author?.username || null;

	if (!applicationId) {
		return authorName || `Unknown app`;
	}

	if (!authorName) {
		return applicationId;
	}

	return `${authorName} (${applicationId})`;
}

function getIntegrationOwner(owners, integrationType) {
	if (!owners) {
		return null;
	}

	return owners[integrationType] || owners[String(integrationType)] || null;
}

function getInstallContextEntries(message, metadata) {
	const owners = metadata.authorizingIntegrationOwners || {};
	const guildOwner = getIntegrationOwner(owners, ApplicationIntegrationType.GuildInstall);
	const userOwner = getIntegrationOwner(owners, ApplicationIntegrationType.UserInstall);
	const contexts = [];

	if (guildOwner) {
		contexts.push({
			type: `Server-installed`,
			owner: {
				id: guildOwner,
				name: message && guildOwner === message.guild.id ? message.guild.name : null,
			},
		});
	}

	if (userOwner) {
		contexts.push({
			type: `Profile-installed`,
			owner: {
				...(message ?
					buildUserInfoById(message, userOwner) :
					{ id: userOwner, displayName: null, tag: null, username: null }),
			},
		});
	}

	return contexts;
}

function formatInstallContext(message, metadata) {
	const contexts = getInstallContextEntries(message, metadata);

	if (!contexts.length) {
		return `Unknown`;
	}

	return contexts.map(context => {
		if (context.type === `Server-installed`) {
			return `Server installed`;
		}

		if (context.type === `Profile-installed`) {
			const label = context.owner.tag || context.owner.username || context.owner.displayName || context.owner.id;

			return `Profile installed: ${label} (${context.owner.id})`;
		}

		return `${context.type}: ${context.owner.id}`;
	}).join(`\n`);
}

function getMessageUrl(message) {
	return `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;
}

function getTargetMessageUrl(message, targetMessageId) {
	const channelId = getTargetChannelId(message);
	const guildId = message.reference?.guildId || message.guild.id;

	return `https://discord.com/channels/${guildId}/${channelId}/${targetMessageId}`;
}

function shouldSkipMessage(message, metadata) {
	if (!message.guild || !metadata) {
		return true;
	}

	return metadata.type !== InteractionType.ApplicationCommand;
}

async function getMonitoringChannel(message, server) {
	if (!server.commandMonitoringEnabled || !server.commandMonitoringChannelId) {
		return null;
	}

	const channel = await message.guild.channels.fetch(server.commandMonitoringChannelId).catch(() => null);

	if (!channel?.send) {
		return null;
	}

	return channel;
}

async function getCommandMonitorSuppression(message) {
	const applicationId = getApplicationId(message);
	const checks = [];

	if (applicationId) {
		checks.push(CommandMonitorWhitelists.findOne({
			raw: true,
			where: {
				guildId: message.guild.id,
				type: WHITELIST_TYPES.APPLICATION,
				targetId: applicationId,
			},
		}));
	}

	checks.push(CommandMonitorWhitelists.findOne({
		raw: true,
		where: {
			guildId: message.guild.id,
			type: WHITELIST_TYPES.CHANNEL,
			targetId: message.channel.id,
		},
	}));

	const entries = await Promise.all(checks);

	return entries.find(Boolean) || null;
}

function buildCommandMonitorEmbed(message, metadata, commandName) {
	const triggeredBy = metadata.user?.id ? `<@${metadata.user.id}>` : `Unknown user`;
	const commandSurface = getCommandSurface(message, metadata);
	const commandText = formatCommandName(commandName, commandSurface);
	const targetMessageId = getTargetMessageId(message, metadata);
	const targetUserId = getTargetUserId(metadata);
	const targetFields = [];

	if (targetMessageId) {
		targetFields.push({
			name: `Target Message`,
			value: `[Jump to target](${getTargetMessageUrl(message, targetMessageId)})`,
			inline: true,
		});
	}

	if (targetUserId) {
		targetFields.push({
			name: `Target User`,
			value: `<@${targetUserId}>`,
			inline: true,
		});
	}

	return new EmbedBuilder()
		.setColor(COMMAND_MONITOR_COLOR)
		.setTitle(`Application Command Detected`)
		.setDescription(`A public application-command response was created.`)
		.addFields(
			{ name: `Triggered By`, value: triggeredBy, inline: true },
			{ name: `Application`, value: getApplicationLabel(message), inline: true },
			{ name: `Command`, value: commandText, inline: true },
			{ name: `Command Type`, value: commandSurface, inline: true },
			...targetFields,
			{ name: `Install Context`, value: formatInstallContext(message, metadata), inline: false },
			{ name: `Source Channel`, value: `<#${message.channel.id}>`, inline: true },
			{ name: `Interaction ID`, value: metadata.id || `Unknown`, inline: true },
			{ name: `Message`, value: `[Jump to response](${getMessageUrl(message)})`, inline: true },
		)
		.setTimestamp(message.createdAt);
}

async function reportCommandUse(message, metadata, server) {
	const suppression = await getCommandMonitorSuppression(message);

	if (suppression) {
		return;
	}

	const monitorChannel = await getMonitoringChannel(message, server);

	if (!monitorChannel) {
		return;
	}

	const commandName = getCommandName(message);
	const commandSurface = getCommandSurface(message, metadata);
	const targetMessageId = getTargetMessageId(message, metadata);
	const targetChannelId = targetMessageId ? getTargetChannelId(message) : null;
	const targetUserId = getTargetUserId(metadata);
	const embed = buildCommandMonitorEmbed(message, metadata, commandName);
	const guild = buildGuildInfo(message);
	const channel = buildChannelInfo(message.channel);
	const user = buildUserInfo(message, metadata.user);
	const application = buildApplicationInfo(message);
	const commandLabel = formatCommandLabel(commandName, commandSurface);
	const logSummary = `${commandLabel} by ${getUserSummary(user)} via ${getApplicationSummary(application)} in #${channel.name || channel.id} / ${guild.name}`;

	await monitorChannel.send({
		allowedMentions: { parse: [] },
		embeds: [embed],
	});

	info(`Application command response detected: ${logSummary}`, {
		meta: {
			guild,
			channel,
			user,
			application,
			command: {
				name: commandName,
				label: commandLabel,
				type: commandSurface,
				interactionId: metadata.id || null,
			},
			installContext: getInstallContextEntries(message, metadata),
			message: {
				id: message.id,
				url: getMessageUrl(message),
				contentPreview: trimContent(message.content),
			},
			target: {
				messageId: targetMessageId,
				channel: targetChannelId ? buildChannelInfoById(message, targetChannelId) : null,
				user: targetUserId ? buildUserInfoById(message, targetUserId) : null,
			},
			raw: {
				authorizingIntegrationOwners: metadata.authorizingIntegrationOwners || null,
			},
		},
		module: `command-monitor`,
	});
}

module.exports = {
	name: Events.MessageCreate,

	async execute(message) {
		const metadata = getInteractionMetadata(message);

		try {
			await observeMessageForRaid(message, metadata);
		} catch (err) {
			error(`Failed to process raid message monitor:`, err, {
				meta: {
					channelId: message.channel?.id || null,
					guildId: message.guild?.id || null,
					messageId: message.id,
				},
				module: `raid`,
			});
		}

		if (shouldSkipMessage(message, metadata)) {
			return;
		}

		try {
			const server = await Servers.findOne({
				raw: true,
				where: { guildId: message.guild.id },
			});

			if (!server) {
				return;
			}

			await reportCommandUse(message, metadata, server);
		} catch (err) {
			error(`Failed to report application command usage:`, err, {
				meta: {
					channelId: message.channel?.id || null,
					guildId: message.guild?.id || null,
					messageId: message.id,
				},
				module: `command-monitor`,
			});
		}
	},
};
