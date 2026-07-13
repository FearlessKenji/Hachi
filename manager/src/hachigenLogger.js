// Persistent AppData logger for HachiGen.
//
// HachiGen runs outside the bot process, so its own diagnostics need to survive
// even when Hachi cannot start. This logger mirrors Hachi's daily-folder style
// while keeping the storage location in Electron userData/AppData.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { Buffer } = require("node:buffer");

const LOG_ARCHIVE_AFTER_DAYS = 1;
const LOG_DELETE_ARCHIVES_AFTER_DAYS = 30;
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MS_IN_DAY = 86400000;
const LOG_LEVELS = new Set(["DEBUG", "INFO", "WARNING", "ERROR"]);
const REDACTED = "[redacted]";
const SECRET_FIELDS = [
	"TOKEN",
	"clientId",
	"twitchClientId",
	"twitchSecret",
	"kickClientId",
	"kickSecret",
	"HACHI_DB_KEY",
	"HACHI_SECRETS_KEY",
];

const noop = () => undefined;

function getDefaultHachiGenUserDataPath() {
	const home = os.homedir();

	if (process.platform === "win32") {
		return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "HachiGen");
	}

	if (process.platform === "darwin") {
		return path.join(home, "Library", "Application Support", "HachiGen");
	}

	return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "HachiGen");
}

function dateFolderName(date = new Date()) {
	return new Date(date).toISOString().slice(0, 10);
}

