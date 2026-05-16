const { Client, Collection, GatewayIntentBits, Partials } = require(`discord.js`);
const { writeLog } = require(`./modules/writeLog.js`);
const createCronJobs = require(`./modules/crons.js`);
const config = require(`./modules/config.js`);
const path = require(`node:path`);
const fs = require(`node:fs`);

// =======================
// Create Discord client
// =======================
const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildMembers,
		GatewayIntentBits.GuildMessageReactions,
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
const commandsPath = path.join(__dirname, `commands`);

for (const scope of fs.readdirSync(commandsPath)) {
	const scopePath = path.join(commandsPath, scope);
	for (const folder of fs.readdirSync(scopePath)) {
		const folderPath = path.join(scopePath, folder);
		for (const file of fs.readdirSync(folderPath).filter(f => f.endsWith(`.js`))) {
			const command = require(path.join(folderPath, file));
			if (command.data && command.execute) {
				client.commands.set(command.data.name, command);
			}
			else {
				console.warn(writeLog(`[WARNING] ${file} missing data or execute`));
			}
		}
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
	}
	else {
		client.on(event.name, (...args) => event.execute(...args));
	}
}

// =======================
// Global error handling
// =======================
process.on(`uncaughtException`, err => {
	console.error(writeLog(`Uncaught exception:`, err));
});

// =======================
// Login
// =======================
client.login(config.token);

// =======================
// Shutdown logic
// =======================
function shutdown() {
	console.log(writeLog(`Stopping bot...`));

	if (client.cronJobs) {
		for (const [name, job] of Object.entries(client.cronJobs)) {
			if (job.running) {
				job.stop();
				console.log(writeLog(`${name} cron stopped.`));
			}
		}
	}

	client.destroy();
	process.exit(0);
}

// Listen for termination signals
process.on(`SIGINT`, shutdown); // Ctrl+C
process.on(`SIGTERM`, shutdown); // Termination signal
process.on(`SIGUSR2`, shutdown); // PM2 restart
