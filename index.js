// Main bot runtime entry point.
//
// Startup order is deliberate: load .env, decrypt protected env values into
// process memory, run config/database validation, then create the Discord client.
// Modules loaded after configCheck can safely read process.env as plaintext
// runtime values without knowing how they were stored on disk.
const STARTUP_FAILURE_EXIT_CODE = 78;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 6500;
const SHUTDOWN_EXIT_TIMEOUT_MS = 9000;

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
		database: require(`./database/dbObjects.js`).sequelize,
		drainAndCloseRuntime: require(`./utils/gracefulShutdown.js`).drainAndCloseRuntime,
		stopAuthRefresh: require(`./auth/refreshAuthTokens.js`).stopAuthRefreshRetries,
		replayWaiters: [
			require(`./modules/getTwitch.js`).waitForPendingReplayWork,
			require(`./modules/getKick.js`).waitForPendingReplayWork,
		],
		stopReadyTasks: require(`./events/ready.js`).stopReadyTasks,
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
const activeEvents = new Set();
let shuttingDown = false;
let shutdownPromise = null;

// Start crash and log-maintenance handlers before creating the Discord client so
// startup failures and early runtime errors are written through the normal logger.
initCrashHandlers();
startLogCleanup({ runImmediately: true });

function failInitialization(message, err) {
	error(message, err, { module: `startup` });
	// A broken initialization cannot recover through an automatic PM2 restart.
	process.exit(STARTUP_FAILURE_EXIT_CODE);
}

function handleEventFailure(event, err) {
	if (event.name === Events.ClientReady) {
		failInitialization(`Bot initialization failed during the ready event.`, err);
		return;
	}

	error(`Event ${event.name} failed.`, err, { module: `events` });
}

function executeEvent(event, ...args) {
	if (shuttingDown) {
		return;
	}

	let result;
	try {
		result = event.execute(...args);
	} catch (err) {
		handleEventFailure(event, err);
		return;
	}

	// Track commands and Discord event handlers so shutdown does not close SQLite
	// while one of them is still persisting state after a Discord action.
	const tracked = Promise.resolve(result)
		.catch(err => handleEventFailure(event, err))
		.finally(() => activeEvents.delete(tracked));
	activeEvents.add(tracked);
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
	client.requestShutdown = shutdown;

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

// One shared path handles PM2 signals and /restart. The hard limit stays below
// PM2's 10-second kill timeout so Hachi can log incomplete work before exit.
function shutdown(reason = `signal`) {
	if (shutdownPromise) {
		return shutdownPromise;
	}
	shuttingDown = true;
	shutdownPromise = (async () => {
		const forceExit = setTimeout(() => {
			error(`Shutdown exceeded ${SHUTDOWN_EXIT_TIMEOUT_MS} ms; forcing process exit.`, null, { module: `shutdown` });
			process.exit(1);
		}, SHUTDOWN_EXIT_TIMEOUT_MS);
		try {
			info(`Stopping bot after ${reason}...`);
			await startupModules.drainAndCloseRuntime({
				activeEvents,
				client,
				cronJobs: client.cronJobs,
				database: startupModules.database,
				drainTimeoutMs: SHUTDOWN_DRAIN_TIMEOUT_MS,
				logger: startupModules.logger,
				replayWaiters: startupModules.replayWaiters,
				stopAuthRefresh: startupModules.stopAuthRefresh,
				stopEventSub: stopTwitchRoleEventSub,
				stopReadyTasks: startupModules.stopReadyTasks,
				stopLogCleanup,
			});
			process.exit(0);
		} catch (err) {
			error(`Shutdown failed.`, err, { module: `shutdown` });
			process.exit(1);
		} finally {
			clearTimeout(forceExit);
		}
	})();
	return shutdownPromise;
}

// Termination signals
for (const signal of [`SIGINT`, `SIGTERM`, `SIGUSR2`]) {
	process.on(signal, () => {
		void shutdown(signal);
	});
}
