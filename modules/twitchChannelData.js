const { writeLog } = require(`./writeLog`);

async function getData(channelName, clientID, authKey) {
	try {
		const res = await fetch(
			`https://api.twitch.tv/helix/search/channels?query=${channelName}`,
			{
				headers: {
					'Client-ID': clientID,
					'Authorization': `Bearer ${authKey}`,
				},
			},
		);

		if (!res.ok) {
			console.error(writeLog(`Twitch API returned ${res.status}: ${res.statusText}`));
			return false;
		}

		const data = await res.json();
		const channels = data.data || [];

		// Look for exact match (case-insensitive)
		const channel = channels.find(
			c => c.broadcaster_login.toLowerCase() === channelName.toLowerCase(),
		);

		return channel || false;
	} catch (err) {
		console.error(writeLog(`Error fetching Twitch channel data:`, err));
		return false;
	}
}
module.exports = { getData };