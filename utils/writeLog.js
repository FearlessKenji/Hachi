const { dateToString } = require(`./dateToString.js`);
const path = require(`node:path`);
const fs = require(`node:fs`);
const tar = require(`tar`);

const baseLogsFolder = path.join(__dirname, `../logs`);
const LOG_ARCHIVE_AFTER_DAYS = 1;
const LOG_DELETE_ARCHIVES_AFTER_DAYS = 30;
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MS_IN_DAY = 86400000;

const LOG_LEVELS = {
	DEBUG: 0,
	INFO: 1,
	WARNING: 2,
	ERROR: 3,
};

let currentLogLevel = LOG_LEVELS.INFO;
let cleanupInterval = null;
let cleanupPromise = null;
let crashHandlersInitialized = false;

function getDateFolder() {
	const date = new Date().toISOString().split(`T`)[0];

	return path.join(baseLogsFolder, date);
}

function getLogPaths() {
	const folder = getDateFolder();

	return {
		folder,
		raw: path.join(folder, `raw.log`),
		structured: path.join(folder, `structured.log`),
		crash: path.join(folder, `crash.log`),
	};
}

function ensureLogs() {
	const { folder, raw, structured, crash } = getLogPaths();
	let createdDateFolder = false;

	if (!fs.existsSync(baseLogsFolder)) {
		fs.mkdirSync(baseLogsFolder, { recursive: true });
	}

	if (!fs.existsSync(folder)) {
		fs.mkdirSync(folder, { recursive: true });
		createdDateFolder = true;
	}

	if (!fs.existsSync(raw)) {
		fs.writeFileSync(raw, `=== RAW LOG START ===\n`);
	}

	if (!fs.existsSync(structured)) {
		fs.writeFileSync(structured, ``);
	}

	if (!fs.existsSync(crash)) {
		fs.writeFileSync(crash, `=== CRASH LOG START ===\n`);
	}

	if (createdDateFolder) {
		runLogCleanup();
	}
}

