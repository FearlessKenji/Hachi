require(`dotenv/config`);
const { guildId } = require(`./config/config.json`);
const { getCommandData, redeployCommands } = require(`./utils/commandLoader.js`);

const clientId = process.env.clientId;

async function main() {
	try {
		const commands = getCommandData(`guild`);

		console.log(`Started refreshing ${commands.length} application (/) commands.`);

		const { data } = await redeployCommands(`guild`, {
			clientId,
			commands,
			guildId,
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
