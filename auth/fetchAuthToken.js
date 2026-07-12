// Provider app-token requester.
//
// Twitch and Kick both expose OAuth client-credentials flows. This helper keeps
// the HTTP shape and error logging in one place so refreshAuthTokens.js can
// request tokens without duplicating provider plumbing.
const { warn, error } = require(`../utils/writeLog`);

async function fetchAuthToken({ provider, tokenUrl, clientID, clientSecret }) {
	try {
		const query = `client_id=${encodeURIComponent(clientID)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`;
		const res = await fetch(
			`${tokenUrl}?${query}`,
			{ method: `POST` },
		);

		if (!res.ok) {
			warn(`${provider} OAuth returned ${res.status}: ${res.statusText}`);
			return false;
		}

		const data = await res.json();
		return data.access_token;
	} catch (err) {
		error(`[ERROR] Error fetching ${provider} OAuth token:`, err);
		return false;
	}
}

module.exports = { fetchAuthToken };
