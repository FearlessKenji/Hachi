const {
	ApplicationIntegrationType,
	EmbedBuilder,
	Events,
	InteractionType,
} = require(`discord.js`);
const { Servers } = require(`../database/dbObjects.js`);
const { error, info } = require(`../utils/writeLog.js`);

const COMMAND_MONITOR_COLOR = 0xffb020;
const MAX_INTERNAL_CONTENT_LENGTH = 1000;

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

function getInstallContext(metadata) {
	const owners = metadata.authorizingIntegrationOwners || {};
	const guildOwner = getIntegrationOwner(owners, ApplicationIntegrationType.GuildInstall);
	const userOwner = getIntegrationOwner(owners, ApplicationIntegrationType.UserInstall);
	const contexts = [];

	if (guildOwner) {
		contexts.push(`Server-installed (${guildOwner})`);
	}

	if (userOwner) {
		contexts.push(`Profile-installed (${userOwner})`);
	}

	return contexts.length ? contexts.join(`\n`) : `Unknown`;
}

function getMessageUrl(message) {
	return `https://discord.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`;
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

function buildCommandMonitorEmbed(message, metadata, commandName) {
	const triggeredBy = metadata.user?.id ? `<@${metadata.user.id}>` : `Unknown user`;
	const commandText = commandName ? `/${commandName}` : `Unavailable`;

	return new EmbedBuilder()
		.setColor(COMMAND_MONITOR_COLOR)
		.setTitle(`Application Command Detected`)
		.setDescription(`A public application-command response was created.`)
		.addFields(
			{ name: `Triggered By`, value: triggeredBy, inline: true },
			{ name: `Application`, value: getApplicationLabel(message), inline: true },
			{ name: `Command`, value: commandText, inline: true },
			{ name: `Install Context`, value: getInstallContext(metadata), inline: false },
			{ name: `Source Channel`, value: `<#${message.channel.id}>`, inline: true },
			{ name: `Interaction ID`, value: metadata.id || `Unknown`, inline: true },
			{ name: `Message`, value: `[Jump to response](${getMessageUrl(message)})`, inline: true },
		)
		.setTimestamp(message.createdAt);
}

async function reportCommandUse(message, metadata, server) {
	const monitorChannel = await getMonitoringChannel(message, server);

	if (!monitorChannel) {
		return;
	}

	const commandName = getCommandName(message);
	const embed = buildCommandMonitorEmbed(message, metadata, commandName);

	await monitorChannel.send({
		allowedMentions: { parse: [] },
		embeds: [embed],
	});

	info(`Application command response detected.`, {
		meta: {
			applicationId: getApplicationId(message),
			authorizingIntegrationOwners: metadata.authorizingIntegrationOwners || null,
			channelId: message.channel.id,
			commandName,
			guildId: message.guild.id,
			installContext: getInstallContext(metadata),
			interactionId: metadata.id || null,
			messageContent: trimContent(message.content),
			messageId: message.id,
			messageUrl: getMessageUrl(message),
			userId: metadata.user?.id || null,
		},
		module: `command-monitor`,
	});
}

module.exports = {
	name: Events.MessageCreate,

	async execute(message) {
		const metadata = getInteractionMetadata(message);

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
