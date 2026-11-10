// Twitch VoD API client.
//
// After a stream ends, Hachi tries to find the VoD for the stream ID so the
// original live message can be edited with a replay link.
const { error, info } = require(`../utils/writeLog.js`);
const { fetchProviderApi } = require(`./providerFetch.js`);
const REPLAY_ERROR_REPEAT_MS = 30 * 60 * 1000;
const MAX_REPLAY_ERROR_KEYS = 200;
const replayFailures = new Map();

function logReplayFailure(lookupKey, streamId, err) {
	const now = Date.now();
	const previous = replayFailures.get(lookupKey);
	if (previous && now - previous.lastLoggedAt < REPLAY_ERROR_REPEAT_MS) {
		previous.suppressedCount++;
		return;
	}

	const repeats = previous?.suppressedCount ? ` (${previous.suppressedCount} repeated failure(s) suppressed)` : ``;
	error(`Failed to fetch Twitch VOD for stream ${streamId}${repeats}:`, err);
	// Refresh insertion order for a bounded cache of currently failing lookups.
	replayFailures.delete(lookupKey);
	replayFailures.set(lookupKey, { lastLoggedAt: now, suppressedCount: 0 });
	if (replayFailures.size > MAX_REPLAY_ERROR_KEYS) {
		replayFailures.delete(replayFailures.keys().next().value);
	}
}

function logReplayRecovery(lookupKey, streamId) {
	if (!replayFailures.has(lookupKey)) {
		return;
	}
	replayFailures.delete(lookupKey);
	info(`Twitch VOD lookup recovered for stream ${streamId}.`);
}

async function getForStream(userId, streamId, clientID, authKey) {
	const lookupKey = `${userId}:${streamId}`;
	try {
		// A delayed archive may appear after several newer streams. Search the
		// largest single page Twitch permits before giving up until the next poll.
		const res = await fetchProviderApi(
			`https://api.twitch.tv/helix/videos?user_id=${userId}&type=archive&first=100`,
			{
				appTokenProvider: `Twitch`,
				headers: {
					'Client-ID': clientID,
					'Authorization': `Bearer ${authKey}`,
				},
			});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`HTTP ${res.status} - ${text}`);
		}

		const data = await res.json();
		const videos = data.data || [];
		const matchingVideo = videos.find(video => video.stream_id === streamId) || null;
		logReplayRecovery(lookupKey, streamId);

		return matchingVideo;
	} catch (err) {
		logReplayFailure(lookupKey, streamId, err);
		// An API failure cannot confirm that a replay is absent at the cutoff.
		return { retryable: true, url: null };
	}
}

module.exports = { getForStream };
