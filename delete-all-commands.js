// Clear both guild and global Discord application commands before redeploying.
// HachiGen runs this before deployment so commands removed from source are also
// removed from Discord instead of lingering in the command picker.
require(`dotenv/config`);
require(`./config/secretEncryption.js`).decryptEnvSecrets(process.env, { cwd: process.cwd() });
const { REST, Routes } = require(`discord.js`);
const config = require(`./config/config.json`);
const { getConfiguredGuildIds } = require(`./utils/configValues.js`);

const clientId = process.env.clientId;
const guildIds = getConfiguredGuildIds(config);

const rest = new REST().setToken(process.env.TOKEN);

(async () => {
	try {
		await Promise.all([
			...guildIds.map(guildId => rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] })),
			rest.put(Routes.applicationCommands(clientId), { body: [] }),
		]);

		console.log(`Successfully deleted global commands and guild commands for ${guildIds.length} configured guild(s).`);
	} catch (error) {
		console.log(error);
		process.exitCode = 1;
	}
})();
