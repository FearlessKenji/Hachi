const path = require(`node:path`);
const fs = require(`node:fs`);

const isPM2 = process.env.pm_id !== undefined;
const configPath = path.join(process.cwd(), `config`, `config.json`);

console.log(`Validating config files...`);

function pauseAndExit(code = 1) {
	if (isPM2) {
		process.exit(code);
	}

	process.stdin.resume();
	console.error(`\nPress Enter to exit...`);
	process.stdin.once(`data`, () => {
		process.exit(code);
	});
}

function fatal(message) {
	console.error(`\n${message}\n`);
	pauseAndExit(1);
}

/* ---------- helpers ---------- */

function isEmpty(value) {
	return (
		value === undefined ||
		value === null ||
		(typeof value === `string` && value.trim() === ``)
	);
}

/* ---------- .env validation ---------- */

const REQUIRED_ENV = [
	`TOKEN`,
	`twitchClientId`,
	`twitchSecret`,
	`kickClientId`,
	`kickSecret`,
];

const missingEnv = REQUIRED_ENV.filter(key => isEmpty(process.env[key]));

if (missingEnv.length) {
	fatal(
		`.env is missing required fields:\n` +
		missingEnv.map(k => `  - ${k}`).join(`\n`)
	);
}

/* ---------- config existence ---------- */

if (!fs.existsSync(configPath)) {
	fatal(
		`Missing config.json\n` +
		`Copy blank_config.json to config/config.json and fill in required fields.`
	);
}

/* ---------- config parsing ---------- */

let config;

try {
	config = JSON.parse(fs.readFileSync(configPath, `utf8`));
} catch (err) {
	fatal(
		`config.json is not valid JSON:\n` +
		err.message
	);
}

/* ---------- config validation ---------- */

const REQUIRED_STRICT = [
	`botOwner`,
	`clientId`,
	`guildId`,
];

const REQUIRED_WITH_DEFAULTS = [
	`twitchCron`,
	`kickCron`,
	`statusCron`,
	`authCron`,
];

const missingStrict = REQUIRED_STRICT.filter(key => isEmpty(config[key]));
const missingDefaults = REQUIRED_WITH_DEFAULTS.filter(key => isEmpty(config[key]));

if (missingStrict.length || missingDefaults.length) {
	let message = `config.json is invalid`;

	if (missingStrict.length) {
		message += `\n\nMissing required fields:\n`;
		message += missingStrict.map(k => `  - ${k}`).join(`\n`);
	}

	if (missingDefaults.length) {
		message += `\n\nMissing required cron fields:\n`;
		message += missingDefaults.map(k => `  - ${k}`).join(`\n`);
	}

	fatal(message);
}

console.log(`Configuration files validated.`);

/* ---------- export ---------- */

module.exports = config;