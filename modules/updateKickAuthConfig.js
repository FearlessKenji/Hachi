const config = require(`../config.json`);
const auth = require(`./authKick.js`);
const fs = require(`node:fs`);

// get a new authorization key and update the config
async function updateKickAuthConfig() {
	// get the auth key
	const authKey = await auth.getKey(config.kickClientId, config.kickSecret);
	if (!authKey) {
		return;
	}

	// write the new auth key
	// console.log(writeLog(`Updating authToken and writing to config.`));
	const tempConfig = JSON.parse(fs.readFileSync(`./config.json`));
	tempConfig.kickAuthToken = authKey;
	fs.writeFileSync(`./config.json`, JSON.stringify(tempConfig, null, 2));
}
module.exports = { updateKickAuthConfig };