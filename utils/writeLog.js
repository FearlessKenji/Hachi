const { dateToString } = require(`./dateToString.js`);
const path = require(`node:path`);
const fs = require(`node:fs`);
const tar = require(`tar`);

const baseLogsFolder = path.join(__dirname, `../logs`);

const LOG_LEVELS = {
	DEBUG: 0,
	INFO: 1,
	WARNING: 2,
	ERROR: 3,
};

let currentLogLevel = LOG_LEVELS.INFO;

const LOG_RETENTION_DAYS = 90;
const msInDay = 86400000;

// =======================
// Date Folder
// =======================

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

// =======================
// Ensure Logs
// =======================

function ensureLogs() {
	const { folder, raw, structured, crash } = getLogPaths();

	if (!fs.existsSync(baseLogsFolder)) {
		fs.mkdirSync(baseLogsFolder, { recursive: true });
	}

	if (!fs.existsSync(folder)) {
		fs.mkdirSync(folder, { recursive: true });
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
}

// =======================
// Helpers
// =======================

function getErrorFile(err) {
	if (!err?.stack) return `unknown`;

	const lines = err.stack.split(`\n`);

	for (const line of lines) {
		const match =
			line.match(/\((.*?\.js):\d+:\d+\)/) ||
			line.match(/at (.*?\.js):\d+:\d+/);

		if (match) return path.basename(match[1]);
	}

	return `unknown`;
}

function cleanError(err) {
	if (!err) return null;

	return {
		message: err.message || String(err),
		file: getErrorFile(err),
	};
}

// =======================
// Crash Log Format
// =======================

function writeCrashDump(type, err) {
	ensureLogs();

	const { crash } = getLogPaths();
	const timestamp = dateToString(Date.now());

	const crashText =
		`\n[CRASH] [${type}] [${timestamp}]\n` +
		`Message: ${err?.message || String(err)}\n` +
		(err?.stack ? `Stack:\n${err.stack}\n` : ``) +
		(err?.cause ? `Cause:\n${String(err.cause)}\n` : ``) +
		`\n`;

	fs.appendFileSync(crash, crashText);
}

// =======================
// Compression
// =======================

function parseFolderDate(name) {
	const date = new Date(name);
	return isNaN(date.getTime()) ? null : date;
}

async function compressFolderToTarGz(folderPath, outputPath) {
	try {
		await tar.c(
			{
				gzip: true,
				file: outputPath,
				cwd: folderPath,
			},
			['.']
		);
	} catch (err) {
		console.error(`[LOGGER] Compression failed:`, err);
	}
}

// =======================
// Cleanup
// =======================

async function cleanupOldLogs() {
	if (!fs.existsSync(baseLogsFolder)) return;

	const folders = fs.readdirSync(baseLogsFolder);
	const now = Date.now();

	for (const folder of folders) {
		const fullPath = path.join(baseLogsFolder, folder);

		if (!fs.statSync(fullPath).isDirectory()) continue;

		const folderDate = parseFolderDate(folder);
		if (!folderDate) continue;

		const ageDays = (now - folderDate.getTime()) / msInDay;

		if (ageDays <= LOG_RETENTION_DAYS) continue;

		const archivePath = path.join(
			baseLogsFolder,
			`${folder}.tar.gz`
		);

		if (fs.existsSync(archivePath)) {
			fs.rmSync(fullPath, { recursive: true, force: true });
			continue;
		}

		await compressFolderToTarGz(fullPath, archivePath);

		fs.rmSync(fullPath, { recursive: true, force: true });
	}
}

// =======================
// Scheduler
// =======================

setInterval(() => {
	cleanupOldLogs().catch(err => {
		console.error(`[LOGGER] Cleanup error:`, err);
	});
}, 6 * 60 * 60 * 1000); // every 6 hours

// =======================
// Core Logger
// =======================

function writeLog(
	message,
	err = null,
	{
		level = err ? `ERROR` : `INFO`,
		module = null,
		includeStructured = true,
	} = {},
) {
	ensureLogs();

	const { raw, structured } = getLogPaths();

	const timestamp = dateToString(Date.now());
	const levelUpper = level.toUpperCase();
	const numericLevel = LOG_LEVELS[levelUpper] ?? LOG_LEVELS.INFO;

	// =======================
	// Raw Logs
	// =======================

	let rawText = `[${timestamp}] [${levelUpper}]`;

	if (module) rawText += ` [${module}]`;

	rawText += ` ${message}`;

	if (err) {
		rawText += `\n→ ${err.message}`;

		if (err.cause) {
			rawText += `\n→ cause: ${err.cause.message || err.cause}`;
		}

		if (err.stack) {
			rawText += `\n${err.stack}`;
		}
	}

	rawText += `\n`;

	fs.appendFileSync(raw, rawText);

	// =======================
	// Console
	// =======================

	if (numericLevel >= LOG_LEVELS.ERROR) {
		console.error(rawText.trim());
	} else if (numericLevel >= LOG_LEVELS.WARNING) {
		console.warn(rawText.trim());
	} else {
		console.log(rawText.trim());
	}

	// =======================
	// Structured Log
	// =======================

	if (!includeStructured) return rawText;

	if (numericLevel < LOG_LEVELS.INFO) return rawText;

	const structuredObj = {
		timestamp,
		level: levelUpper,
		module,
		message,
		error: cleanError(err),
	};

	fs.appendFileSync(structured, JSON.stringify(structuredObj) + `\n`);

	return rawText.trim();
}

// =======================
// Wrappers
// =======================

function info(message, options = {}) {
	return writeLog(message, null, { ...options, level: `INFO` });
}

function warn(message, options = {}) {
	return writeLog(message, null, { ...options, level: `WARNING` });
}

function error(message, err, options = {}) {
	return writeLog(message, err, { ...options, level: `ERROR` });
}

function debug(message, options = {}) {
	return writeLog(message, null, { ...options, level: `DEBUG` });
}

// =======================
// Crash Handlers
// =======================

function initCrashHandlers() {
	process.on(`uncaughtException`, (err) => {
		writeLog(`Uncaught Exception`, err, { module: `crash-handler` });
		writeCrashDump(`uncaughtException`, err);

		setTimeout(() => process.exit(1), 100);
	});

	process.on(`unhandledRejection`, (reason) => {
		const err =
			reason instanceof Error ? reason : new Error(String(reason));

		writeLog(`Unhandled Rejection`, err, { module: `crash-handler` });
		writeCrashDump(`unhandledRejection`, err);
	});
}

// =======================
// Export
// =======================

module.exports = {
	info,
	warn,
	error,
	debug,
	initCrashHandlers,
};