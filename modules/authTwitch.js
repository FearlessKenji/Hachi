const { writeLog } = require(`./writeLog`);

async function getKey(clientID, clientSecret) {
	try {
		const res = await fetch(
			`https://id.twitch.tv/oauth2/token?client_id=${clientID}&client_secret=${clientSecret}&grant_type=client_credentials`,
			{ method: `POST` },
		);

		if (!res.ok) {
			console.error(writeLog(`Twitch OAuth returned ${res.status}: ${res.statusText}`));
			return false;
		}

		const data = await res.json();
		return data.access_token;
	} catch (err) {
		console.error(writeLog(`Error fetching Twitch OAuth token:`, err));
		return false;
	}
}

module.exports = { getKey };
