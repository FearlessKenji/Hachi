const auth = require(`./authKick.js`);
const { updateAuthTokens } = require(`./authTokens.js`);
const { kickClientId, kickSecret } = process.env;

// get a new authorization key and update the runtime auth cache
async function updateKickAuthConfig() {
	const authKey = await auth.getKey(
		kickClientId,
		kickSecret,
	);

	if (!authKey) {
		return;
	}

	updateAuthTokens({ kickAuthToken: authKey });
}

module.exports = { updateKickAuthConfig };