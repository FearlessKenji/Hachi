const { writeLog } = require(`./writeLog`);

async function getAuthKey(mode, clientID, clientSecret) {
	// mode: true for Twitch, false for Kick
	try {
		const res = await fetch(mode
			? `https://id.twitch.tv/oauth2/token?client_id=${clientID}&client_secret=${clientSecret}&grant_type=client_credentials`
			: `https://id.kick.com/oauth/token?client_id=${clientID}&client_secret=${clientSecret}&grant_type=client_credentials`,
		{ method: `POST` },
		);

		if (!res.ok) {
			mode
				? console.error(writeLog(`Twitch OAuth returned ${res.status}: ${res.statusText}`))
				: console.error(writeLog(`Kick OAuth returned ${res.status}: ${res.statusText}`));
			return false;
		}

		const data = await res.json();
		return data.access_token;
	}
	catch (err) {
		mode
			? console.error(writeLog(`Error fetching Twitch OAuth token:`, err))
			: console.error(writeLog(`Error fetching Kick OAuth token:`, err));
		return false;
	}
}

module.exports = { getAuthKey };
