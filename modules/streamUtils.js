const { EmbedBuilder } = require(`discord.js`);
const { Servers, Channels } = require(`../database/dbObjects.js`);
const { error } = require(`../utils/writeLog.js`);

const STREAM_TIME_ZONE = `America/New_York`;

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
	const endTime = formatStreamTime(new Date());

	if (!existingEmbed?.footer?.text) {
		return `Stream ended ${endTime}.`;
	}

	return existingEmbed.footer.text.replace(
		/(?:Last edited|Stream ended) .*\.$/,
		`Stream ended ${endTime}.`,
	);
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

	return discordChannel.messages.fetch(messageId).catch(() => null);
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

function offlineEmbed({ provider, existingEmbed, vodUrl, imageUrl }) {
	const embed = existingEmbed ?
		EmbedBuilder.from(existingEmbed) :
		new EmbedBuilder();
	const existingFields = existingEmbed?.fields?.length ?
		existingEmbed.fields :
		[
			{
				name: provider,
				value: `[Watch VoD](${vodUrl})`,
			},
		];
	const fields = existingFields.map(field => {
		if (field.name === provider) {
			return {
				name: provider,
				value: `[Watch VoD](${vodUrl})`,
				inline: field.inline,
			};
		}

		return field;
	});
	const title = existingEmbed?.title ?
		existingEmbed.title.replace(`is now live`, `was live`) :
		`${provider} stream was live`;
	const footerText = offlineFooter(existingEmbed);

	embed
		.setTitle(title)
		.setURL(vodUrl)
		.setFields(fields)
		.setFooter({ text: footerText });

	if (imageUrl) {
		embed.setImage(imageUrl);
	}

	return embed;
}

async function fetchBatch({ names, provider, urlFor, headers, pickData }) {
	const uniqueNames = [...new Set(names)];
	const results = await Promise.all(
		uniqueNames.map(async (name) => {
			try {
				const res = await fetch(urlFor(name), { headers });

				if (!res.ok) {
					const text = await res.text();
					throw new Error(`HTTP ${res.status} - ${text}`);
				}

				const data = await res.json();
				return { name, data: pickData(data) ?? null, error: false };
			} catch (err) {
				error(`Failed to fetch ${provider} data for ${name}:`, err);
				return { name, data: null, error: true };
			}
		}),
	);

	return Object.fromEntries(results.map(result => [result.name, result]));
}

module.exports = {
	fetchBatch,
	fetchMessage,
	groupChannels,
	liveEmbed,
	loadState,
	offlineEmbed,
	roleMention,
	syncMessage,
	targetChannel,
};
