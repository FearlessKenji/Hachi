const { warn, error } = require(`../utils/writeLog.js`);

async function getData(channelName, clientID, authKey) {
	try {
		const res = await fetch(
			`https://api.kick.com/public/v1/channels?slug=${channelName}`,
			{
				headers: {
					'Client-ID': clientID,
					'Authorization': `Bearer ${authKey}`,
				},
			},
		);

		if (!res.ok) {
			warn(`Kick API returned ${res.status}: ${res.statusText}`);
			return false;
		}

		const data = await res.json();
		const channels = data.data || [];

		// Look for exact match (case-insensitive)
		const channel = channels.find(
			c => c.slug.toLowerCase() === channelName.toLowerCase(),
		);

		return channel || false;
	} catch (err) {
		error(`Error fetching Kick channel data:`, err);
		return false;
	}
}
module.exports = { getData };
