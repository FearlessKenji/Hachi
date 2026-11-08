// Provider app-token requester.
//
// Twitch and Kick both expose OAuth client-credentials flows. This helper keeps
// the HTTP shape and error logging in one place so refreshAuthTokens.js can
// request tokens without duplicating provider plumbing.
const { error } = require(`../utils/writeLog`);
const { URLSearchParams } = require(`node:url`);
const APP_TOKEN_TIMEOUT_MS = 20_000;

async function fetchAuthToken({ provider, tokenUrl, clientID, clientSecret }) {
	try {
		// Both provider token endpoints accept form-encoded client credentials.
		// Keeping them out of the URL avoids exposing secrets in URL logs.
		const body = new URLSearchParams({
			client_id: clientID,
			client_secret: clientSecret,
			grant_type: `client_credentials`,
		});
		const response = await fetch(tokenUrl, {
			method: `POST`,
			headers: { 'Content-Type': `application/x-www-form-urlencoded` },
			body,
			// A stalled provider must not indefinitely block token refresh jobs.
			signal: globalThis.AbortSignal.timeout(APP_TOKEN_TIMEOUT_MS),
		});

		if (!response.ok) {
			error(`${provider} OAuth returned ${response.status}: ${response.statusText}`);
			return false;
		}

		const tokenPayload = await response.json();

		if (typeof tokenPayload.access_token !== `string` || !tokenPayload.access_token) {
			error(`${provider} OAuth returned a response without an access token.`);
			return false;
		}

		return tokenPayload.access_token;
	} catch (err) {
		error(`Error fetching ${provider} OAuth token:`, err);
		return false;
	}
}

module.exports = { fetchAuthToken };
