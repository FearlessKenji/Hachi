const auth = require(`./authKick.js`);
const { updateAuthTokens } = require(`./authTokens.js`);
const { kickClientId, kickSecret } = process.env;
// const { debug } = require(`../utils/writeLog.js`)

// get a new authorization key and update the runtime auth cache
async function updateKickAuth() {
	// debug(`Generating new Kick auth token...`)
	const authKey = await auth.getKey(
		kickClientId,
		kickSecret,
	);

	if (!authKey) {
		return;
	}

	updateAuthTokens({ kickAuthToken: authKey });
	// debug(`New Kick auth token stored.`)
}



module.exports = { updateKickAuth };