// High-level Kick notification loop.
//
// A channel row tracks its current live announcement. An ended announcement
// moves to PendingStreamVods after its Discord edit, letting later streams use
// new messages while older replays keep retrying until found or timed out.
const { Channels, KickLiveSessions, PendingStreamVods } = require(`../database/dbObjects.js`);
const kickUser = require(`./kickUser.js`);
const kickStreams = require(`./kickStreams.js`);
const kickVods = require(`./kickVods.js`);
const { getChannelsByBroadcasterIds, normalizeBroadcasterId } = require(`./kickIdentity.js`);
const { getIdentityMap, recordStreamName } = require(`./streamNameMonitor.js`);
const authTokens = require(`../auth/authTokens.js`);
const { warn, error } = require(`../utils/writeLog.js`);
const {
	fetchMessage,
	formatStreamTime,
	liveEmbed,
	loadState,
	offlineEmbed,
	roleMention,
	syncMessage,
	targetChannel,
	vodWaitExpired,
} = require(`./streamUtils.js`);
const kickClientId = process.env.kickClientId;
const provider = `Kick`;
const unavailableChannelWarnings = new Set();
const unavailableReplayChannels = new Set();

async function observeKickName(chan, streamInfo) {
	const observedUserId = normalizeBroadcasterId(streamInfo?.broadcaster_user_id);
	if (!observedUserId || typeof streamInfo.slug !== `string` || !streamInfo.slug) {
		return;
	}

	await recordStreamName(chan, `kick`, observedUserId, streamInfo.slug);
}

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

function isEndedKickMessage(message) {
	return message?.content === `The Kick stream has ended.` ||
		message?.embeds?.[0]?.title?.endsWith(`was live`);
}

function getStartLabel(embed) {
	// Pre-upgrade messages retain only the displayed start minute. New messages
	// also keep their exact start in KickLiveSessions for rapid restarts.
	const label = embed?.footer?.text?.match(/^Started (.+?)\. (?:Last edited|Stream ended(?: at)?) /u)?.[1];
	return label && label !== `unknown time` ? label : null;
}

function liveSessionFor(chan, sessionsByChannel) {
	const session = sessionsByChannel.get(chan.id);
	return session?.messageId === chan.kickMessageId ? session : null;
}

async function retireKickLiveSession(chan, liveSession) {
	if (liveSession) {
		await KickLiveSessions.destroy({ where: { channelId: chan.id } });
	}
}

async function queueEndedKickMessage(chan, discordChannelId, existingMessage, kickSlug, providerUserId, liveSession) {
	const existingEmbed = existingMessage.embeds[0];
	const unavailableVod = existingEmbed?.fields?.some(field =>
		field.name === provider && field.value === `No VoD available`);
	if (findKickVodUrl(existingEmbed) || unavailableVod) {
		await Channels.update({ kickIsLive: false }, { where: { id: chan.id } });
		await retireKickLiveSession(chan, liveSession);
		return;
	}
	const startLabel = getStartLabel(existingEmbed);
	const isAwaitingVod = existingEmbed?.fields?.some(field =>
		field.name === provider && field.value === `Fetching VoD...`);
	if (!isAwaitingVod) {
		// Edit before queueing, so a failed Discord edit cannot be mistaken for
		// an announcement that was already marked ended.
		const pendingEmbed = offlineEmbed({ provider, existingEmbed, vodUrl: null });
		await existingMessage.edit({
			content: `The Kick stream has ended.`,
			embeds: [pendingEmbed],
		});
	}

	// Avoid a per-message SQLite transaction when several streams end together.
	await PendingStreamVods.findCreateFind({
		where: { messageId: chan.kickMessageId },
		defaults: {
			channelId: chan.id,
			provider,
			discordChannelId: String(discordChannelId),
			messageId: chan.kickMessageId,
			streamId: null,
			providerUserId: providerUserId || null,
			providerName: kickSlug,
			startLabel,
			providerStartTime: liveSession?.startTime || null,
			endedAt: new Date(),
		},
	});
	await Channels.update({ kickIsLive: false }, { where: { id: chan.id } });
	await retireKickLiveSession(chan, liveSession);
}

