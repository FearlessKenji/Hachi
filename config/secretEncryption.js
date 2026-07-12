// Per-value .env encryption/decryption helpers.
const crypto = require(`node:crypto`);
const fs = require(`node:fs`);
const os = require(`node:os`);
const path = require(`node:path`);
const { Buffer } = require(`node:buffer`);

// Shared .env secret protection for both Hachi and HachiGen.
//
// HachiGen writes each managed .env value as an independent AES-GCM envelope so
// users can still edit the file by hand and rotate one value without rewriting
// the whole file. Hachi loads dotenv first, then decrypts these envelopes into
// process.env memory before the rest of the runtime reads them.
const ENCRYPTED_VALUE_PREFIX = `enc:v1:aes-256-gcm:`;

// These are the values HachiGen's Setup page manages directly. They include
// public-looking IDs as well as true secrets so the on-disk policy stays uniform.
const SECRET_ENV_FIELDS = [
	`TOKEN`,
	`clientId`,
	`twitchClientId`,
	`twitchSecret`,
	`kickClientId`,
	`kickSecret`,
];

// Bootstrap fields must remain plaintext because they tell Hachi where the
// decryption key is. Encrypting these would make startup circular.
const SECRET_PROTECTION_ENV_FIELDS = [
	`HACHI_SECRETS_ENCRYPTION`,
	`HACHI_SECRETS_KEY_FILE`,
	`HACHI_SECRETS_KEY`,
];

// Database bootstrap fields also stay plaintext for the same reason. They are
// listed here so "encrypt every other .env field" helpers do not touch them.
const DATABASE_PROTECTION_ENV_FIELDS = [
	`HACHI_DB_ENCRYPTION`,
	`HACHI_DB_KEY_FILE`,
	`HACHI_DB_KEY`,
];
const UNPROTECTED_ENV_FIELDS = new Set([
	...SECRET_PROTECTION_ENV_FIELDS,
	...DATABASE_PROTECTION_ENV_FIELDS,
]);

// HachiGen uses a small dotenv writer instead of a dependency because it only
// needs KEY=value, quotes, blank lines, and comments for known local files.
function parseDotEnvContent(content) {
	const values = {};
	const lines = String(content || ``).split(/\r?\n/u);

	for (const line of lines) {
		const trimmed = line.trim();

		if (!trimmed || trimmed.startsWith(`#`)) {
			continue;
		}

		const equalsIndex = trimmed.indexOf(`=`);

		if (equalsIndex === -1) {
			continue;
		}

		const key = trimmed.slice(0, equalsIndex).trim();
		let value = trimmed.slice(equalsIndex + 1).trim();

		if (value.startsWith(`"`) && value.endsWith(`"`)) {
			try {
				value = JSON.parse(value);
			} catch {
				value = value.slice(1, -1);
			}
		} else if (value.startsWith(`'`) && value.endsWith(`'`)) {
			value = value.slice(1, -1);
		}

		values[key] = value;
	}

	return values;
}

function parseDotEnvFile(envPath) {
	if (!fs.existsSync(envPath)) {
		return {};
	}

	return parseDotEnvContent(fs.readFileSync(envPath, `utf8`));
}

function isEnabledValue(value) {
	return [`1`, `on`, `true`, `yes`, `encrypted`, `active`].includes(String(value || ``).trim().toLowerCase());
}

function isPlaceholderValue(value) {
	return String(value || ``).includes(`(REQUIRED)`);
}

function isMissingSecretValue(value) {
	return value === undefined ||
		value === null ||
		String(value).trim() === `` ||
		isPlaceholderValue(value);
}

function isEncryptedValue(value) {
	return String(value || ``).startsWith(ENCRYPTED_VALUE_PREFIX);
}

function isProtectableEnvField(field) {
	return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(String(field || ``)) &&
		!UNPROTECTED_ENV_FIELDS.has(field);
}

function generateSecretKey() {
	return crypto.randomBytes(32).toString(`base64url`);
}

// Accept Windows %APPDATA%, POSIX $HOME/${HOME}, ~, and relative paths so the
// same key-file pointer model works in local Windows and remote Linux installs.
function expandEnvironmentVariables(value, env = process.env) {
	return String(value || ``)
		.replace(/%([^%]+)%/gu, (_match, key) => env[key] || _match)
		.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_match, braced, plain) => {
			const key = braced || plain;
			return env[key] || _match;
		});
}

