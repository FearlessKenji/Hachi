const { writeLog } = require(`./writeLog`);

async function getChannelData(mode, channel, clientID, authKey) {
	// mode: true for Twitch, false for Kick
	try {
		const res = await fetch(mode
			? `https://api.twitch.tv/helix/search/channels?query=${channel}`
			: `https://api.kick.com/public/v1/users?id=${channel}`,
		{
			headers: {
				'Client-ID': clientID,
				'Authorization': `Bearer ${authKey}`,
			},
		},
		);

		if (!res.ok) {
			console.error(writeLog(`${mode ? `Twitch` : `Kick`} API returned ${res.status}: ${res.statusText}`));
			return false;
		}

		const data = await res.json();
		const channels = data.data || [];

		// Look for exact match (case-insensitive)
		const channelData = channels.find(mode
			? c => c.broadcaster_login.toLowerCase() === channel.toLowerCase()
			: c => c.user_id === channel,
		);

		return channelData || false;
	}
	catch (err) {
		console.error(writeLog(`Error fetching ${mode ? `Twitch` : `Kick`} channel data:`, err));
		return false;
	}
}
module.exports = { getChannelData };