function safeStringify(value) {
	if (typeof value === `string`) {
		return value;
	}

	if (value instanceof Error) {
		return value.message || value.name;
	}

	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function isOptionsObject(value) {
	if (!value || value instanceof Error || Array.isArray(value)) {
		return false;
	}

	if (typeof value !== `object`) {
		return false;
	}

	return [`level`, `module`, `includeStructured`, `meta`].some(key => Object.prototype.hasOwnProperty.call(value, key));
}

function normalizeOptions(options) {
	if (!options) {
		return {};
	}

	if (typeof options === `string`) {
		return { meta: { detail: options } };
	}

	if (typeof options === `object` && !Array.isArray(options)) {
		return options;
	}

	return { meta: { detail: safeStringify(options) } };
}

function toError(value) {
	if (!value) {
		return null;
	}

	if (value instanceof Error) {
		return value;
	}

	return new Error(safeStringify(value));
}

function getErrorFile(err) {
	if (!err?.stack) {
		return `unknown`;
	}

	const lines = err.stack.split(`\n`);

	for (const line of lines) {
		const match =
			line.match(/\((.*?\.js):\d+:\d+\)/) ||
			line.match(/at (.*?\.js):\d+:\d+/);

		if (match) {
			return path.basename(match[1]);
		}
	}

	return `unknown`;
}

function getErrorLocation(err) {
	if (!err?.stack) {
		return null;
	}

	const lines = err.stack.split(`\n`);

	for (const line of lines) {
		const match =
			line.match(/\((.*?\.js):(\d+):(\d+)\)/) ||
			line.match(/at (.*?\.js):(\d+):(\d+)/);

		if (match) {
			return `${path.basename(match[1])}:${match[2]}:${match[3]}`;
		}
	}

	return null;
}

function getHumanMessageFromJson(value) {
	try {
		const parsed = JSON.parse(value);

		if (!parsed || typeof parsed !== `object`) {
			return null;
		}

		for (const key of [`message`, `error`, `title`, `detail`]) {
			if (typeof parsed[key] === `string` && parsed[key].trim()) {
				return parsed[key].trim();
			}
		}
	} catch {
		return null;
	}

	return null;
}

function simplifyErrorMessage(message) {
	if (!message) {
		return message;
	}

	const httpMatch = message.match(/^(HTTP\s+\d+)\s+-\s+(.+)$/s);

	if (httpMatch) {
		const humanMessage = getHumanMessageFromJson(httpMatch[2]);

		if (humanMessage) {
			return `${httpMatch[1]} - ${humanMessage}`;
		}
	}

	const humanMessage = getHumanMessageFromJson(message);

	return humanMessage || message;
}

function cleanError(err) {
	if (!err) {
		return null;
	}

	const cause = err.cause instanceof Error ?
		cleanError(err.cause) :
		err.cause ? safeStringify(err.cause) : null;

	return {
		name: err.name || `Error`,
		message: err.message || String(err),
		file: getErrorFile(err),
		stack: err.stack || null,
		cause,
	};
}

function combineErrors(primary, secondary) {
	const primaryError = toError(primary);
	const secondaryError = toError(secondary);

	if (!primaryError) {
		return secondaryError;
	}

	if (!secondaryError) {
		return primaryError;
	}

	const combined = new Error(`${primaryError.message}; ${secondaryError.message}`);
	combined.name = `CombinedError`;
	combined.stack = [
		primaryError.stack || primaryError.message,
		``,
		`Secondary error:`,
		secondaryError.stack || secondaryError.message,
	].join(`\n`);
	combined.cause = secondaryError;

	return combined;
}

function normalizeLogInput(message, err, options) {
	const normalizedOptions = normalizeOptions(options);
	let normalizedMessage = message;
	let normalizedError = toError(err);

	if (message instanceof Error && err) {
		normalizedError = combineErrors(message, err);
		normalizedMessage = message.message;
	} else if (message instanceof Error) {
		normalizedError = message;
		normalizedMessage = message.message;
	}

	return {
		err: normalizedError,
		message: safeStringify(normalizedMessage),
		options: normalizedOptions,
	};
}

function formatRawLog({ timestamp, level, moduleName, message, err, meta }) {
	let rawText = `[${timestamp}] [${level}]`;

	if (moduleName) {
		rawText += ` [${moduleName}]`;
	}

	rawText += ` ${message}`;

	if (meta) {
		rawText += `\nmeta: ${safeStringify(meta)}`;
	}

	if (err) {
		rawText += `\nerror: ${err.message || String(err)}`;

		if (err.cause) {
			rawText += `\ncause: ${safeStringify(err.cause)}`;
		}

		if (err.stack) {
			rawText += `\n${err.stack}`;
		}
	}

	return `${rawText}\n`;
}

function formatConsoleLog({ timestamp, level, moduleName, message, err, meta }) {
	const lines = [];
	let header = `[${timestamp}] [${level}]`;

	if (moduleName) {
		header += ` [${moduleName}]`;
	}

	header += ` ${message}`;
	lines.push(header);

	if (meta) {
		lines.push(`meta: ${safeStringify(meta)}`);
	}

	if (err) {
		const name = err.name || `Error`;
		const summary = simplifyErrorMessage(err.message || String(err));
		const location = getErrorLocation(err);
		const locationText = location ? ` (${location})` : ``;

		lines.push(`${name}: ${summary}${locationText}`);

		if (err.cause) {
			lines.push(`Caused by: ${safeStringify(err.cause)}`);
		}
	}

	return lines.join(`\n`);
}

function writeStructuredLog(structuredPath, entry) {
	fs.appendFileSync(structuredPath, `${JSON.stringify(entry)}\n`);
}

function writeCrashDump(type, err) {
	try {
		ensureLogs();

		const { crash } = getLogPaths();
		const timestamp = dateToString(Date.now());
		const normalizedError = toError(err);
		const crashText = [
			``,
			`[CRASH] [${type}] [${timestamp}]`,
			`Message: ${normalizedError?.message || safeStringify(err)}`,
			normalizedError?.stack ? `Stack:\n${normalizedError.stack}` : null,
			normalizedError?.cause ? `Cause:\n${safeStringify(normalizedError.cause)}` : null,
			``,
		].filter(line => line !== null).join(`\n`);

		fs.appendFileSync(crash, `${crashText}\n`);
	} catch (logErr) {
		console.error(`[LOGGER] Failed to write crash dump:`, logErr);
	}
}

function parseLogDateName(name) {
	const match = name.match(/^(\d{4})-(\d{2})-(\d{2})(?:\.tar\.gz)?$/);

	if (!match) {
		return null;
	}

	const date = new Date(`${name}T00:00:00.000Z`);

	if (Number.isNaN(date.getTime())) {
		return null;
	}

	return date;
}

function getAgeDays(date, now) {
	return (now - date.getTime()) / MS_IN_DAY;
}

async function compressFolderToTarGz(folderPath, outputPath) {
	const tempPath = `${outputPath}.tmp`;

	try {
		if (fs.existsSync(tempPath)) {
			fs.rmSync(tempPath, { force: true });
		}

		await tar.c(
			{
				gzip: true,
				file: tempPath,
				cwd: folderPath,
			},
			[`.`],
		);

		fs.renameSync(tempPath, outputPath);

		return true;
	} catch (err) {
		if (fs.existsSync(tempPath)) {
			fs.rmSync(tempPath, { force: true });
		}

		console.error(`[LOGGER] Compression failed:`, err);
		return false;
	}
}

async function cleanupOldLogs() {
	if (!fs.existsSync(baseLogsFolder)) {
		return;
	}

	const entries = fs.readdirSync(baseLogsFolder, { withFileTypes: true });
	const now = Date.now();

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}

		const folderDate = parseLogDateName(entry.name);

		if (!folderDate) {
			continue;
		}

		if (getAgeDays(folderDate, now) < LOG_ARCHIVE_AFTER_DAYS) {
			continue;
		}

		const folderPath = path.join(baseLogsFolder, entry.name);
		const archivePath = path.join(
			baseLogsFolder,
			`${entry.name}.tar.gz`,
		);

		if (!fs.existsSync(archivePath)) {
			const compressed = await compressFolderToTarGz(folderPath, archivePath);

			if (!compressed) {
				continue;
			}
		}

		fs.rmSync(folderPath, { recursive: true, force: true });
	}

	const archiveEntries = fs.readdirSync(baseLogsFolder, { withFileTypes: true });

	for (const entry of archiveEntries) {
		if (!entry.isFile() || !entry.name.endsWith(`.tar.gz`)) {
			continue;
		}

		const archiveDate = parseLogDateName(entry.name);

		if (!archiveDate || getAgeDays(archiveDate, now) < LOG_DELETE_ARCHIVES_AFTER_DAYS) {
			continue;
		}

		fs.rmSync(path.join(baseLogsFolder, entry.name), { force: true });
	}
}

