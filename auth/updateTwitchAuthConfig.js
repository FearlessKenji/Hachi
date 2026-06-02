const auth = require(`./authTwitch.js`);
const { updateAuthTokens } = require(`./authTokens.js`);
const { twitchClientId, twitchSecret } = process.env;

// get a new authorization key and update the runtime auth cache
async function updateTwitchAuthConfig() {
	const authKey = await auth.getKey(
		twitchClientId,
		twitchSecret,
	);

	if (!authKey) {
		return;
	}

	updateAuthTokens({ twitchAuthToken: authKey });
}

module.exports = { updateTwitchAuthConfig };