function redactHachiGenLogText(text) {
	const escapedFields = SECRET_FIELDS
		.map(field => field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
		.join("|");
	const assignmentPattern = new RegExp(`((?:${escapedFields})=)(?:"[^"]*"|'[^']*'|\\S+)`, "giu");

	return String(text || "")
		.replace(assignmentPattern, `$1${REDACTED}`)
		.replace(/(client(?:ID|Id|id|Secret)|token|secret)(["':=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/giu, `$1$2${REDACTED}`);
}

function safeStringify(value) {
	if (typeof value === "string") {
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

function sanitizeLogValue(value, seen = new WeakSet()) {
	if (typeof value === "string") {
		return redactHachiGenLogText(value);
	}

	if (value instanceof Error) {
		return {
			message: redactHachiGenLogText(value.message),
			name: value.name,
			stack: redactHachiGenLogText(value.stack || ""),
		};
	}

	if (!value || typeof value !== "object") {
		return value;
	}

	if (seen.has(value)) {
		return "[circular]";
	}

	seen.add(value);

	if (Array.isArray(value)) {
		return value.map(item => sanitizeLogValue(item, seen));
	}

	return Object.fromEntries(Object.entries(value).map(([key, item]) => [
		key,
		sanitizeLogValue(item, seen),
	]));
}

function normalizeLevel(type, details = {}) {
	const candidate = String(details.level || "").toUpperCase();

	if (LOG_LEVELS.has(candidate)) {
		return candidate;
	}

	return type === "error" ? "ERROR" : "INFO";
}

function normalizeArea(type, details = {}) {
	if (details.area) {
		return String(details.area);
	}

	if (type === "shell") {
		return details.stream ? `shell:${details.stream}` : "shell";
	}

	return details.source ? String(details.source) : "manager";
}

function parseLogDateName(name) {
	const match = String(name).match(/^(\d{4})-(\d{2})-(\d{2})(?:\.tar\.gz)?$/u);

	if (!match) {
		return null;
	}

	const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);

	return Number.isNaN(date.getTime()) ? null : date;
}

function getAgeDays(date, now) {
	return (now - date.getTime()) / MS_IN_DAY;
}

function writeTarString(buffer, value, offset, length) {
	buffer.write(String(value).slice(0, length), offset, length, "ascii");
}

function writeTarOctal(buffer, value, offset, length) {
	const text = Math.max(0, Number(value) || 0)
		.toString(8)
		.padStart(length - 1, "0")
		.slice(-(length - 1));

	buffer.write(`${text}\0`, offset, length, "ascii");
}

function buildTarHeader({ name, size, mtime }) {
	const header = Buffer.alloc(512);

	writeTarString(header, name, 0, 100);
	writeTarOctal(header, 0o644, 100, 8);
	writeTarOctal(header, 0, 108, 8);
	writeTarOctal(header, 0, 116, 8);
	writeTarOctal(header, size, 124, 12);
	writeTarOctal(header, Math.floor(mtime / 1000), 136, 12);
	header.fill(0x20, 148, 156);
	header[156] = "0".charCodeAt(0);
	writeTarString(header, "ustar", 257, 6);
	writeTarString(header, "00", 263, 2);

	let checksum = 0;

	for (const byte of header) {
		checksum += byte;
	}

	header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
	header[154] = 0;
	header[155] = 0x20;

	return header;
}

function collectArchiveFiles(folderPath, basePath = folderPath) {
	return fs.readdirSync(folderPath, { withFileTypes: true })
		.flatMap(entry => {
			const fullPath = path.join(folderPath, entry.name);

			if (entry.isDirectory()) {
				return collectArchiveFiles(fullPath, basePath);
			}

			if (!entry.isFile()) {
				return [];
			}

			return [{
				fullPath,
				name: path.relative(basePath, fullPath).replace(/\\/gu, "/"),
				stat: fs.statSync(fullPath),
			}];
		})
		.filter(file => file.name.length <= 100);
}

function buildTarGz(folderPath) {
	const parts = [];

	for (const file of collectArchiveFiles(folderPath)) {
		const content = fs.readFileSync(file.fullPath);
		const padding = Buffer.alloc((512 - (content.length % 512)) % 512);

		parts.push(buildTarHeader({
			mtime: file.stat.mtimeMs,
			name: file.name,
			size: content.length,
		}));
		parts.push(content, padding);
	}

	parts.push(Buffer.alloc(1024));

	return zlib.gzipSync(Buffer.concat(parts));
}

class HachiGenLogger {
	constructor({ userDataPath, sendEvent = noop } = {}) {
		this.userDataPath = userDataPath || getDefaultHachiGenUserDataPath();
		this.logsPath = path.join(this.userDataPath, "logs");
		this.sendEvent = sendEvent;
		this.cleanupInterval = null;
		this.cleanupPromise = null;
		this.crashHandlersInitialized = false;
	}

	getLogPaths(date = new Date()) {
		const folder = path.join(this.logsPath, dateFolderName(date));

		return {
			crash: path.join(folder, "crash.log"),
			folder,
			raw: path.join(folder, "raw.log"),
			structured: path.join(folder, "structured.log"),
			structuredPretty: path.join(folder, "structured.pretty.log"),
		};
	}

	ensureLogs() {
		const paths = this.getLogPaths();

		fs.mkdirSync(paths.folder, { recursive: true });

		if (!fs.existsSync(paths.raw)) {
			fs.writeFileSync(paths.raw, "=== HACHIGEN RAW LOG START ===\n");
		}

		if (!fs.existsSync(paths.structured)) {
			fs.writeFileSync(paths.structured, "");
		}

		if (!fs.existsSync(paths.structuredPretty)) {
			fs.writeFileSync(paths.structuredPretty, "");
		}

		if (!fs.existsSync(paths.crash)) {
			fs.writeFileSync(paths.crash, "=== HACHIGEN CRASH LOG START ===\n");
		}

		return paths;
	}

	normalizeEvent({ type = "log", message = "", details = {}, time = new Date().toISOString() } = {}) {
		const sanitizedDetails = sanitizeLogValue(details) || {};
		const normalizedType = type === "error" || type === "shell" ? type : "log";

		return {
			area: normalizeArea(normalizedType, sanitizedDetails),
			details: sanitizedDetails,
			level: normalizeLevel(normalizedType, sanitizedDetails),
			message: redactHachiGenLogText(message),
			time,
			type: normalizedType,
		};
	}

	formatRawLine(event) {
		const details = event.details && Object.keys(event.details).length ?
			` ${JSON.stringify(event.details)}` :
			"";

		return `[${event.time}] [${event.level}] [${event.area}] ${event.message}${details}\n`;
	}

	writeEvent(rawEvent) {
		const event = this.normalizeEvent(rawEvent);

		try {
			const paths = this.ensureLogs();

			fs.appendFileSync(paths.raw, this.formatRawLine(event));
			fs.appendFileSync(paths.structured, `${JSON.stringify(event)}\n`);
			fs.appendFileSync(paths.structuredPretty, `${JSON.stringify(event, null, "\t")}\n`);
		} catch (error) {
			console.error("[HACHIGEN LOGGER] Failed to write log file:", error);
		}

		return event;
	}

	writeCrashDump(type, error) {
		try {
			const paths = this.ensureLogs();
			const cleanError = sanitizeLogValue(error);
			const crashText = [
				"",
				`[CRASH] [${type}] [${new Date().toISOString()}]`,
				`Message: ${redactHachiGenLogText(safeStringify(error))}`,
				cleanError?.stack ? `Stack:\n${cleanError.stack}` : null,
				cleanError?.cause ? `Cause:\n${safeStringify(cleanError.cause)}` : null,
				"",
			].filter(line => line !== null).join("\n");

			fs.appendFileSync(paths.crash, `${crashText}\n`);
		} catch (logError) {
			console.error("[HACHIGEN LOGGER] Failed to write crash dump:", logError);
		}
	}

	readRecentEvents(limit = 160) {
		try {
			const structuredPath = this.getLogPaths().structured;

			if (!fs.existsSync(structuredPath)) {
				return [];
			}

			return fs.readFileSync(structuredPath, "utf8")
				.split(/\r?\n/u)
				.filter(Boolean)
				.slice(-limit)
				.map(line => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				})
				.filter(Boolean);
		} catch {
			return [];
		}
	}

	async compressFolderToTarGz(folderPath, archivePath) {
		const tempPath = `${archivePath}.tmp`;

		try {
			if (fs.existsSync(tempPath)) {
				fs.rmSync(tempPath, { force: true });
			}

			fs.writeFileSync(tempPath, buildTarGz(folderPath));
			fs.renameSync(tempPath, archivePath);
			return true;
		} catch (error) {
			if (fs.existsSync(tempPath)) {
				fs.rmSync(tempPath, { force: true });
			}

			console.error("[HACHIGEN LOGGER] Compression failed:", error);
			return false;
		}
	}

	async cleanupOldLogs({ now = Date.now() } = {}) {
		if (!fs.existsSync(this.logsPath)) {
			return;
		}

		const entries = fs.readdirSync(this.logsPath, { withFileTypes: true });

		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}

			const folderDate = parseLogDateName(entry.name);

			if (!folderDate || getAgeDays(folderDate, now) < LOG_ARCHIVE_AFTER_DAYS) {
				continue;
			}

			const folderPath = path.join(this.logsPath, entry.name);
			const archivePath = path.join(this.logsPath, `${entry.name}.tar.gz`);

			if (!fs.existsSync(archivePath) && !await this.compressFolderToTarGz(folderPath, archivePath)) {
				continue;
			}

			fs.rmSync(folderPath, { force: true, recursive: true });
		}

		for (const entry of fs.readdirSync(this.logsPath, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".tar.gz")) {
				continue;
			}

			const archiveDate = parseLogDateName(entry.name);

			if (archiveDate && getAgeDays(archiveDate, now) >= LOG_DELETE_ARCHIVES_AFTER_DAYS) {
				fs.rmSync(path.join(this.logsPath, entry.name), { force: true });
			}
		}
	}

	runLogCleanup(options = {}) {
		if (this.cleanupPromise) {
			return this.cleanupPromise;
		}

		this.cleanupPromise = this.cleanupOldLogs(options)
			.catch(error => {
				console.error("[HACHIGEN LOGGER] Cleanup error:", error);
			})
			.finally(() => {
				this.cleanupPromise = null;
			});

		return this.cleanupPromise;
	}

	startLogCleanup({ runImmediately = false } = {}) {
		if (runImmediately) {
			this.runLogCleanup();
		}

		if (this.cleanupInterval) {
			return this.cleanupInterval;
		}

		this.cleanupInterval = setInterval(() => {
			this.runLogCleanup();
		}, LOG_CLEANUP_INTERVAL_MS);

		if (typeof this.cleanupInterval.unref === "function") {
			this.cleanupInterval.unref();
		}

		return this.cleanupInterval;
	}

	stopLogCleanup() {
		if (!this.cleanupInterval) {
			return;
		}

		clearInterval(this.cleanupInterval);
		this.cleanupInterval = null;
	}

	initCrashHandlers() {
		if (this.crashHandlersInitialized) {
			return;
		}

		this.crashHandlersInitialized = true;

		process.on("uncaughtException", error => {
			this.writeCrashDump("uncaughtException", error);
			this.writeEvent({
				details: { area: "crash-handler" },
				message: `Uncaught Exception: ${error.message || error}`,
				type: "error",
			});
		});

		process.on("unhandledRejection", reason => {
			const error = reason instanceof Error ? reason : new Error(safeStringify(reason));

			this.writeCrashDump("unhandledRejection", error);
			this.writeEvent({
				details: { area: "crash-handler" },
				message: `Unhandled Rejection: ${error.message || error}`,
				type: "error",
			});
		});
	}
}

module.exports = {
	HachiGenLogger,
	dateFolderName,
	getDefaultHachiGenUserDataPath,
	redactHachiGenLogText,
};