function runLogCleanup() {
	if (cleanupPromise) {
		return cleanupPromise;
	}

	cleanupPromise = cleanupOldLogs()
		.catch(err => {
			console.error(`[LOGGER] Cleanup error:`, err);
		})
		.finally(() => {
			cleanupPromise = null;
		});

	return cleanupPromise;
}

function startLogCleanup({ runImmediately = false } = {}) {
	if (cleanupInterval) {
		return cleanupInterval;
	}

	if (runImmediately) {
		runLogCleanup();
	}

	cleanupInterval = setInterval(() => {
		runLogCleanup();
	}, LOG_CLEANUP_INTERVAL_MS);

	return cleanupInterval;
}

function stopLogCleanup() {
	if (!cleanupInterval) {
		return;
	}

	clearInterval(cleanupInterval);
	cleanupInterval = null;
}

function getNumericLevel(level) {
	return LOG_LEVELS[level?.toUpperCase?.()] ?? LOG_LEVELS.INFO;
}

function setLogLevel(level) {
	const levelUpper = level.toUpperCase();

	if (!Object.prototype.hasOwnProperty.call(LOG_LEVELS, levelUpper)) {
		throw new Error(`Unknown log level: ${level}`);
	}

	currentLogLevel = LOG_LEVELS[levelUpper];
}

function writeLog(message, err = null, options = {}) {
	let effectiveErr = err;
	let effectiveOptions = options;

	if (arguments.length === 2 && isOptionsObject(err)) {
		effectiveOptions = err;
		effectiveErr = null;
	}

	const normalized = normalizeLogInput(message, effectiveErr, effectiveOptions);
	const {
		includeStructured = true,
		level = normalized.err ? `ERROR` : `INFO`,
		meta = null,
		module: moduleName = null,
	} = normalized.options;
	const levelUpper = level.toUpperCase();
	const numericLevel = getNumericLevel(levelUpper);

	if (numericLevel < currentLogLevel) {
		return null;
	}

	const timestamp = dateToString(Date.now());
	const rawText = formatRawLog({
		err: normalized.err,
		level: levelUpper,
		message: normalized.message,
		meta,
		moduleName,
		timestamp,
	});
	const consoleText = formatConsoleLog({
		err: normalized.err,
		level: levelUpper,
		message: normalized.message,
		meta,
		moduleName,
		timestamp,
	});

	try {
		ensureLogs();

		const { raw, structured } = getLogPaths();

		fs.appendFileSync(raw, rawText);

		if (includeStructured) {
			writeStructuredLog(structured, {
				timestamp,
				level: levelUpper,
				module: moduleName,
				message: normalized.message,
				meta,
				error: cleanError(normalized.err),
			});
		}
	} catch (logErr) {
		console.error(`[LOGGER] Failed to write log file:`, logErr);
	}

	if (numericLevel >= LOG_LEVELS.ERROR) {
		console.error(consoleText);
	} else if (numericLevel >= LOG_LEVELS.WARNING) {
		console.warn(consoleText);
	} else {
		console.log(consoleText);
	}

	return rawText.trim();
}

function info(message, options = {}) {
	return writeLog(message, null, { ...normalizeOptions(options), level: `INFO` });
}

function warn(message, options = {}) {
	return writeLog(message, null, { ...normalizeOptions(options), level: `WARNING` });
}

function error(message, err = null, options = {}) {
	return writeLog(message, err, { ...normalizeOptions(options), level: `ERROR` });
}

function debug(message, options = {}) {
	return writeLog(message, null, { ...normalizeOptions(options), level: `DEBUG` });
}

function initCrashHandlers() {
	if (crashHandlersInitialized) {
		return;
	}

	crashHandlersInitialized = true;

	process.on(`uncaughtException`, (err) => {
		writeLog(`Uncaught Exception`, err, { module: `crash-handler` });
		writeCrashDump(`uncaughtException`, err);

		setTimeout(() => process.exit(1), 100);
	});

	process.on(`unhandledRejection`, (reason) => {
		const err = reason instanceof Error ?
			reason :
			new Error(safeStringify(reason));

		writeLog(`Unhandled Rejection`, err, { module: `crash-handler` });
		writeCrashDump(`unhandledRejection`, err);
	});
}

module.exports = {
	cleanupOldLogs,
	debug,
	error,
	info,
	initCrashHandlers,
	setLogLevel,
	startLogCleanup,
	stopLogCleanup,
	warn,
	writeLog,
};
