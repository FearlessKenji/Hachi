// Deploy guild-only commands to the configured test guild. Guild commands update
// faster than global commands, so this script is useful while developing admin
// or utility commands that should not be global.
require(`dotenv/config`);
require(`./config/secretEncryption.js`).decryptEnvSecrets(process.env, { cwd: process.cwd() });
const config = require(`./config/config.json`);
const { getCommandData, redeployCommands } = require(`./utils/commandLoader.js`);
const { getConfiguredGuildIds } = require(`./utils/configValues.js`);

const clientId = process.env.clientId;
const guildIds = getConfiguredGuildIds(config);

async function main() {
	try {
		const commands = getCommandData(`guild`);

		if (!guildIds.length) {
			throw new Error(`At least one guild ID is required to deploy guild commands.`);
		}

		console.log(`Started refreshing ${commands.length} application (/) commands across ${guildIds.length} guild(s).`);

		for (const guildId of guildIds) {
			const { data } = await redeployCommands(`guild`, {
				clientId,
				commands,
				guildId,
				token: process.env.TOKEN,
			});

			console.log(`Successfully reloaded ${data.length} application (/) commands for guild ${guildId}.`);
		}

		return 0;
	} catch (error) {
		console.log(error);
		return 1;
	}
}

main().then(exitCode => {
	process.exitCode = exitCode;
});
