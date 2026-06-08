const auth = require(`./authTwitch.js`);
const { updateAuthTokens } = require(`./authTokens.js`);
const { twitchClientId, twitchSecret } = process.env;
// const { debug } = require(`../utils/writeLog.js`)

// get a new authorization key and update the runtime auth cache
async function updateTwitchAuth() {
	// debug(`Generating new Twitch auth token...`)
	const authKey = await auth.getKey(
		twitchClientId,
		twitchSecret,
	);

	if (!authKey) {
		return;
	}

	updateAuthTokens({ twitchAuthToken: authKey });
	// debug(`New Twitch auth token stored.`)
}

module.exports = { updateTwitchAuth };