function resolveKeyFilePath(value, cwd = process.cwd(), env = process.env) {
	const expanded = expandEnvironmentVariables(value, env).trim();

	if (!expanded) {
		return ``;
	}

	if (expanded === `~`) {
		return os.homedir();
	}

	if (expanded.startsWith(`~/`) || expanded.startsWith(`~\\`)) {
		return path.join(os.homedir(), expanded.slice(2));
	}

	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

// The normalized key file location mirrors common per-user config directories
// instead of application folders so installs can be moved without losing keys.
function getDefaultSecretKeyFile({
	env = process.env,
	homeDir = os.homedir(),
	platform = process.platform,
} = {}) {
	if (platform === `win32`) {
		return path.join(env.APPDATA || path.join(homeDir, `AppData`, `Roaming`), `Hachi`, `secrets.key`);
	}

	if (platform === `darwin`) {
		return path.join(homeDir, `Library`, `Application Support`, `Hachi`, `secrets.key`);
	}

	return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, `.config`), `hachi`, `secrets.key`);
}

// The key file is text on purpose: it can be backed up in a password manager,
// copied during server migration, or inspected without specialized tooling.
function ensureSecretKeyFile(filePath, key = generateSecretKey()) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });

	if (!fs.existsSync(filePath)) {
		fs.writeFileSync(filePath, `${key}\n`, {
			encoding: `utf8`,
			mode: 0o600,
		});
	}

	try {
		fs.chmodSync(path.dirname(filePath), 0o700);
		fs.chmodSync(filePath, 0o600);
	} catch {
		// Windows ACLs and some mounted file systems may not support POSIX modes.
	}

	return {
		generated: fs.readFileSync(filePath, `utf8`).trim() === key,
		key: fs.readFileSync(filePath, `utf8`).trim(),
		keyFilePath: filePath,
		source: `file`,
	};
}

// Direct keys are supported for emergency/advanced deployments, but HachiGen's
// normal path stores only HACHI_SECRETS_KEY_FILE in .env.
function readSecretKeyFromEnv(env = process.env, cwd = process.cwd()) {
	const directKey = String(env.HACHI_SECRETS_KEY || ``).trim();

	if (directKey) {
		return {
			key: directKey,
			keyFilePath: ``,
			source: `direct`,
		};
	}

	const keyFilePath = resolveKeyFilePath(env.HACHI_SECRETS_KEY_FILE || ``, cwd, env);

	if (!keyFilePath) {
		throw new Error(`HACHI_SECRETS_KEY_FILE or HACHI_SECRETS_KEY is required for encrypted .env values.`);
	}

	if (!fs.existsSync(keyFilePath)) {
		throw new Error(`HACHI_SECRETS_KEY_FILE was not found: ${keyFilePath}`);
	}

	const key = fs.readFileSync(keyFilePath, `utf8`).trim();

	if (!key) {
		throw new Error(`HACHI_SECRETS_KEY_FILE is empty: ${keyFilePath}`);
	}

	return {
		key,
		keyFilePath,
		source: `file`,
	};
}

// Key material may be HachiGen's base64url random key or a user-provided string.
// HKDF below gives the encryption code one fixed-length AES key either way.
function keyMaterial(rawKey) {
	const text = String(rawKey || ``).trim();

	if (!text) {
		throw new Error(`Secret encryption key is empty.`);
	}

	try {
		const decoded = Buffer.from(text, `base64url`);
		const normalized = decoded.toString(`base64url`).replace(/=+$/u, ``);

		if (decoded.length >= 16 && normalized === text.replace(/=+$/u, ``)) {
			return decoded;
		}
	} catch {
		// Non-base64 keys are still accepted and fed through HKDF below.
	}

	return Buffer.from(text, `utf8`);
}

function deriveEncryptionKey(rawKey) {
	return Buffer.from(crypto.hkdfSync(
		`sha256`,
		keyMaterial(rawKey),
		Buffer.from(`hachi-env-secrets-v1`, `utf8`),
		Buffer.from(`hachi-env-secret-values`, `utf8`),
		32,
	));
}

function keyFingerprintFromDerivedKey(key) {
	return crypto.createHash(`sha256`).update(key).digest(`base64url`).slice(0, 16);
}

function secretAad(field) {
	return Buffer.from(`hachi-env-secret:v1:${field}`, `utf8`);
}

