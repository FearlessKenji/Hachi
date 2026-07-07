require(`dotenv/config`);
const { REST, Routes } = require(`discord.js`);
const { guildId } = require(`./config/config.json`);

const clientId = process.env.clientId;

const rest = new REST().setToken(process.env.TOKEN);

(async () => {
	try {
		await Promise.all([
			rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] }),
			rest.put(Routes.applicationCommands(clientId), { body: [] }),
		]);

		console.log(`Successfully deleted all guild and global application commands.`);
	} catch (error) {
		console.log(error);
		process.exitCode = 1;
	}
})();
