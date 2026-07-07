const { fetchAuthToken } = require(`./fetchAuthToken.js`);
const { updateAuthTokens } = require(`./authTokens.js`);

async function refreshAuth({ provider, tokenUrl, clientID, clientSecret, tokenKey }) {
	const authKey = await fetchAuthToken({
		provider,
		tokenUrl,
		clientID,
		clientSecret,
	});

	if (!authKey) {
		return;
	}

	updateAuthTokens({ [tokenKey]: authKey });
}

async function updateTwitch() {
	await refreshAuth({
		provider: `Twitch`,
		tokenUrl: `https://id.twitch.tv/oauth2/token`,
		clientID: process.env.twitchClientId,
		clientSecret: process.env.twitchSecret,
		tokenKey: `twitchAuthToken`,
	});
}

async function updateKick() {
	await refreshAuth({
		provider: `Kick`,
		tokenUrl: `https://id.kick.com/oauth/token`,
		clientID: process.env.kickClientId,
		clientSecret: process.env.kickSecret,
		tokenKey: `kickAuthToken`,
	});
}

module.exports = {
	refreshAuth,
	updateKick,
	updateTwitch,
};
