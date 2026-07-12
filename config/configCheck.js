// Startup configuration validator for Hachi and HachiGen.
const path = require(`node:path`);
const fs = require(`node:fs`);
require(`dotenv/config`);
const { info, error } = require(`../utils/writeLog.js`);
const {
	decryptEnvSecrets,
	inspectEnvFile,
	isEnabledValue: isSecretEncryptionEnabled,
	readSecretKeyFromEnv,
} = require(`./secretEncryption.js`);
const {
	cipherDriverStatus,
	databaseFileStatus,
	isDatabaseProtectionEnabled,
	isEncryptedDatabaseRuntimeEnabled,
	openSqlCipherDatabase,
	readDatabaseKeyFromEnv,
	resolveKeyFilePath,
} = require(`../database/dbEncryption.js`);
const {
	getConfiguredGuildIds,
	getConfiguredOwnerIds,
} = require(`../utils/configValues.js`);

// This file is intentionally executable-on-require. Hachi requires it during
// startup, and HachiGen runs `node -e "require('./config/configCheck.js')"` while
// validating installs. Keep failures explicit and early so Hachi never starts
// with plaintext secrets, a plaintext database, or unreadable encryption keys.
const configPath = path.join(process.cwd(), `config`, `config.json`);
const CONFIG_EXIT_CODE = 78;

info(`Validating config files...`);

function fatal(message) {
	error(`[FATAL] ${message}`);
	process.exit(CONFIG_EXIT_CODE);
}

// Helpers
function isEmpty(value) {
	return (
		value === undefined ||
		value === null ||
		(typeof value === `string` && value.trim() === ``)
	);
}

// Environment validation
// Install-specific credentials and app IDs stay in .env with the rest of the bot identity.
const REQUIRED_ENV = [
	`TOKEN`,
	`clientId`,
	`twitchClientId`,
	`twitchSecret`,
	`kickClientId`,
	`kickSecret`,
];

const secretProtectionEnabled = isSecretEncryptionEnabled(process.env.HACHI_SECRETS_ENCRYPTION);
const secretFileStatus = inspectEnvFile(path.resolve(process.cwd(), `.env`));

// Secret validation happens before required-field validation because encrypted
// values are not usable until they are decrypted into process.env memory.
if (!secretProtectionEnabled) {
	fatal(
		`.env secret encryption is required.\n` +
		`Save configuration with HachiGen so .env values are encrypted and HACHI_SECRETS_ENCRYPTION=encrypted is set.`,
	);
}

if (secretFileStatus.plaintextFields.length) {
	fatal(
		`.env contains plaintext fields that must be encrypted:\n` +
		secretFileStatus.plaintextFields.map(k => `  - ${k}`).join(`\n`) +
		`\nSave configuration with HachiGen to convert them before starting Hachi.`,
	);
}

try {
	readSecretKeyFromEnv(process.env, process.cwd());
	decryptEnvSecrets(process.env, { cwd: process.cwd() });
} catch (err) {
	fatal(`.env secrets could not be decrypted:\n${err.message}`);
}

const missingEnv = REQUIRED_ENV.filter(key => isEmpty(process.env[key]));

if (missingEnv.length) {
	fatal(
		`.env is missing required fields:\n` +
		missingEnv.map(k => `  - ${k}`).join(`\n`),
	);
}

const databaseProtectionEnabled = isDatabaseProtectionEnabled(process.env.HACHI_DB_ENCRYPTION);
const encryptedRuntimeEnabled = isEncryptedDatabaseRuntimeEnabled(process.env.HACHI_DB_ENCRYPTION);
let databaseKeyInfo = null;

// Database validation is stricter than a best-effort open. Hachi must never
// silently create or continue with a plaintext database once encryption exists.
if (!encryptedRuntimeEnabled) {
	fatal(
		`Database encryption is required.\n` +
		`Set HACHI_DB_ENCRYPTION=encrypted with HACHI_DB_KEY_FILE or HACHI_DB_KEY before starting Hachi.\n` +
		`Existing plaintext databases must be converted with HachiGen before Hachi can run.`,
	);
}