// An unresolved channel is not enough evidence to end its announcement.
// Only a resolved offline state can move the message into the replay queue.
async function checkEndedKickMessage(chan, server, guild, client, kickSlug, providerUserId, liveSession) {
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
		await retireKickLiveSession(chan, liveSession);
		return;
	}

	const existingVodUrl = findKickVodUrl(existingMessage.embeds[0]);
	const unavailableVod = existingMessage.embeds[0]?.fields?.some(field =>
		field.name === provider && field.value === `No VoD available`);

	if (existingVodUrl || unavailableVod) {
		await Channels.update({ kickIsLive: false }, { where: { id: chan.id } });
		await retireKickLiveSession(chan, liveSession);
		return;
	}
	if (!kickSlug) {
		// Keep the live state until the account can be resolved again.
		return;
	}

	await queueEndedKickMessage(chan, discordChannelId, existingMessage, kickSlug, providerUserId, liveSession);
}

async function processPendingKickVods(client, channelsById) {
	// Queue rows belong to Discord messages, not the current channel session.
	// Process them even when the same broadcaster has already gone live again.
	let pendingRows;
	try {
		pendingRows = await PendingStreamVods.findAll({ where: { provider } });
	} catch (err) {
		error(`Failed to load pending Kick replay updates:`, err);
		return;
	}

	const replayLookups = new Map();
	for (const pending of pendingRows) {
		try {
			let discordChannel = client.channels?.cache?.get(pending.discordChannelId);
			if (!discordChannel && typeof client.channels?.fetch === `function`) {
				try {
					discordChannel = await client.channels.fetch(pending.discordChannelId);
				} catch {
					// The channel may only be temporarily inaccessible; retain the row.
				}
			}
			if (!discordChannel) {
				if (!unavailableReplayChannels.has(pending.discordChannelId)) {
					warn(`Kick replay update cannot find Discord channel ${pending.discordChannelId}.`);
					unavailableReplayChannels.add(pending.discordChannelId);
				}
				continue;
			}
			unavailableReplayChannels.delete(pending.discordChannelId);

			const message = await fetchMessage(discordChannel, pending.messageId);
			const replayField = message?.embeds[0]?.fields?.find(field => field.name === provider)?.value;
			if (!message || findKickVodUrl(message.embeds[0]) || replayField === `No VoD available`) {
				await pending.destroy();
				continue;
			}

			const currentName = channelsById.get(normalizeBroadcasterId(pending.providerUserId))?.slug;
			const slug = currentName || pending.providerName;
			if (!slug) {
				// No provider response means there is no evidence to apply the cutoff.
				continue;
			}
			// Several guilds can announce the same stream; share one replay lookup
			// for their matching pending messages during this cron tick.
			const lookupKey = JSON.stringify([slug, pending.providerStartTime || pending.startLabel]);
			if (!replayLookups.has(lookupKey)) {
				replayLookups.set(lookupKey, await kickVods.getLatest(
					slug, pending.startLabel, pending.providerStartTime,
				));
			}
			const vod = replayLookups.get(lookupKey);
			if (vod?.retryable) {
				// A failed request cannot establish that no replay was published.
				continue;
			}
			if (!vod?.url) {
				if (vodWaitExpired(pending.endedAt)) {
					// Give the provider a final chance on the cutoff poll before ending retries.
					const embed = offlineEmbed({ provider, existingEmbed: message.embeds[0], vodUnavailable: true });
					await message.edit({ content: `The Kick stream has ended.`, embeds: [embed] });
					await pending.destroy();
				}
				continue;
			}

			const embed = offlineEmbed({
				provider,
				existingEmbed: message.embeds[0],
				vodUrl: vod.url,
				imageUrl: vod.thumbnail,
			});
			await message.edit({
				content: `The Kick stream has ended.`,
				embeds: [embed],
			});
			await pending.destroy();
		} catch (err) {
			error(`Failed to update pending Kick replay for message ${pending.messageId}:`, err);
		}
	}
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
	const [streamState, liveSessions] = await Promise.all([
		loadState(),
		KickLiveSessions.findAll({ raw: true }),
	]);
	const { servers, channels, channelsByGuild } = streamState;
	const sessionsByChannel = new Map(liveSessions.map(session => [session.channelId, session]));
	const identityMap = await getIdentityMap(channels, `kick`);
	const channelNames = channels
		.filter(c => c.kickNotif && !identityMap.get(c.id)?.providerUserId)
		.map(c => c.channelName);
	const [streamsData, channelsById] = await Promise.all([
		kickStreams.getStreams(channelNames, kickClientId, kickAuthToken),
		getChannelsByBroadcasterIds(
			channels.filter(c => c.kickNotif).map(c => identityMap.get(c.id)?.providerUserId),
			kickClientId,
			kickAuthToken,
		),
	]);
	const serversByGuildId = new Map(servers.map(server => [server.guildId, server]));
	const resolvedChannels = new Map();
	const liveBroadcasterIds = new Set();
	for (const chan of channels) {
		if (!chan.kickNotif) {
			continue;
		}
		const savedUserId = normalizeBroadcasterId(identityMap.get(chan.id)?.providerUserId);
		const streamRecord = streamsData[chan.channelName];
		const slugInfo = streamRecord?.data;
		// A bound row may use its old slug only when that response has the
		// same broadcaster ID; a recycled slug must not change its identity.
		const streamInfo = savedUserId ?
			(channelsById.get(savedUserId) ||
				(normalizeBroadcasterId(slugInfo?.broadcaster_user_id) === savedUserId ? slugInfo : null)) :
			slugInfo;
		resolvedChannels.set(chan.id, { savedUserId, streamRecord, streamInfo });
		const server = serversByGuildId.get(chan.guildId);
		if (streamInfo?.stream?.is_live && server &&
			targetChannel(client, chan, server, `selfKickChannelId`).discordChannel) {
			const liveUserId = normalizeBroadcasterId(streamInfo.broadcaster_user_id);
			if (liveUserId) {
				liveBroadcasterIds.add(liveUserId);
			}
		}
	}
	// Profiles are shared across servers during this poll, including when the
	// same broadcaster has an announcement in more than one guild.
	const usersByIdPromise = liveBroadcasterIds.size ?
		kickUser.getUsersByIds([...liveBroadcasterIds], kickClientId, kickAuthToken)
			.catch(err => {
				error(`Failed to fetch Kick user profiles:`, err);
				return new Map();
			}) :
		Promise.resolve(new Map());

	for (const server of servers) {
		const guild = client.guilds.cache.get(server.guildId);
		const serverChannels = channelsByGuild.get(server.guildId) || [];
		const channelPromises = serverChannels.map(async (chan) => {
			if (!chan.kickNotif) {
				return;
			}

			const { savedUserId, streamRecord, streamInfo } = resolvedChannels.get(chan.id);
			try {
				await observeKickName(chan, streamInfo);
			} catch (err) {
				error(`Failed to record Kick channel name for ${chan.channelName}:`, err);
			}

			if (!savedUserId && (!streamRecord || streamRecord.error)) {
				return;
			}

			if (!streamInfo) {
				// An unresolved account is not evidence that a tracked stream ended.
				// Inspect the existing notification without starting a new VoD lookup.
				if (!unavailableChannelWarnings.has(chan.id)) {
					warn(`Kick could not resolve saved entry ${chan.channelName}. If its name changed before Hachi recorded its ID, remove the stale entry and add the current name.`);
					unavailableChannelWarnings.add(chan.id);
				}
				if (chan.kickIsLive) {
					try {
						await checkEndedKickMessage(
							chan, server, guild, client, null, null, liveSessionFor(chan, sessionsByChannel),
						);
					} catch (err) {
						error(`Failed to check ended Kick message for ${chan.channelName}:`, err);
					}
				}
				return;
			}

			unavailableChannelWarnings.delete(chan.id);

			if (!streamInfo.stream?.is_live) {
				if (chan.kickIsLive) {
					try {
						await checkEndedKickMessage(
							chan,
							server,
							guild,
							client,
							streamInfo.slug || (!savedUserId && chan.channelName),
							savedUserId || normalizeBroadcasterId(streamInfo.broadcaster_user_id),
							liveSessionFor(chan, sessionsByChannel),
						);
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

			const broadcasterId = normalizeBroadcasterId(streamInfo.broadcaster_user_id);
			if (!broadcasterId || typeof streamInfo.slug !== `string` || !streamInfo.slug) {
				return;
			}
			const user = (await usersByIdPromise).get(broadcasterId);
			// The channel lookup already established the broadcaster's ID and live
			// status. A missing profile must not suppress its announcement.
			const displayName = user?.name || streamInfo.slug;

			const streamUrl = `https://www.kick.com/${streamInfo.slug}`;
			const sendEmbed = liveEmbed({
				provider,
				color: 0x00E701,
				name: displayName,
				title: streamInfo.stream_title,
				url: streamUrl,
				category: streamInfo.category.name,
				viewers: streamInfo.stream.viewer_count,
				thumbnail: user?.profile_picture,
				image: `${streamInfo.stream.thumbnail}?cacheBypass=${Date.now()}`,
				discordUrl: chan.discordUrl,
				startedAt: streamInfo.stream.start_time,
				discordInline: true,
			});
			const roleText = roleMention(chan, server, `selfKickRoleId`);
			const content = `${roleText}${displayName} just went live on Kick streaming ${streamInfo.category.name}!`;

			try {
				const previousMessage = chan.kickIsLive ?
					await fetchMessage(discordChannel, chan.kickMessageId) :
					null;
				const liveSession = liveSessionFor(chan, sessionsByChannel);
				const currentExactStart = kickVods.parseKickStartTime(streamInfo.stream.start_time);
				const previousStart = getStartLabel(previousMessage?.embeds[0]);
				const currentStart = formatStreamTime(streamInfo.stream.start_time);
				const isNewStream = liveSession && currentExactStart ?
					new Date(liveSession.startTime).getTime() !== currentExactStart.getTime() :
					Boolean(previousStart && currentStart !== `unknown time` && previousStart !== currentStart);
				const previousEnded = isEndedKickMessage(previousMessage);
				if (previousMessage && (isNewStream || previousEnded)) {
					// A new stream can begin between polls. Queue the old replay before
					// replacing the tracked live message ID with the new announcement.
					await queueEndedKickMessage(
						chan,
						discordChannelId,
						previousMessage,
						streamInfo.slug || chan.channelName,
						savedUserId || normalizeBroadcasterId(streamInfo.broadcaster_user_id),
						liveSession,
					);
				}
				const syncedMessage = await syncMessage({
					discordChannel,
					messageId: chan.kickMessageId,
					shouldEdit: chan.kickIsLive && !isNewStream && !previousEnded,
					content,
					embed: sendEmbed,
					onSend: message => Channels.update(
						{ kickMessageId: message.id, kickIsLive: true },
						{ where: { id: chan.id } },
					),
				});
				const sessionMatchesMessage = liveSession && syncedMessage?.id &&
					liveSession.messageId === syncedMessage.id &&
					new Date(liveSession.startTime).getTime() === currentExactStart?.getTime();
				if (currentExactStart && syncedMessage?.id && !sessionMatchesMessage) {
					// The exact start survives bot restarts; the embed footer alone cannot
					// distinguish two sessions that began in the same minute. Write only
					// when the announcement changes to avoid SQLite churn each poll.
					await KickLiveSessions.upsert({
						channelId: chan.id,
						messageId: syncedMessage.id,
						startTime: currentExactStart,
					});
				}
			} catch (err) {
				error(`Failed to send/edit kick message for ${chan.channelName}:`, err);
			}
		});

		const channelResults = await Promise.allSettled(channelPromises);
		for (const [index, result] of channelResults.entries()) {
			if (result.status === `rejected`) {
				const channel = serverChannels[index];
				error(`Failed to process Kick channel ${channel.channelName} (row ${channel.id}) in guild ${server.guildId}:`, result.reason);
			}
		}
	}

	await processPendingKickVods(client, channelsById);
}

module.exports = {
	findKickVodUrl,
	getKick,
};
