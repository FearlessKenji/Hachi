require(`dotenv/config`);
require(`./config/configCheck.js`);
const { Client, Collection, GatewayIntentBits, Partials } = require(`discord.js`);
const { info, warn, initCrashHandlers, startLogCleanup, stopLogCleanup } = require(`./utils/writeLog.js`);
const createCronJobs = require(`./utils/crons.js`);
const { getCommandFiles, loadCommand } = require(`./utils/commandLoader.js`);
const path = require(`node:path`);
const fs = require(`node:fs`);

// =======================
// Initialize Crash Handlers
// =======================

initCrashHandlers();
startLogCleanup({ runImmediately: true });

// =======================
// Create Discord client
// =======================
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

// =======================
// Command handler
// =======================
client.commands = new Collection();

for (const filePath of getCommandFiles()) {
	try {
		const command = loadCommand(filePath);
		client.commands.set(command.data.name, command);
	} catch (err) {
		warn(`Failed to load command ${filePath}: ${err.message}`);
	}
}

// =======================
// Event handler
// =======================
const eventsPath = path.join(__dirname, `events`);
for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith(`.js`))) {
	const event = require(path.join(eventsPath, file));
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args));
	} else {
		client.on(event.name, (...args) => event.execute(...args));
	}
}

// =======================
// Login
// =======================
client.login(process.env.TOKEN);

// =======================
// Shutdown logic
// =======================
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
	client.destroy();
	process.exit(0);
}

// Listen for termination signals
process.on(`SIGINT`, shutdown); // Ctrl+C
process.on(`SIGTERM`, shutdown); // Termination signal
process.on(`SIGUSR2`, shutdown); // PM2 restart
