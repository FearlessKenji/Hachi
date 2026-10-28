// Shared stream-notification helpers.
//
// Twitch and Kick notifications use the same Discord-side behavior: find target
// channels, build embeds, fetch/edit messages, format role mentions, and load
// server/channel state efficiently for each cron tick.
const { EmbedBuilder } = require(`discord.js`);
const { Servers, Channels } = require(`../database/dbObjects.js`);

const STREAM_TIME_ZONE = `America/New_York`;
// Retry age begins when Hachi confirms the stream ended, not when it started.
const VOD_WAIT_MS = 6 * 60 * 60 * 1000;

const streamTimeFormatter = new Intl.DateTimeFormat(`en-US`, {
	day: `numeric`,
	hour: `numeric`,
	minute: `2-digit`,
	month: `numeric`,
	timeZone: STREAM_TIME_ZONE,
	timeZoneName: `short`,
	year: `numeric`,
});

function formatStreamTime(input) {
	const date = input instanceof Date ? input : new Date(input);

	if (Number.isNaN(date.getTime())) {
		return `unknown time`;
	}

	const parts = Object.fromEntries(
		streamTimeFormatter
			.formatToParts(date)
			.filter(part => part.type !== `literal`)
			.map(part => [part.type, part.value]),
	);

	return `${parts.month}/${parts.day}/${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
}

function liveFooter(startedAt) {
	return `Started ${formatStreamTime(startedAt)}. Last edited ${formatStreamTime(new Date())}.`;
}

function offlineFooter(existingEmbed) {
	const previousFooter = existingEmbed?.footer?.text;
	// A replay may arrive on a later poll. Keep the time recorded by the first
	// offline edit rather than changing it each time the replay lookup runs.
	if (previousFooter && /Stream ended .+\.$/u.test(previousFooter)) {
		return previousFooter;
	}

	const endedText = `Stream ended ${formatStreamTime(new Date())}.`;
	if (!previousFooter) {
		return endedText;
	}
	if (/Last edited .+\.$/u.test(previousFooter)) {
		return previousFooter.replace(/Last edited .+\.$/u, endedText);
	}
	return `${previousFooter} ${endedText}`;
}

function vodWaitExpired(endedAt, now = new Date()) {
	const endedTime = new Date(endedAt).getTime();
	return Number.isFinite(endedTime) && now.getTime() - endedTime >= VOD_WAIT_MS;
}

function groupChannels(channels) {
	const channelsByGuild = new Map();

	for (const chan of channels) {
		if (!channelsByGuild.has(chan.guildId)) {
			channelsByGuild.set(chan.guildId, []);
		}

		channelsByGuild.get(chan.guildId).push(chan);
	}

	return channelsByGuild;
}

async function loadState() {
	const [servers, channels] = await Promise.all([
		Servers.findAll({ raw: true }),
		Channels.findAll({ raw: true }),
	]);
	const validChannels = channels.filter(
		c => c.channelName && /^[a-z0-9_]+$/.test(c.channelName),
	);

	return {
		servers,
		channels: validChannels,
		channelsByGuild: groupChannels(validChannels),
	};
}

function targetChannel(client, chan, server, selfChannelKey) {
	const id = chan.isSelf ?
		server[selfChannelKey] :
		server.affiliateChannelId;

	return {
		id,
		discordChannel: client.channels.cache.get(id),
	};
}

function roleMention(chan, server, selfRoleKey) {
	const roleId = chan.isSelf ?
		server[selfRoleKey] :
		server.affiliateRoleId;

	return roleId ? `<@&${roleId}> ` : ``;
}

async function fetchMessage(discordChannel, messageId) {
	if (!messageId) {
		return null;
	}

	const cachedMessage = discordChannel.messages.cache.get(messageId);

	if (cachedMessage) {
		return cachedMessage;
	}

	try {
		return await discordChannel.messages.fetch(messageId);
	} catch (err) {
		// Only a deleted message is gone for good. A transient Discord error must
		// leave the saved stream state intact so the next poll can retry.
		if (Number(err?.code) === 10008) {
			return null;
		}
		throw err;
	}
}

async function syncMessage({ discordChannel, messageId, shouldEdit, content, embed, onSend }) {
	const existingMessage = await fetchMessage(discordChannel, messageId);

	if (existingMessage && shouldEdit) {
		await existingMessage.edit({ content, embeds: [embed] });
		return existingMessage;
	}

	const message = await discordChannel.send({ content, embeds: [embed] });
	await onSend(message);
	return message;
}

function liveEmbed({
	provider,
	color,
	name,
	title,
	url,
	category,
	viewers,
	thumbnail,
	image,
	discordUrl,
	startedAt,
	discordInline = false,
}) {
	const fields = [
		{
			name: `Playing`,
			value: category,
			inline: true,
		},
		{
			name: `Viewers`,
			value: viewers.toString(),
			inline: true,
		},
		{
			name: provider,
			value: `[Watch stream](${url})`,
		},
	];

	if (discordUrl) {
		fields.push({
			name: `Discord Server`,
			value: `[Join here](${discordUrl})`,
			inline: discordInline,
		});
	}

	const embed = new EmbedBuilder()
		.setTitle(`${name} is now live`)
		.setDescription(title)
		.setURL(url)
		.setColor(color)
		.setFields(fields)
		.setFooter({ text: liveFooter(startedAt) });

	if (thumbnail) {
		embed.setThumbnail(thumbnail);
	}

	if (image) {
		embed.setImage(image);
	}

	return embed;
}

// One embed shape serves the pending, linked, and unavailable replay states.
// Keep the recorded end footer stable as the provider field changes.
function offlineEmbed({ provider, existingEmbed, vodUrl, imageUrl, vodUnavailable = false }) {
	const embed = existingEmbed ?
		EmbedBuilder.from(existingEmbed) :
		new EmbedBuilder();
	const existingFields = existingEmbed?.fields?.length ?
		existingEmbed.fields :
		[{ name: provider, value: `Fetching VoD...` }];
	let vodFieldValue = `Fetching VoD...`;
	if (vodUrl) {
		vodFieldValue = `[Watch VoD](${vodUrl})`;
	} else if (vodUnavailable) {
		vodFieldValue = `No VoD available`;
	}
	const fields = existingFields.map(field => {
		if (field.name === provider) {
			return {
				name: provider,
				value: vodFieldValue,
				inline: field.inline,
			};
		}

		return field;
	});
	if (!fields.some(field => field.name === provider)) {
		fields.push({ name: provider, value: vodFieldValue });
	}
	const title = existingEmbed?.title ?
		existingEmbed.title.replace(`is now live`, `was live`) :
		`${provider} stream was live`;
	const footerText = offlineFooter(existingEmbed);

	embed
		.setTitle(title)
		.setURL(vodUrl || null)
		.setFields(fields)
		.setFooter({ text: footerText })
		.setImage(imageUrl || null);

	return embed;
}

module.exports = {
	fetchMessage,
	formatStreamTime,
	groupChannels,
	liveEmbed,
	loadState,
	offlineEmbed,
	roleMention,
	syncMessage,
	targetChannel,
	vodWaitExpired,
};
