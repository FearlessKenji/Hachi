// High-level Kick notification loop.
//
// The Kick cron calls getKick(client). This file mirrors the Twitch flow: load
// configured channels, batch provider calls, update Discord messages, and persist
// live/offline state.
const { Channels } = require(`../database/dbObjects.js`);
const kickUser = require(`./kickUser.js`);
const kickStreams = require(`./kickStreams.js`);
const kickVods = require(`./kickVods.js`);
const authTokens = require(`../auth/authTokens.js`);
const { warn, error } = require(`../utils/writeLog.js`);
const {
	fetchMessage,
	liveEmbed,
	loadState,
	offlineEmbed,
	roleMention,
	syncMessage,
	targetChannel,
} = require(`./streamUtils.js`);
const kickClientId = process.env.kickClientId;
const provider = `Kick`;

function findKickVodUrl(embed) {
	const candidates = [
		embed?.url,
		...(embed?.fields || []).map(field => field.value),
	].filter(Boolean);
	const match = candidates
		.map(value => String(value).match(/https?:\/\/(?:www\.)?kick\.com\/[^\s)\]]+\/videos\/[A-Za-z0-9_-]+/iu)?.[0])
		.find(Boolean);

	return match || null;
}

async function updateVodMessage(chan, server, guild, client) {
	if (!chan.kickMessageId || !chan.kickIsLive || !chan.kickNotif) {
		return;
	}

	const { id: discordChannelId, discordChannel } = targetChannel(client, chan, server, `selfKickChannelId`);

	if (!discordChannel) {
		warn(`Kick VoD update cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}). Channel not found.`);
		return;
	}

	const existingMessage = await fetchMessage(discordChannel, chan.kickMessageId);

	if (!existingMessage) {
		await Channels.update({ kickIsLive: false }, { where: { id: chan.id } });
		return;
	}

	const existingVodUrl = findKickVodUrl(existingMessage.embeds[0]);

	if (existingVodUrl) {
		await Channels.update({ kickIsLive: false }, { where: { id: chan.id } });
		return;
	}

	const vod = await kickVods.getLatest(chan.channelName);

	if (!vod?.url) {
		// Keep kickIsLive true so the next Kick cron tick retries until Kick
		// exposes a replay URL. The live embed should only become an ended embed
		// when Hachi can include a real VoD link.
		return;
	}

	const embed = offlineEmbed({
		provider,
		existingEmbed: existingMessage.embeds[0],
		vodUrl: vod.url,
		imageUrl: vod.thumbnail,
	});

	await existingMessage.edit({
		content: `The Kick stream has ended.`,
		embeds: [embed],
	});
	await Channels.update({ kickIsLive: false }, { where: { id: chan.id } });
}

/**
 * Main Kick monitoring loop
 * - Loads servers + channels
 * - Normalizes channel names once
 * - Groups channels by guild for fast lookup
 * - Fetches Kick data once globally
 * - Processes Discord updates per server
 */
async function getKick(client) {
	const { kickAuthToken } = authTokens.getAuthTokens();
	const { servers, channels, channelsByGuild } = await loadState();
	const channelNames = channels.map(c => c.channelName);
	const streamsData = await kickStreams.getStreams(
		channelNames,
		kickClientId,
		kickAuthToken,
	);

	for (const server of servers) {
		const guild = client.guilds.cache.get(server.guildId);
		const serverChannels = channelsByGuild.get(server.guildId) || [];
		const channelPromises = serverChannels.map(async (chan) => {
			const streamRecord = streamsData[chan.channelName];
			const streamInfo = streamRecord?.data;

			if (!streamRecord || streamRecord.error) {
				return;
			}

			if (!chan.kickNotif) {
				return;
			}

			if (!streamInfo?.stream?.is_live) {
				if (chan.kickIsLive) {
					try {
						await updateVodMessage(chan, server, guild, client);
					} catch (err) {
						error(`Failed to update ended Kick message for ${chan.channelName}:`, err);
					}
				}

				return;
			}

			const { id: discordChannelId, discordChannel } = targetChannel(client, chan, server, `selfKickChannelId`);

			if (!discordChannel) {
				warn(`Kick updates cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}). Channel not found.`);
				return;
			}

			const user = await kickUser.getUser(
				streamInfo.broadcaster_user_id,
				chan.channelName,
				kickClientId,
				kickAuthToken,
			);

			if (!user) {
				return;
			}

			const streamUrl = `https://www.kick.com/${streamInfo.slug}`;
			const sendEmbed = liveEmbed({
				provider,
				color: 0x00E701,
				name: user.name,
				title: streamInfo.stream_title,
				url: streamUrl,
				category: streamInfo.category.name,
				viewers: streamInfo.stream.viewer_count,
				thumbnail: user.profile_picture,
				image: `${streamInfo.stream.thumbnail}?cacheBypass=${Date.now()}`,
				discordUrl: chan.discordUrl,
				startedAt: streamInfo.stream.start_time,
				discordInline: true,
			});
			const roleText = roleMention(chan, server, `selfKickRoleId`);
			const content = `${roleText}${user.name} just went live on Kick streaming ${streamInfo.category.name}!`;

			try {
				await syncMessage({
					discordChannel,
					messageId: chan.kickMessageId,
					shouldEdit: chan.kickIsLive,
					content,
					embed: sendEmbed,
					onSend: message => Channels.update(
						{ kickMessageId: message.id, kickIsLive: true },
						{ where: { id: chan.id } },
					),
				});
			} catch (err) {
				error(`Failed to send/edit kick message for ${chan.channelName}:`, err);
			}
		});

		await Promise.allSettled(channelPromises);
	}
}

module.exports = {
	findKickVodUrl,
	getKick,
};
