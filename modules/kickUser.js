// Kick user lookup API client.
//
// Hachi stores streamer names, but some Kick endpoints need the provider user
// object. This helper isolates that lookup and failure logging.
const { error } = require(`../utils/writeLog.js`);

async function getUser(id, user, clientID, authKey) {
	try {
		const res = await fetch(
			`https://api.kick.com/public/v1/users?id=${id}`,
			{
				headers: {
					'Client-ID': clientID,
					'Authorization': `Bearer ${authKey}`,
				},
			},
		);

		if (!res.ok) {
			error(`Kick API returned ${res.status}: ${res.statusText}`);
			return false;
		}

		const data = await res.json();
		const channels = data.data || [];

		// Look for exact match (case-insensitive)
		const channel = channels.find(
			c => c.user_id === id,
		);

		return channel || false;
	} catch (err) {
		error(`Error fetching Kick user data for ${user}:`, err);
		return false;
	}
}
module.exports = { getUser };
