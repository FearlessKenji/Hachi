// Twitch VoD API client.
//
// After a stream ends, Hachi tries to find the VoD for the stream ID so the
// original live message can be edited with a replay link.
const { error } = require(`../utils/writeLog.js`);
const { fetchProviderApi } = require(`./providerFetch.js`);

async function getForStream(userId, streamId, clientID, authKey) {
	try {
		// A delayed archive may appear after several newer streams. Search the
		// largest single page Twitch permits before giving up until the next poll.
		const res = await fetchProviderApi(
			`https://api.twitch.tv/helix/videos?user_id=${userId}&type=archive&first=100`,
			{
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

		return videos.find(video => video.stream_id === streamId) || null;
	} catch (err) {
		error(`Failed to fetch Twitch VOD for stream ${streamId}:`, err);
		// An API failure cannot confirm that a replay is absent at the cutoff.
		return { retryable: true, url: null };
	}
}

module.exports = { getForStream };
