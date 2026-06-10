const { error } = require(`../utils/writeLog.js`);

async function getForStream(userId, streamId, clientID, authKey) {
	try {
		const res = await fetch(
			`https://api.twitch.tv/helix/videos?user_id=${userId}&type=archive&first=5`,
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
		return null;
	}
}

module.exports = { getForStream };
