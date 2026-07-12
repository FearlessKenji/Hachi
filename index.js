// Main bot runtime entry point.
//
// Startup order is deliberate: load .env, decrypt protected env values into
// process memory, run config/database validation, then create the Discord client.
// Modules loaded after configCheck can safely read process.env as plaintext
// runtime values without knowing how they were stored on disk.
require(`dotenv/config`);
require(`./config/secretEncryption.js`).decryptEnvSecrets(process.env, { cwd: process.cwd() });
require(`./config/configCheck.js`);
const { Client, Collection, GatewayIntentBits, Partials } = require(`discord.js`);
const { info, warn, error, initCrashHandlers, startLogCleanup, stopLogCleanup } = require(`./utils/writeLog.js`);
const createCronJobs = require(`./utils/crons.js`);
const { stopTwitchRoleEventSub } = require(`./modules/twitchRoleEventSub.js`);
const { getCommandFiles, loadCommand } = require(`./utils/commandLoader.js`);
const path = require(`node:path`);
const fs = require(`node:fs`);

// Start crash and log-maintenance handlers before creating the Discord client so
// startup failures and early runtime errors are written through the normal logger.
initCrashHandlers();
startLogCleanup({ runImmediately: true });

// Discord client
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessageReactions,
		GatewayIntentBits.MessageContent,
	],
	partials: [
		Partials.Message,
		Partials.Reaction,
		Partials.User,
	],
});

client.cronJobs = createCronJobs(client);

// Load command modules once at startup. The deploy scripts register slash command
// metadata with Discord; this collection is the runtime dispatch table.
client.commands = new Collection();

for (const filePath of getCommandFiles()) {
	try {
		const command = loadCommand(filePath);
		client.commands.set(command.data.name, command);
	} catch (err) {
		warn(`Failed to load command ${filePath}: ${err.message}`);
	}
}

// Register every event module in the events folder. Event files decide whether
// they should be attached with client.once or client.on.
const eventsPath = path.join(__dirname, `events`);
for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith(`.js`))) {
	const event = require(path.join(eventsPath, file));
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args));
	} else {
		client.on(event.name, (...args) => event.execute(...args));
	}
}

// Login
client.login(process.env.TOKEN).catch(err => {
	error(`Failed to log in to Discord.`, err);
	process.exit(1);
});

// Stop cron work before destroying the Discord client so background jobs do not
// keep trying to use a client that is already shutting down.
function shutdown() {
	info(`Stopping bot...`);

	if (client.cronJobs) {
		for (const [name, job] of Object.entries(client.cronJobs)) {
			if (job.running) {
				job.stop();
				info(`${name} cron stopped.`);
			}
		}
	}

	stopLogCleanup();
	stopTwitchRoleEventSub();
	client.destroy();
	process.exit(0);
}

// Termination signals
process.on(`SIGINT`, shutdown);
process.on(`SIGTERM`, shutdown);
process.on(`SIGUSR2`, shutdown);
