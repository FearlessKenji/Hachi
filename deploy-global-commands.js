// Deploy every global slash/context command registered in commands/globalCommands.
// This script is run by HachiGen and can also be run manually; it decrypts .env
// first so TOKEN/clientId work even though they are encrypted on disk.
require(`dotenv/config`);
require(`./config/secretEncryption.js`).decryptEnvSecrets(process.env, { cwd: process.cwd() });
const { getCommandData, redeployCommands } = require(`./utils/commandLoader.js`);

const clientId = process.env.clientId;

async function main() {
	try {
		const commands = getCommandData(`global`);

		console.log(`Started refreshing ${commands.length} application (/) commands.`);

		const { data } = await redeployCommands(`global`, {
			clientId,
			commands,
			token: process.env.TOKEN,
		});

		console.log(`Successfully reloaded ${data.length} application (/) commands.`);
		return 0;
	} catch (error) {
		console.log(error);
		return 1;
	}
}

main().then(exitCode => {
	process.exitCode = exitCode;
});
