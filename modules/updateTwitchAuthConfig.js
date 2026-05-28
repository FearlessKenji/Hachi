const config = require(`../config.json`);
const auth = require(`./authTwitch.js`);
const fs = require(`node:fs`);

// get a new authorization key and update the config
async function updateTwitchAuthConfig() {
	// get the auth key
	const authKey = await auth.getKey(config.twitchClientId, config.twitchSecret);
	if (!authKey) {
		return;
	}

	// write the new auth key
	// console.log(writeLog(`Updating authToken and writing to config.`));
	const tempConfig = JSON.parse(fs.readFileSync(`./config.json`));
	tempConfig.twitchAuthToken = authKey;
	fs.writeFileSync(`./config.json`, JSON.stringify(tempConfig, null, 2));
}
module.exports = { updateTwitchAuthConfig };