const path = require(`node:path`);
const fs = require(`node:fs`);

const isPM2 = process.env.pm_id !== undefined;
const configPath = path.join(process.cwd(), `config.json`);

function pauseAndExit(code = 1) {
	if (isPM2) {
		process.exit(code);
	}

	process.stdin.resume();
	console.error(`\nPress Enter to exit...`);
	process.stdin.once(`data`, () => process.exit(code));
}

function fatal(message) {
	console.error(`\n${message}\n`);
	pauseAndExit(1);
}

/* ---------- file existence ---------- */

if (!fs.existsSync(configPath)) {
	fatal(`\nMissing config.json\nCopy blank_config.json to config.json and fill in REQUIRED fields.`);
}

/* ---------- JSON parsing ---------- */

let config;
try {
	config = JSON.parse(fs.readFileSync(configPath, `utf8`));
} catch (err) {
	console.error(`\nconfig.json is not valid JSON\n`);
	console.error(err.message);
	pauseAndExit(1);
}

/* ---------- validation ---------- */

// Must exist AND be filled in
const REQUIRED_STRICT = [
	`token`,
	`twitchClientId`,
	`twitchSecret`,
	`kickClientId`,
	`kickSecret`,
	`botOwner`,
	`clientId`,
	`guildId`,
];

// Must exist, defaults allowed
const REQUIRED_WITH_DEFAULTS = [
	`twitchCron`,
	`statusCron`,
	`authCron`,
];

const missingStrict = REQUIRED_STRICT.filter(
	key =>
		!config[key] ||
		config[key] === `(REQUIRED)` ||
		config[key].toString().trim() === ``,
);

const missingDefaults = REQUIRED_WITH_DEFAULTS.filter(
	key =>
		!(key in config) ||
		config[key].toString().trim() === ``,
);

if (missingStrict.length || missingDefaults.length) {
	console.error(`\nconfig.json is invalid\n`);

	if (missingStrict.length) {
		console.error(`\nMissing or invalid REQUIRED fields:`);
		missingStrict.forEach(key => console.error(`  - ${key}`));
	}

	if (missingDefaults.length) {
		console.error(`\nMissing required cron fields:`);
		missingDefaults.forEach(key => console.error(`  - ${key}`));
	}

	pauseAndExit(1);
}

module.exports = config;
