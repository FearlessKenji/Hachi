const { Channels } = require(`../database/dbObjects.js`);
const { warn, error } = require(`../utils/writeLog.js`);
const twitchChannel = require(`./twitchChannel.js`);
const twitchStreams = require(`./twitchStreams.js`);
const twitchVods = require(`./twitchVods.js`);
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

async function updateVodMessage(chan, server, guild, client) {
	const { twitchAuthToken } = authTokens.getAuthTokens();

	if (!chan.twitchMessageId || !chan.twitchStreamId || !chan.twitchNotif) {
		return;
	}

	const { id: discordChannelId, discordChannel } = targetChannel(client, chan, server, `selfTwitchChannelId`);

	if (!discordChannel) {
		warn(`Twitch VoD update cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}). Channel not found.`);
		return;
	}

	const channel = await twitchChannel.getChannel(
		chan.channelName,
		twitchClientId,
		twitchAuthToken,
	);

	if (!channel) {
		return;
	}

	const vod = await twitchVods.getForStream(
		channel.id,
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
	const channelNames = channels.map(c => c.channelName);
	const streamsData = await twitchStreams.getStreams(
		channelNames,
		twitchClientId,
		twitchAuthToken,
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

			if (!streamInfo || !chan.twitchNotif) {
				if (!streamInfo) {
					await updateVodMessage(chan, server, guild, client);
				}

				return;
			}

			const { id: discordChannelId, discordChannel } = targetChannel(client, chan, server, `selfTwitchChannelId`);

			if (!discordChannel) {
				warn(`Twitch updates cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}). Channel not found.`);
				return;
			}

			const channel = await twitchChannel.getChannel(
				chan.channelName,
				twitchClientId,
				twitchAuthToken,
			);

			if (!channel) {
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
