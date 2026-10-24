// High-level Twitch notification loop.
//
// A channel row tracks its current live announcement. When that stream ends,
// Hachi edits the message immediately and moves its replay lookup into
// PendingStreamVods. Each cron tick retries those saved messages independently,
// so a new broadcast cannot replace an older pending replay.
const { Channels, PendingStreamVods } = require(`../database/dbObjects.js`);
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
	vodWaitExpired,
} = require(`./streamUtils.js`);
const twitchClientId = process.env.twitchClientId;
const provider = `Twitch`;
const endedContent = `The Twitch stream has ended.`;

function hasCompletedTwitchVod(message) {
	return message?.content === endedContent && message.embeds?.[0]?.fields?.some(field =>
		field.name === provider && field.value?.startsWith(`[Watch VoD](`));
}

// First end the visible announcement, then persist its stream ID for later
// replay lookup. Clear the channel's live ID only after the queue write succeeds.
async function queueEndedTwitchMessage(chan, server, guild, client, twitchUser, twitchIdentity) {
	if (!chan.twitchMessageId || !chan.twitchStreamId || !chan.twitchNotif) {
		return;
	}

	const { id: discordChannelId, discordChannel } = targetChannel(client, chan, server, `selfTwitchChannelId`);

	if (!discordChannel) {
		warn(`Twitch VoD update cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}). Channel not found.`);
		return;
	}

	try {
		const existingMessage = discordChannel.messages.cache.get(chan.twitchMessageId) ||
			await discordChannel.messages.fetch(chan.twitchMessageId);
		const existingEmbed = existingMessage.embeds[0];
		if (hasCompletedTwitchVod(existingMessage)) {
			await Channels.update({ twitchStreamId: null }, { where: { id: chan.id } });
			return;
		}

		// Mark the stream ended before asking Twitch for its archive. A missing or
		// delayed VoD must not leave the Discord announcement claiming it is live.
		if (existingMessage.content !== endedContent || !existingEmbed?.title?.endsWith(`was live`)) {
			const pendingEmbed = offlineEmbed({ provider, existingEmbed });
			await existingMessage.edit({ content: endedContent, embeds: [pendingEmbed] });
		}

		const startLabel = /^Started (.+?)\. (?:Last edited|Stream ended)/u
			.exec(existingEmbed?.footer?.text || ``)?.[1] || null;
		await PendingStreamVods.findCreateFind({
			where: { messageId: chan.twitchMessageId },
			defaults: {
				channelId: chan.id,
				provider,
				discordChannelId,
				messageId: chan.twitchMessageId,
				streamId: chan.twitchStreamId,
				providerUserId: twitchUser?.id || twitchIdentity?.providerUserId || null,
				providerName: twitchUser?.login || twitchIdentity?.currentName || chan.channelName,
				startLabel,
				endedAt: new Date(),
			},
		});
		// The queue now owns replay lookup for this announcement. Free the
		// channel row so a subsequent live session can get a new message.
		await Channels.update({ twitchStreamId: null }, { where: { id: chan.id } });
	} catch (err) {
		// Only a confirmed deleted message ends retries. Permission and network
		// failures must keep the saved stream ID for the next poll.
		if (Number(err?.code) === 10008) {
			await Channels.update({ twitchStreamId: null }, { where: { id: chan.id } });
			return;
		}
		throw err;
	}
}

async function finishUnavailableTwitchVod(pending, existingMessage) {
	// A six-hour wait is measured from the first confirmed offline edit. Keep its
	// footer timestamp while replacing the pending label and retiring the row.
	const embed = offlineEmbed({
		provider,
		existingEmbed: existingMessage.embeds[0],
		vodUnavailable: true,
	});
	await existingMessage.edit({ content: endedContent, embeds: [embed] });
	await PendingStreamVods.destroy({ where: { id: pending.id } });
}

async function processPendingTwitchVod(pending, client, twitchAuthToken, vodLookups) {
	try {
		const discordChannel = client.channels.cache.get(pending.discordChannelId) ||
			await client.channels.fetch(pending.discordChannelId);
		if (!discordChannel) {
			throw new Error(`Discord channel ${pending.discordChannelId} is unavailable.`);
		}

		const existingMessage = await fetchMessage(discordChannel, pending.messageId);
		if (!existingMessage) {
			await PendingStreamVods.destroy({ where: { id: pending.id } });
			return;
		}
		const replayField = existingMessage.embeds[0]?.fields?.find(field => field.name === provider)?.value;
		if (hasCompletedTwitchVod(existingMessage) || replayField === `No VoD available`) {
			await PendingStreamVods.destroy({ where: { id: pending.id } });
			return;
		}

		const userId = pending.providerUserId ||
			(await twitchChannel.getChannel(
				pending.providerName,
				twitchClientId,
				twitchAuthToken,
			))?.id;
		if (!userId || !pending.streamId) {
			// Without a stable stream lookup, absence cannot be confirmed.
			return;
		}

		// Several guilds can await the same broadcaster's archive. Share one
		// lookup per stream per poll so retries do not multiply Twitch requests.
		const vodKey = `${userId}:${pending.streamId}`;
		if (!vodLookups.has(vodKey)) {
			vodLookups.set(vodKey, twitchVods.getForStream(
				userId,
				pending.streamId,
				twitchClientId,
				twitchAuthToken,
			));
		}
		const vod = await vodLookups.get(vodKey);
		if (vod?.retryable) {
			return;
		}
		if (!vod?.url) {
			if (vodWaitExpired(pending.endedAt)) {
				await finishUnavailableTwitchVod(pending, existingMessage);
			}
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
		await existingMessage.edit({ content: endedContent, embeds: [embed] });
		await PendingStreamVods.destroy({ where: { id: pending.id } });
	} catch (err) {
		if (Number(err?.code) === 10008) {
			await PendingStreamVods.destroy({ where: { id: pending.id } });
			return;
		}
		error(`Failed to update pending Twitch VoD message ${pending.messageId}:`, err);
	}
}

async function processPendingTwitchVods(client, twitchAuthToken) {
	// Include rows from older streams even if their channel is live again.
	const pendingVods = await PendingStreamVods.findAll({ where: { provider }, raw: true });
	const vodLookups = new Map();
	await Promise.all(pendingVods.map(pending =>
		processPendingTwitchVod(pending, client, twitchAuthToken, vodLookups)));
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
				try {
					await queueEndedTwitchMessage(chan, server, guild, client, twitchUser, identityMap.get(chan.id));
				} catch (err) {
					error(`Failed to update ended Twitch message for ${chan.channelName}:`, err);
				}
				return;
			}
			if (chan.twitchStreamId && chan.twitchStreamId !== streamInfo.id) {
				// A stream can end and restart between polls. Save the prior message
				// for replay retries before replacing this channel's tracked stream.
				try {
					await queueEndedTwitchMessage(chan, server, guild, client, twitchUser, identityMap.get(chan.id));
				} catch (err) {
					error(`Failed to end previous Twitch message for ${chan.channelName}:`, err);
					return;
				}
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

	await processPendingTwitchVods(client, twitchAuthToken);
}

module.exports = { getTwitch };
