const { writeLog } = require(`./writeLog.js`);
/**
 * Fetch stream info for multiple channels in parallel.
 * Only fetches once per unique username.
 */
async function getDataBatch(mode, channelNames, clientID, authKey) {
	const uniqueNames = [...new Set(channelNames)];
	const results = await Promise.all(
		uniqueNames.map(async (name) => {
			try {
				const res = await fetch(mode
					? `https://api.twitch.tv/helix/streams?user_login=${name}`
					: `https://api.kick.com/public/v1/channels?slug=${name}`,
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
				return { name, data: data.data[0] ?? null }; // null if offline
			}
			catch (err) {
				console.error(writeLog(`Failed to fetch ${mode ? `Twitch` : `Kick`} batched data:`, err));
				return { name, data: null };
			}
		}),
	);

	// IMPORTANT: normalize into lookup object for O(1)
	return Object.fromEntries(results.map(r => [r.name, r.data]));
}
module.exports = { getDataBatch };