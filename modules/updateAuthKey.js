const { getAuthKey } = require(`./getAuthKey.js`);
const config = require(`../config.json`);
const fs = require(`node:fs`);

// get a new authorization key and update the config
async function updateAuthKey() {
	// mode: true for Twitch, false for Kick

	const twitchAuthKey = await getAuthKey(true, config.twitchClientId, config.twitchSecret);
	const kickAuthKey = await getAuthKey(false, config.kickClientId, config.kickSecret);

	// write the new auth key
	// console.log(writeLog(`Updating authToken and writing to config.`));
	const tempConfig = JSON.parse(fs.readFileSync(`./config.json`));

	tempConfig.twitchAuthToken = twitchAuthKey;
	tempConfig.kickAuthToken = kickAuthKey;

	fs.writeFileSync(`./config.json`, JSON.stringify(tempConfig, null, 2));
}
module.exports = { updateAuthKey };