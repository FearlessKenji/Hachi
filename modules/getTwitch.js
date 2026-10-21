// High-level Twitch notification loop.
//
// The Twitch cron calls getTwitch(client). This file loads configured channels,
// batches Twitch API requests, updates live/offline Discord messages, and writes
// new stream state back to the database.
const { Channels } = require(`../database/dbObjects.js`);
const { warn, error } = require(`../utils/writeLog.js`);
const twitchChannel = require(`./twitchChannel.js`);
const { getTwitchUsers } = require(`./twitchIdentity.js`);
const twitchStreams = require(`./twitchStreams.js`);
const twitchVods = require(`./twitchVods.js`);
const { getIdentityMap, recordStreamName } = require(`./streamNameMonitor.js`);
const authTokens = require(`../auth/authTokens.js`);
const {
	fetchMessage,
	liveEmbed,
	loadState,
	offlineEmbed,
	roleMention,
	syncMessage,
	targetChannel,
} = require(`./streamUtils.js`);
const twitchClientId = process.env.twitchClientId;
const provider = `Twitch`;

async function updateVodMessage(chan, server, guild, client, twitchUser) {
	const { twitchAuthToken } = authTokens.getAuthTokens();

	if (!chan.twitchMessageId || !chan.twitchStreamId || !chan.twitchNotif) {
		return;
	}

	const { id: discordChannelId, discordChannel } = targetChannel(client, chan, server, `selfTwitchChannelId`);

	if (!discordChannel) {
		warn(`Twitch VoD update cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}). Channel not found.`);
		return;
	}

	const userId = twitchUser?.id || (await twitchChannel.getChannel(
		chan.channelName,
		twitchClientId,
		twitchAuthToken,
	))?.id;

	if (!userId) {
		return;
	}

	const vod = await twitchVods.getForStream(
		userId,
		chan.twitchStreamId,
		twitchClientId,
		twitchAuthToken,
	);

	if (!vod?.url) {
		return;
	}

	const existingMessage = await fetchMessage(discordChannel, chan.twitchMessageId);

	if (!existingMessage) {
		await Channels.update({ twitchStreamId: null }, { where: { id: chan.id } });
		return;
	}

	const imageUrl = vod.thumbnail_url ?
		vod.thumbnail_url.replace(`%{width}`, `640`).replace(`%{height}`, `360`) :
		null;
	const embed = offlineEmbed({
		provider,
		existingEmbed: existingMessage.embeds[0],
		vodUrl: vod.url,
		imageUrl,
	});

	await existingMessage.edit({
		content: `The Twitch stream has ended.`,
		embeds: [embed],
	});
	await Channels.update({ twitchStreamId: null }, { where: { id: chan.id } });
}

/**
 * Main Twitch monitoring loop
 * - Loads servers + channels
 * - Normalizes channel names once
 * - Groups channels by guild for fast lookup
 * - Fetches Twitch data once globally
 * - Processes Discord updates per server
 */
async function getTwitch(client) {
	const { twitchAuthToken } = authTokens.getAuthTokens();
	const { servers, channels, channelsByGuild } = await loadState();
	const twitchChannels = channels.filter(chan => chan.twitchNotif);
	const identityMap = await getIdentityMap(twitchChannels, `twitch`);
	const twitchUsers = await getTwitchUsers(twitchChannels, identityMap, twitchClientId, twitchAuthToken);
	await Promise.all(twitchChannels.map(async chan => {
		const user = twitchUsers.get(chan.id);
		if (user) {
			try {
				await recordStreamName(chan, `twitch`, user.id, user.login.toLowerCase());
			} catch (err) {
				error(`Failed to record Twitch account identity for ${chan.channelName}:`, err);
			}
		}
	}));

	const loginsByChannel = new Map();
	for (const chan of twitchChannels) {
		const user = twitchUsers.get(chan.id);
		// Once a row is bound to an ID, an unavailable lookup must not make a
		// recycled old login appear to be the same broadcaster.
		if (user || !identityMap.get(chan.id)?.providerUserId) {
			loginsByChannel.set(chan.id, user?.login.toLowerCase() || chan.channelName);
		}
	}

	const channelNames = [...loginsByChannel.values()];
	const streamsData = await twitchStreams.getStreams(
		channelNames,
		twitchClientId,
		twitchAuthToken,
	);

	for (const server of servers) {
		const guild = client.guilds.cache.get(server.guildId);
		const serverChannels = channelsByGuild.get(server.guildId) || [];
		const channelPromises = serverChannels.map(async (chan) => {
			const login = loginsByChannel.get(chan.id);
			if (!login) {
				return;
			}

			const twitchUser = twitchUsers.get(chan.id);
			const streamRecord = streamsData[login];
			const streamInfo = streamRecord?.data;

			if (!streamRecord || streamRecord.error) {
				return;
			}

			if (streamInfo && twitchUser && String(streamInfo.user_id) !== twitchUser.id) {
				warn(`Twitch stream identity did not match configured account for ${chan.channelName}.`);
				return;
			}

			if (!streamInfo) {
				await updateVodMessage(chan, server, guild, client, twitchUser);
				return;
			}

			const { id: discordChannelId, discordChannel } = targetChannel(client, chan, server, `selfTwitchChannelId`);

			if (!discordChannel) {
				warn(`Twitch updates cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}). Channel not found.`);
				return;
			}

			const channel = await twitchChannel.getChannel(
				login,
				twitchClientId,
				twitchAuthToken,
			);

			if (!channel || (twitchUser && String(channel.id) !== twitchUser.id)) {
				return;
			}

			const streamUrl = `https://www.twitch.tv/${channel.broadcaster_login}`;
			const sendEmbed = liveEmbed({
				provider,
				color: 0x9146FF,
				name: channel.display_name,
				title: channel.title,
				url: streamUrl,
				category: channel.game_name,
				viewers: streamInfo.viewer_count,
				thumbnail: channel.thumbnail_url,
				image: `https://static-cdn.jtvnw.net/previews-ttv/live_user_${channel.broadcaster_login}-640x360.jpg?cacheBypass=${Date.now()}`,
				discordUrl: chan.discordUrl,
				startedAt: streamInfo.started_at,
			});
			const roleText = roleMention(chan, server, `selfTwitchRoleId`);
			const content = `${roleText}${channel.display_name} just went live on Twitch streaming ${channel.game_name}!`;

			try {
				await syncMessage({
					discordChannel,
					messageId: chan.twitchMessageId,
					shouldEdit: chan.twitchStreamId === streamInfo.id,
					content,
					embed: sendEmbed,
					onSend: message => Channels.update(
						{ twitchMessageId: message.id, twitchStreamId: streamInfo.id },
						{ where: { id: chan.id } },
					),
				});
			} catch (err) {
				error(`Failed to send/edit Twitch message for ${chan.channelName}:`, err);
			}
		});

		await Promise.allSettled(channelPromises);
	}
}

module.exports = { getTwitch };
