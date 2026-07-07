require(`dotenv/config`);
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
