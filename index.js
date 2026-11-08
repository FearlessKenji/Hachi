// Main bot runtime entry point.
//
// Startup order is deliberate: load .env, decrypt protected env values into
// process memory, run config/database validation, then create the Discord client.
// Modules loaded after configCheck can safely read process.env as plaintext
// runtime values without knowing how they were stored on disk.
const STARTUP_FAILURE_EXIT_CODE = 78;

try {
	require(`dotenv/config`);
	require(`./config/secretEncryption.js`).decryptEnvSecrets(process.env, { cwd: process.cwd() });
	require(`./config/configCheck.js`);
} catch (err) {
	// PM2's stop_exit_codes treats 78 as a configuration/startup failure.
	console.error(`Failed to load startup configuration:`, err);
	process.exit(STARTUP_FAILURE_EXIT_CODE);
}

let startupModules;

try {
	startupModules = {
		discord: require(`discord.js`),
		logger: require(`./utils/writeLog.js`),
		createCronJobs: require(`./utils/crons.js`),
		roleEventSub: require(`./modules/twitchRoleEventSub.js`),
		commandLoader: require(`./utils/commandLoader.js`),
	};
} catch (err) {
	console.error(`Failed to load bot modules:`, err);
	process.exit(STARTUP_FAILURE_EXIT_CODE);
}

const { Client, Collection, Events, GatewayIntentBits, Partials } = startupModules.discord;
const { info, error, initCrashHandlers, startLogCleanup, stopLogCleanup } = startupModules.logger;
const { createCronJobs, roleEventSub, commandLoader } = startupModules;
const { stopTwitchRoleEventSub } = roleEventSub;
const { getCommandFiles, loadCommand } = commandLoader;
const path = require(`node:path`);
const fs = require(`node:fs`);

// Start crash and log-maintenance handlers before creating the Discord client so
// startup failures and early runtime errors are written through the normal logger.
initCrashHandlers();
startLogCleanup({ runImmediately: true });

function failInitialization(message, err) {
	error(message, err, { module: `startup` });
	// A broken initialization cannot recover through an automatic PM2 restart.
	process.exit(STARTUP_FAILURE_EXIT_CODE);
}

function executeEvent(event, ...args) {
	try {
		Promise.resolve(event.execute(...args)).catch(err => {
			if (event.name === Events.ClientReady) {
				failInitialization(`Bot initialization failed during the ready event.`, err);
				return;
			}

			error(`Event ${event.name} failed.`, err, { module: `events` });
		});
	} catch (err) {
		if (event.name === Events.ClientReady) {
			failInitialization(`Bot initialization failed during the ready event.`, err);
			return;
		}

		error(`Event ${event.name} failed.`, err, { module: `events` });
	}
}

let client;

try {
	// Discord client and cron definitions must both be valid before login.
	client = new Client({
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

	// Load command modules once at startup. A missing command is an incomplete
	// runtime, so abort rather than accepting interactions Hachi cannot handle.
	client.commands = new Collection();

	for (const filePath of getCommandFiles()) {
		const command = loadCommand(filePath);
		client.commands.set(command.data.name, command);
	}

	// Event files decide whether they should be attached once or continuously.
	const eventsPath = path.join(__dirname, `events`);

	for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith(`.js`))) {
		const event = require(path.join(eventsPath, file));
		const listener = (...args) => executeEvent(event, ...args);

		if (event.once) {
			client.once(event.name, listener);
		} else {
			client.on(event.name, listener);
		}
	}

	client.login(process.env.TOKEN).catch(err => {
		failInitialization(`Failed to log in to Discord.`, err);
	});
} catch (err) {
	failInitialization(`Bot initialization failed before login.`, err);
}

// Stop cron work before destroying the Discord client so background jobs do not
// keep trying to use a client that is already shutting down.
function shutdown() {
	info(`Stopping bot...`);

	if (client.cronJobs) {
		for (const [name, job] of Object.entries(client.cronJobs)) {
			if (job.isActive) {
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