// Encrypt one value. The field name is authenticated data, which prevents a
// copied ciphertext from decrypting under another .env key name.
function encryptSecretValue(field, value, rawKey) {
	if (isMissingSecretValue(value)) {
		return ``;
	}

	if (isEncryptedValue(value)) {
		return String(value);
	}

	const key = deriveEncryptionKey(rawKey);
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv(`aes-256-gcm`, key, iv);

	cipher.setAAD(secretAad(field));

	const ciphertext = Buffer.concat([
		cipher.update(String(value), `utf8`),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();

	return [
		`enc`,
		`v1`,
		`aes-256-gcm`,
		keyFingerprintFromDerivedKey(key),
		iv.toString(`base64url`),
		tag.toString(`base64url`),
		ciphertext.toString(`base64url`),
	].join(`:`);
}

// Decrypt one envelope and fail closed. Callers should not fall back to
// plaintext when this throws, because that would hide key mismatch problems.
function decryptSecretValue(field, value, rawKey) {
	const text = String(value || ``);
	const parts = text.split(`:`);

	if (parts.length !== 7 || parts[0] !== `enc` || parts[1] !== `v1` || parts[2] !== `aes-256-gcm`) {
		throw new Error(`${field} is not a supported encrypted .env value.`);
	}

	const key = deriveEncryptionKey(rawKey);
	const expectedKeyId = keyFingerprintFromDerivedKey(key);
	const [, , , keyId, ivText, tagText, ciphertextText] = parts;

	try {
		const decipher = crypto.createDecipheriv(`aes-256-gcm`, key, Buffer.from(ivText, `base64url`));
		decipher.setAAD(secretAad(field));
		decipher.setAuthTag(Buffer.from(tagText, `base64url`));

		return Buffer.concat([
			decipher.update(Buffer.from(ciphertextText, `base64url`)),
			decipher.final(),
		]).toString(`utf8`);
	} catch (error) {
		const detail = keyId && keyId !== expectedKeyId ? ` the configured key does not match this value` : ` ${error.message}`;
		throw new Error(`Could not decrypt ${field};${detail}.`);
	}
}

// Inspecting is separate from decrypting so configCheck and HachiGen can report
// "plaintext", "missing", and "encrypted" states without exposing values.
function inspectEnvValues(values, { fields = null } = {}) {
	const fieldNames = fields || Object.keys(values).filter(isProtectableEnvField);
	const encryptedFields = [];
	const missingFields = [];
	const plaintextFields = [];
	const protectedFields = {};

	for (const field of fieldNames) {
		const value = values[field];
		const missing = isMissingSecretValue(value);
		const encrypted = !missing && isEncryptedValue(value);
		const plaintext = !missing && !encrypted;

		if (missing) {
			missingFields.push(field);
		} else if (encrypted) {
			encryptedFields.push(field);
		} else if (plaintext) {
			plaintextFields.push(field);
		}

		protectedFields[field] = {
			encrypted,
			hasValue: !missing,
			plaintext,
		};
	}

	return {
		encryptedFields,
		fields: protectedFields,
		missingFields,
		plaintextFields,
	};
}

function inspectEnvFile(envPath, options = {}) {
	return inspectEnvValues(parseDotEnvFile(envPath), options);
}

// Runtime entry point: mutate process.env in memory so existing modules can keep
// reading process.env.TOKEN/process.env.twitchSecret without knowing about files.
function decryptEnvSecrets(env = process.env, {
	cwd = process.cwd(),
	fields = null,
} = {}) {
	const fieldNames = fields || Object.keys(env).filter(field => isEncryptedValue(env[field]));
	const metadata = inspectEnvValues(env, { fields: fieldNames });
	const encryptedFields = fieldNames.filter(field => isEncryptedValue(env[field]));

	if (!encryptedFields.length) {
		return {
			...metadata,
			decryptedFields: [],
			keyInfo: null,
		};
	}

	const keyInfo = readSecretKeyFromEnv(env, cwd);
	const decryptedFields = [];

	for (const field of encryptedFields) {
		env[field] = decryptSecretValue(field, env[field], keyInfo.key);
		decryptedFields.push(field);
	}

	return {
		...metadata,
		decryptedFields,
		keyInfo: {
			keyFilePath: keyInfo.keyFilePath,
			source: keyInfo.source,
		},
	};
}

// This is deliberately broad. It redacts known assignment names plus common
// token/secret/client-id labels that may appear inside provider error objects.
function redactSecretText(text) {
	const knownFields = [
		...SECRET_ENV_FIELDS,
		`HACHI_SECRETS_KEY`,
		`HACHI_DB_KEY`,
	];
	const assignmentPattern = new RegExp(
		`((?:${knownFields.map(field => field.replace(/[.*+?^${}()|[\]\\]/gu, `\\$&`)).join(`|`)})=)(?:"[^"]*"|'[^']*'|\\S+)`,
		`giu`,
	);

	return String(text || ``)
		.replace(assignmentPattern, `$1[redacted]`)
		.replace(/(client(?:ID|Id|id|Secret)|token|secret)(["':=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/giu, `$1$2[redacted]`);
}

module.exports = {
	DATABASE_PROTECTION_ENV_FIELDS,
	ENCRYPTED_VALUE_PREFIX,
	SECRET_ENV_FIELDS,
	SECRET_PROTECTION_ENV_FIELDS,
	decryptEnvSecrets,
	decryptSecretValue,
	encryptSecretValue,
	ensureSecretKeyFile,
	generateSecretKey,
	getDefaultSecretKeyFile,
	inspectEnvFile,
	inspectEnvValues,
	isEnabledValue,
	isEncryptedValue,
	isMissingSecretValue,
	isProtectableEnvField,
	parseDotEnvContent,
	parseDotEnvFile,
	readSecretKeyFromEnv,
	redactSecretText,
	resolveKeyFilePath,
};
