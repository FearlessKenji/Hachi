const { writeLog } = require(`../utils/writeLog`);

async function getLatestVod(channelName) {
	try {
		const res = await fetch(
			`https://kick.com/api/v1/channels/${channelName}`,
			{
				headers: {
					'Accept': `application/json`,
					'User-Agent': `KenjiB0t`,
				},
			});

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`HTTP ${res.status} - ${text}`);
		}

		const data = await res.json();
		const livestream = data.previous_livestreams?.find(stream => stream.video?.uuid);

		if (!livestream) {
			return null;
		}

		return {
			title: livestream.session_title,
			url: `https://kick.com/${data.slug || channelName}/videos/${livestream.video.uuid}`,
			thumbnail: livestream.thumbnail?.src ||
				(typeof livestream.thumbnail === `string` ? livestream.thumbnail : null) ||
				livestream.video.thumbnail?.src ||
				(typeof livestream.video.thumbnail === `string` ? livestream.video.thumbnail : null),
		};
	} catch (err) {
		console.error(writeLog(`Failed to fetch Kick VOD for ${channelName}:`, err));
		return null;
	}
}

module.exports = { getLatestVod };
