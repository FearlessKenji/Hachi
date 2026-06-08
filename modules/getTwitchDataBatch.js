const { info, warn, error } = require(`../utils/writeLog.js`);

async function getTwitchDataBatch(channelNames, clientID, authKey) {
	const uniqueNames = [...new Set(channelNames)];
	const results = await Promise.all(
		uniqueNames.map(async (name) => {
			try {
				const res = await fetch(
					`https://api.twitch.tv/helix/streams?user_login=${name}`,
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
				return { name, data: data.data[0] ?? null, error: false };
			} catch (err) {
				error(`Failed to fetch Twitch data for ${name}:`, err);
				return { name, data: null, error: true };
			}
		}),
	);

	return Object.fromEntries(results.map(r => [r.name, r]));
}

module.exports = { getTwitchDataBatch };