if (databaseProtectionEnabled) {
	const directKey = String(process.env.HACHI_DB_KEY || ``).trim();
	const keyFilePath = resolveKeyFilePath(process.env.HACHI_DB_KEY_FILE);

	if (!directKey && !keyFilePath) {
		fatal(`HACHI_DB_ENCRYPTION is enabled, but neither HACHI_DB_KEY_FILE nor HACHI_DB_KEY is configured.`);
	}

	if (!directKey) {
		if (!fs.existsSync(keyFilePath)) {
			fatal(`HACHI_DB_ENCRYPTION is enabled, but HACHI_DB_KEY_FILE was not found: ${keyFilePath}`);
		}

		const keyText = fs.readFileSync(keyFilePath, `utf8`).trim();

		if (!keyText) {
			fatal(`HACHI_DB_ENCRYPTION is enabled, but HACHI_DB_KEY_FILE is empty: ${keyFilePath}`);
		}
	}

	try {
		databaseKeyInfo = readDatabaseKeyFromEnv(process.env, process.cwd());
	} catch (err) {
		fatal(`HACHI_DB_ENCRYPTION is enabled, but the database key could not be read:\n${err.message}`);
	}
}

const databaseStatus = databaseFileStatus(path.resolve(`database`, `database.sqlite`));

if (!databaseProtectionEnabled || !String(databaseKeyInfo?.key || ``).trim()) {
	fatal(`Encrypted database runtime is enabled, but no database key is available.`);
}

const driver = cipherDriverStatus(process.cwd());

if (!driver.installed) {
	fatal(`Encrypted database runtime is enabled, but ${driver.packageName} is not installed.`);
}

if (databaseStatus.status === `plaintext`) {
	fatal(
		`database/database.sqlite is plain SQLite, but Hachi requires encrypted databases.\n` +
		`Use HachiGen validation/start to convert it, or restore an encrypted database backup.`,
	);
}

if (databaseStatus.status === `invalid`) {
	fatal(
		`database/database.sqlite is not a valid encrypted Hachi database: ${databaseStatus.detail}\n` +
		`Restore a valid encrypted database backup before starting Hachi.`,
	);
}

if (databaseStatus.encryptedLikely) {
	let encryptedDb = null;

	try {
		encryptedDb = openSqlCipherDatabase({
			dbPath: databaseStatus.path,
			key: databaseKeyInfo.key,
			readonly: true,
			root: process.cwd(),
		});
		encryptedDb.prepare(`PRAGMA schema_version`).get();
	} catch (err) {
		fatal(`Encrypted database runtime is enabled, but database/database.sqlite could not be opened with the configured key:\n${err.message}`);
	} finally {
		if (encryptedDb) {
			encryptedDb.close();
		}
	}
}

// Config existence
if (!fs.existsSync(configPath)) {
	fatal(
		`Missing config.json\n` +
		`Run Hachi.exe for guided setup, or copy blank.json to config/config.json and fill in required fields.`,
	);
}

// Config parsing
let config;

try {
	config = JSON.parse(fs.readFileSync(configPath, `utf8`));
} catch (err) {
	fatal(
		`config.json is not valid JSON:\n` +
		err.message,
	);
}

// Config validation
// Cron expressions are required explicitly instead of silently defaulting, because
// changing a scheduler should be an intentional config edit.
const REQUIRED_WITH_DEFAULTS = [
	`twitchCron`,
	`kickCron`,
	`birthdayCron`,
	`statusCron`,
	`authCron`,
];

const ownerIds = getConfiguredOwnerIds(config);
const guildIds = getConfiguredGuildIds(config);
const missingStrict = [];

if (!ownerIds.length) {
	missingStrict.push(`botOwners`);
}

if (!guildIds.length) {
	missingStrict.push(`guildIds`);
}

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

// Normalize the accepted config shapes for any runtime imports that happen after
// validation. Old config files with botOwner/guildId still work, while new code
// can read botOwners/guildIds consistently.
config.botOwners = ownerIds;
config.guildIds = guildIds;
config.botOwner = config.botOwner || ownerIds[0] || ``;
config.guildId = config.guildId || guildIds[0] || ``;

info(`Configuration files validated.`);

// Export validated config
module.exports = config;
