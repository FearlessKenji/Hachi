const fs = require("node:fs");
const path = require("node:path");
const { commandExists, run } = require("./shell.js");

// This file contains HachiGen's backend coordinator.
// The renderer never edits files or runs commands directly; it asks this class
// to validate installs, save configuration, check Git updates, deploy commands,
// and control the Hachi PM2 process.

// The repository HachiGen clones when the selected install folder is empty.
const REPO_URL = "https://github.com/FearlessKenji/Hachi.git";
const UPDATE_REMOTE = "origin";
const UPDATE_BRANCH = "main";
const UPDATE_TARGET = `${UPDATE_REMOTE}/${UPDATE_BRANCH}`;

function createUncheckedUpdateState(message = "Updates have not been checked yet.") {
	return {
		status: "unchecked",
		available: false,
		checkedAt: null,
		updateTarget: UPDATE_TARGET,
		message,
	};
}

// PM2 process name used by the bot itself. If this changes in Hachi's
// ecosystem config, it should change here too.
const PROCESS_NAME = "Hachi";

// Auto-stashes created by HachiGen use this text so they can be found later
// without confusing them with the user's own manual Git stashes.
const HACHIGEN_STASH_PREFIX = "HachiGen auto-stash before update";

// Values stored in the .env file. These are secrets or API/client IDs.
const ENV_FIELDS = [
	"TOKEN",
	"clientId",
	"twitchClientId",
	"twitchSecret",
	"kickClientId",
	"kickSecret",
];

// Values stored in config/config.json. These are bot settings rather than
// process environment variables.
const CONFIG_FIELDS = [
	"botOwner",
	"guildId",
	"twitchCron",
	"kickCron",
	"birthdayCron",
	"statusCron",
	"authCron",
];

// Defaults used when a new config file is written and no value exists yet.
const CONFIG_DEFAULTS = {
	twitchCron: "*/1 * * * *",
	kickCron: "*/1 * * * *",
	birthdayCron: "0 * * * *",
	statusCron: "*/10 * * * *",
	authCron: "0 * * * *",
};

// The database worker is copied to Electron's user-data folder before running.
// External Node cannot reliably execute files inside a packaged app.asar.
const DATABASE_WORKER_FILE = "database-worker.js";

// Check whether a file or folder exists. This tiny wrapper keeps the rest of
// the file readable when many validation steps ask "does this path exist?".
function fileExists(filePath) {
	return fs.existsSync(filePath);
}

// Decide whether a config value should count as incomplete. Blank strings and
// template placeholders both mean the user still needs to fill that field in.
function isMissingValue(value) {
	return value === undefined ||
		value === null ||
		String(value).trim() === "" ||
		String(value).includes("(REQUIRED)");
}

// Create a directory and any missing parent folders. This makes writes safe
// even when the selected install folder is brand new.
function ensureDir(dirPath) {
	fs.mkdirSync(dirPath, { recursive: true });
}

// Default callback used when HachiManager is created without a visible window,
// such as during future tests or command-line experiments.
function noop() {
	return undefined;
}

// Read JSON safely. Missing or invalid files return the fallback so a damaged
// local config can be shown as "needs attention" instead of crashing HachiGen.
function readJson(filePath, fallback = null) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch {
		return fallback;
	}
}

// Parse Hachi's simple KEY=value .env files. HachiGen only needs enough parsing
// to load and save its known fields, so comments, blanks, and one quote layer
// are handled without bringing in a larger dotenv writer.
function parseDotEnv(filePath) {
	if (!fileExists(filePath)) {
		return {};
	}

	const values = {};
	const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

	for (const line of lines) {
		const trimmed = line.trim();

		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}

		const equalsIndex = trimmed.indexOf("=");

		if (equalsIndex === -1) {
			continue;
		}

		const key = trimmed.slice(0, equalsIndex).trim();
		let value = trimmed.slice(equalsIndex + 1).trim();

		if (
			(value.startsWith("\"") && value.endsWith("\"")) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		values[key] = value;
	}

	return values;
}

// Format one value for .env output. JSON.stringify gives safe quoting for
// secrets that contain spaces, punctuation, or backslashes.
function formatEnvValue(value) {
	return JSON.stringify(String(value || ""));
}

// Create a timestamp safe for Windows folder names. Colons are not allowed in
// normal Windows paths, so ISO timestamps are cleaned before use.
function timestampFolderName() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

// Date-only stamp used for the normal manual backup filename.
function dateStamp() {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

// Timestamp used for automatic safety backups that should never collide.
function fileTimestamp() {
	const now = new Date();
	const date = dateStamp();
	const hours = String(now.getHours()).padStart(2, "0");
	const minutes = String(now.getMinutes()).padStart(2, "0");
	const seconds = String(now.getSeconds()).padStart(2, "0");
	return `${date}-${hours}${minutes}${seconds}`;
}

function formatFileSize(bytes) {
	if (!bytes) {
		return "0 B";
	}

	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unitIndex = 0;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}

	return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

// PM2 sometimes prints non-JSON text around `pm2 jlist` output. Extracting the
// array portion makes status checks more forgiving without hiding parse errors.
function parsePm2Json(stdout) {
	const text = String(stdout || "");
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");

	if (start === -1 || end === -1 || end < start) {
		return [];
	}

	return JSON.parse(text.slice(start, end + 1));
}

// Convert one `git status --porcelain` line into the object the Updates UI
// groups and displays. Example: " M manager/src/manager.js" becomes Modified.
function describeGitStatus(rawLine) {
	const code = rawLine.slice(0, 2);
	const filePath = rawLine.slice(3).trim();
	const statusCodes = code.replace(/\s/g, "").split("");
	const statusMap = {
		"?": "New",
		A: "Added",
		C: "Copied",
		D: "Deleted",
		M: "Modified",
		R: "Renamed",
		U: "Conflict",
	};

	let label = "Changed";

	if (code === "??") {
		label = "New";
	} else if (statusCodes.includes("U")) {
		label = "Conflict";
	} else if (statusCodes.includes("R")) {
		label = "Renamed";
	} else if (statusCodes.includes("A")) {
		label = "Added";
	} else if (statusCodes.includes("D")) {
		label = "Deleted";
	} else if (statusCodes.includes("M")) {
		label = "Modified";
	} else if (statusCodes.length) {
		label = statusMap[statusCodes[0]] || "Changed";
	}

	return {
		raw: rawLine,
		code,
		label,
		path: filePath,
		description: `${label}: ${filePath}`,
	};
}

// Convert one `git stash show --name-status` line into the same display shape
// used by local changes. This keeps the UI grouping code shared for current
// local changes and saved stashes.
function describeNameStatus(rawLine) {
	const parts = rawLine.split(/\t+/).filter(Boolean);
	const code = parts[0] || "";
	const status = code.charAt(0);
	const statusMap = {
		A: "Added",
		C: "Copied",
		D: "Deleted",
		M: "Modified",
		R: "Renamed",
		U: "Conflict",
	};
	const label = statusMap[status] || "Changed";
	const pathValue = (status === "R" || status === "C") && parts.length >= 3 ?
		`${parts[1]} -> ${parts[2]}` :
		parts.slice(1).join(" ");

	return {
		raw: rawLine,
		code,
		label,
		path: pathValue,
		description: `${label}: ${pathValue}`,
	};
}

// Count how many changed files fall into each friendly status label. The UI can
// use this for summaries without reparsing individual file rows.
function summarizeLocalChanges(changes) {
	const counts = changes.reduce((summary, change) => {
		summary[change.label] = (summary[change.label] || 0) + 1;
		return summary;
	}, {});

	return {
		total: changes.length,
		counts,
	};
}

// Convert a short `git log --oneline` row into structured commit data for the
// incoming updates panel.
function parseIncomingCommit(line) {
	const trimmed = line.trim();
	const firstSpace = trimmed.indexOf(" ");

	if (firstSpace === -1) {
		return {
			hash: trimmed,
			message: "",
			text: trimmed,
		};
	}

	return {
		hash: trimmed.slice(0, firstSpace),
		message: trimmed.slice(firstSpace + 1),
		text: trimmed,
	};
}

// Parse one HachiGen stash row created by:
// git stash list --format=%H%x09%gd%x09%ct%x09%gs
// The format uses tabs so stash messages with spaces remain intact.
function parseStashLine(line) {
	const [hash, ref, timestamp, ...subjectParts] = line.split("\t");
	const subject = subjectParts.join("\t");
	const message = subject.replace(/^On .*?:\s*/, "");
	const timestampNumber = Number(timestamp);

	return {
		hash,
		ref,
		subject,
		message,
		createdAt: Number.isFinite(timestampNumber) ?
			new Date(timestampNumber * 1000).toISOString() :
			null,
	};
}

class HachiManager {
	constructor({ managerRoot, defaultInstallPath, userDataPath, sendEvent }) {
		// managerRoot is the manager folder in development and the bundled app
		// location after packaging. defaultInstallPath is passed from main.js so
		// packaged HachiGen can default to the folder beside HachiGen.exe.
		this.managerRoot = managerRoot;
		this.defaultInstallPath = defaultInstallPath || path.resolve(managerRoot, "..");

		// userDataPath is Electron's app data folder, where small HachiGen
		// settings can live outside the repo.
		this.userDataPath = userDataPath || path.join(managerRoot, "data");
		this.settingsPath = path.join(this.userDataPath, "settings.json");

		// sendEvent comes from main.js and streams backend activity to the UI.
		this.sendEvent = sendEvent || noop;

		// operationLog is the in-memory activity log shown on the Logs tab.
		this.operationLog = [];

		// updateState stores the most recent update check so the UI can redraw
		// without running Git commands every time it needs a label.
		this.updateState = createUncheckedUpdateState();

		ensureDir(this.userDataPath);
		this.settings = this.loadSettings();
	}

	loadSettings() {
		// In development, this is the parent of manager/. In the packaged exe,
		// this is the folder containing HachiGen.exe.
		const defaults = {
			installPath: this.defaultInstallPath,
			activeStash: null,
		};

		return {
			...defaults,
			...readJson(this.settingsPath, {}),
		};
	}

	saveSettings() {
		// settings.json stores user choices such as install path and active stash.
		ensureDir(path.dirname(this.settingsPath));
		fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, "\t"));
	}

	event(type, message, details = {}) {
		// Every event has the same shape so the renderer can format it predictably.
		const event = {
			type,
			message,
			details,
			time: new Date().toISOString(),
		};

		this.operationLog.push(event);

		// Keep the log useful without letting it grow forever.
		if (this.operationLog.length > 500) {
			this.operationLog.shift();
		}

		this.sendEvent(event);
	}

	log(message, details = {}) {
		// Convenience wrapper for normal informational events.
		this.event("log", message, details);
	}

	logShell(entry) {
		// Shell output is tagged separately so the UI can show whether it came
		// from stdout, stderr, or the displayed command itself.
		this.event("shell", entry.message, { stream: entry.stream });
	}

	getInstallPath() {
		// Return the folder HachiGen should treat as the Hachi install. Most
		// backend operations start by resolving paths relative to this value.
		return this.settings.installPath;
	}

	async setInstallPath(installPath) {
		// Validate and normalize the chosen path immediately. After this point,
		// the rest of HachiGen can assume installPath is absolute and non-empty.
		if (!installPath || !String(installPath).trim()) {
			throw new Error("Install path cannot be empty.");
		}

		const nextInstallPath = path.resolve(String(installPath));

		if (this.settings.installPath !== nextInstallPath) {
			this.updateState = createUncheckedUpdateState("Updates have not been checked for this install path yet.");
		}

		this.settings.installPath = nextInstallPath;
		this.saveSettings();
		this.log(`Install path set to ${this.settings.installPath}`);
	}

	getPaths() {
		// Central path list. If Hachi moves a file, update it here and every
		// validation/install/update method will follow the new location.
		const root = this.getInstallPath();

		return {
			root,
			packageJson: path.join(root, "package.json"),
			index: path.join(root, "index.js"),
			env: path.join(root, ".env"),
			blankEnv: path.join(root, "blank.env"),
			configDir: path.join(root, "config"),
			configJson: path.join(root, "config", "config.json"),
			blankConfig: path.join(root, "config", "blank.json"),
			ecosystem: path.join(root, "config", "ecosystem.config.js"),
			deleteCommands: path.join(root, "delete-all-commands.js"),
			deployGlobal: path.join(root, "deploy-global-commands.js"),
			deployGuild: path.join(root, "deploy-guild-commands.js"),
			dbAudit: path.join(root, "database", "dbAudit.js"),
			database: path.join(root, "database", "database.sqlite"),
			logs: path.join(root, "logs"),
			git: path.join(root, ".git"),
			nodeModules: path.join(root, "node_modules"),
		};
	}

	getDatabaseBackupDir() {
		// Database backups live inside the selected install folder so they stay
		// with the Hachi instance they protect, while .gitignore keeps them local.
		// Example: <Hachi>/manager/backups/database/database-2026-06-21.sqlite
		return path.join(this.getInstallPath(), "manager", "backups", "database");
	}

	getDatabaseWorkerPath() {
		// External Node cannot run a worker directly from app.asar. Copy the
		// packaged worker source to userData and execute that normal file instead.
		// The copy is refreshed only when the bundled worker text changes.
		const sourcePath = path.join(this.managerRoot, "src", DATABASE_WORKER_FILE);
		const targetPath = path.join(this.userDataPath, DATABASE_WORKER_FILE);
		const source = fs.readFileSync(sourcePath, "utf8");
		const current = fileExists(targetPath) ? fs.readFileSync(targetPath, "utf8") : null;

		if (current !== source) {
			ensureDir(path.dirname(targetPath));
			fs.writeFileSync(targetPath, source, "utf8");
		}

		return targetPath;
	}

	getDatabaseBackups() {
		// Return backup metadata for the Database tab without opening SQLite.
		// Sorting newest-first makes the most likely restore target appear first.
		const backupDir = this.getDatabaseBackupDir();

		if (!fileExists(backupDir)) {
			return [];
		}

		return fs.readdirSync(backupDir)
			.filter(file => /\.sqlite$/i.test(file))
			.map(file => {
				const fullPath = path.join(backupDir, file);
				const stats = fs.statSync(fullPath);

				return {
					file,
					fullPath,
					modifiedAt: stats.mtime.toISOString(),
					size: stats.size,
					sizeLabel: formatFileSize(stats.size),
				};
			})
			.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
	}

	async getDatabaseState() {
		// Build lightweight database status for the Database tab. Opening SQLite
		// is reserved for explicit Backup/Restore/Sanitize actions.
		// This method is safe to call often from getState().
		const paths = this.getPaths();
		const exists = fileExists(paths.database);
		const stats = exists ? fs.statSync(paths.database) : null;
		const backups = this.getDatabaseBackups();
		const audit = await this.auditDatabase({ quiet: true });

		return {
			audit,
			backupDir: this.getDatabaseBackupDir(),
			backups,
			exists,
			latestBackup: backups[0] || null,
			modifiedAt: stats ? stats.mtime.toISOString() : null,
			path: paths.database,
			size: stats ? stats.size : 0,
			sizeLabel: stats ? formatFileSize(stats.size) : "0 B",
		};
	}

	async runDatabaseWorker(action, options = {}) {
		// Run SQLite inspection/cleanup in the user's normal Node.js process.
		// That keeps native sqlite3 loading out of Electron's runtime.
		// The worker returns JSON, so this method converts worker failures into
		// normal JavaScript errors for the renderer toast/log handling.
		const paths = this.getPaths();

		if (!fileExists(paths.database)) {
			throw new Error("No Hachi database exists in the selected install folder.");
		}

		await this.ensureNodeAndNpm(false);

		const request = {
			action,
			dbPath: paths.database,
			root: paths.root,
			...options,
		};
		// Pass the whole request as one argument. That avoids quoting problems
		// from trying to pass several paths and options separately on Windows.
		const result = await run("node", [this.getDatabaseWorkerPath(), JSON.stringify(request)], {
			cwd: paths.root,
			allowFailure: true,
			timeoutMs: 300000,
		});
		const output = (result.stdout || "").trim();
		let parsed = null;

		try {
			parsed = JSON.parse(output);
		} catch {
			throw new Error(result.stderr || output || "Database worker did not return valid JSON.");
		}

		if (!parsed.ok) {
			throw new Error(parsed.error || result.stderr || "Database operation failed.");
		}

		return parsed;
	}

	async runDatabaseAuditCommand(args = [], { quiet = false } = {}) {
		// Run the same audit/migration script that users can run from the console.
		// --json keeps stdout parseable for HachiGen.
		const paths = this.getPaths();

		if (!fileExists(paths.database)) {
			return {
				detail: "No database file found.",
				dot: "muted",
				exists: false,
				forceMigrationAvailable: false,
				label: "Not Created",
				migrationAvailable: false,
				ok: true,
				status: "missing",
			};
		}

		if (!fileExists(paths.dbAudit)) {
			return {
				detail: "database/dbAudit.js is missing.",
				dot: "bad",
				error: "database/dbAudit.js is missing.",
				exists: true,
				forceMigrationAvailable: false,
				label: "Audit Error",
				migrationAvailable: false,
				ok: false,
				status: "error",
			};
		}

		if (!await commandExists("node")) {
			return {
				detail: "Node.js is required to audit the database.",
				dot: "bad",
				error: "Node.js is required to audit the database.",
				exists: true,
				forceMigrationAvailable: false,
				label: "Audit Error",
				migrationAvailable: false,
				ok: false,
				status: "error",
			};
		}

		const result = await run("node", ["database/dbAudit.js", "--json", ...args], {
			cwd: paths.root,
			allowFailure: true,
			timeoutMs: 300000,
			onLog: quiet ? null : entry => this.logShell(entry),
		});
		const output = (result.stdout || "").trim();

		try {
			return JSON.parse(output);
		} catch {
			return {
				detail: "Database audit did not return valid JSON.",
				dot: "bad",
				error: result.stderr || output || "Database audit failed.",
				exists: true,
				forceMigrationAvailable: false,
				label: "Audit Error",
				migrationAvailable: false,
				ok: false,
				status: "error",
			};
		}
	}

	async auditDatabase(options = {}) {
		// Audit only. This powers the Dashboard database card and button states.
		return this.runDatabaseAuditCommand([], options);
	}

	async migrateDatabase({ force = false } = {}) {
		// Migrate through the shared console command. Safe migration refuses
		// destructive changes; force migration allows exact-schema rebuilds.
		const result = await this.runDatabaseAuditCommand([force ? "--force" : "--migrate"]);

		if (!result.ok) {
			throw new Error(result.message || result.error || "Database migration failed.");
		}

		this.log(result.message || "Database migration complete.");

		return {
			...result,
			database: await this.getDatabaseState(),
		};
	}

	async checkpointDatabase() {
		// Ask SQLite to flush WAL data before copying the database. If the
		// dependency is unavailable, backup still falls back to copying the file.
		// This keeps Backup useful even if the database worker cannot run.
		try {
			await this.runDatabaseWorker("checkpoint");
		} catch (error) {
			this.log(`Database checkpoint skipped: ${error.message}`);
		}
	}

	async backupDatabase({ fileName = `database-${dateStamp()}.sqlite`, overwrite = false } = {}) {
		// Copy the current database into the dated backup folder. Manual backups
		// use a date-only filename so HachiGen can ask before replacing today's.
		// Automatic safety backups pass unique timestamped filenames.
		const paths = this.getPaths();

		if (!fileExists(paths.database)) {
			throw new Error("No Hachi database exists to back up.");
		}

		const backupDir = this.getDatabaseBackupDir();
		const backupPath = path.join(backupDir, fileName);

		ensureDir(backupDir);

		if (fileExists(backupPath) && !overwrite) {
			return {
				backupPath,
				fileName,
				needsOverwrite: true,
				ok: false,
				message: `${fileName} already exists.`,
			};
		}

		await this.checkpointDatabase();
		fs.copyFileSync(paths.database, backupPath);
		this.log(`Database backup created: ${backupPath}`);

		return {
			backupPath,
			fileName,
			ok: true,
			message: `Database backup created: ${fileName}`,
		};
	}

	async restoreDatabaseFromBackup(backupPath) {
		// Replace the current database with a chosen HachiGen backup. A unique
		// pre-restore backup is created first so the user has a rollback point.
		const paths = this.getPaths();
		const resolvedBackup = path.resolve(String(backupPath || ""));
		const backupDir = path.resolve(this.getDatabaseBackupDir());
		const relativeBackup = path.relative(backupDir, resolvedBackup);

		// Only allow files from HachiGen's backup folder. This prevents the
		// restore command from being used as a general file overwrite tool.
		if (relativeBackup.startsWith("..") || path.isAbsolute(relativeBackup)) {
			throw new Error("Choose a database backup from HachiGen's backup folder.");
		}

		if (!fileExists(resolvedBackup)) {
			throw new Error("The selected database backup does not exist.");
		}

		if (!/\.sqlite$/i.test(path.basename(resolvedBackup))) {
			throw new Error("Choose a .sqlite database backup file.");
		}

		ensureDir(path.dirname(paths.database));

		let safetyBackup = null;

		if (fileExists(paths.database)) {
			const safety = await this.backupDatabase({
				fileName: `database-pre-restore-${fileTimestamp()}.sqlite`,
				overwrite: false,
			});
			safetyBackup = safety.backupPath;
		}

		fs.copyFileSync(resolvedBackup, paths.database);

		// SQLite may leave write-ahead-log sidecar files beside the database.
		// After restoring a backup, old sidecars must be removed so they do not
		// overlay stale data onto the restored database.
		for (const sidecar of [`${paths.database}-wal`, `${paths.database}-shm`]) {
			if (fileExists(sidecar)) {
				fs.rmSync(sidecar, { force: true });
			}
		}

		this.log(`Database restored from backup: ${resolvedBackup}`);

		return {
			backupPath: resolvedBackup,
			ok: true,
			message: `Database restored from ${path.basename(resolvedBackup)}.`,
			safetyBackup,
		};
	}

	async reviewDatabaseSanitation() {
		// Produce a review-only report. No rows are changed until the renderer
		// sends selected cleanable action IDs back to applyDatabaseSanitation().
		// The returned database state refreshes backup/status panels after review.
		const report = await this.runDatabaseWorker("review");
		this.log(`Database sanitation review completed with ${report.summary.findingCount} finding(s).`);
		return {
			...report,
			database: await this.getDatabaseState(),
		};
	}

	async readDatabaseTable(tableName = "", sort = {}) {
		// Load a read-only preview for the Database tab viewer. The worker checks
		// that the requested table exists before using it in a quoted SQL query.
		const view = await this.runDatabaseWorker("view", { sort, table: tableName });
		this.log(`Database viewer loaded ${view.selectedTable || "no table"}.`);
		return {
			...view,
			database: await this.getDatabaseState(),
		};
	}

	async applyDatabaseSanitation(actionIds = []) {
		// Clean only the reviewed action IDs chosen by the user. A unique backup
		// is created first because cleanup deletes or updates database rows.
		// The worker runs another review afterward, so the UI gets fresh findings.
		const selected = Array.isArray(actionIds) ? actionIds.filter(Boolean) : [];

		if (!selected.length) {
			throw new Error("No database sanitation actions were selected.");
		}

		const backup = await this.backupDatabase({
			fileName: `database-pre-sanitize-${fileTimestamp()}.sqlite`,
			overwrite: false,
		});
		const report = await this.runDatabaseWorker("apply", { actionIds: selected });

		this.log(`Database sanitation cleaned ${report.applied.length} issue group(s).`);

		return {
			...report,
			backup,
			database: await this.getDatabaseState(),
		};
	}

	isProjectFolder() {
		// Decide whether the selected folder already looks like a Hachi install.
		// This intentionally checks only the minimum files needed before deeper
		// validation runs.
		const paths = this.getPaths();
		return fileExists(paths.packageJson) && fileExists(paths.index);
	}

	isEmptyDirectory(dirPath) {
		// Used before cloning so HachiGen only writes into empty or missing
		// folders, never over an unrelated project.
		if (!fileExists(dirPath)) {
			return true;
		}

		return fs.readdirSync(dirPath).length === 0;
	}

	quickScan() {
		// Build a fast health snapshot for the Dashboard and Setup page. It only
		// reads local files, so it is safe to call often during normal rendering.
		const paths = this.getPaths();
		const requiredFiles = [
			["package.json", paths.packageJson],
			["index.js", paths.index],
			["config/ecosystem.config.js", paths.ecosystem],
			["delete-all-commands.js", paths.deleteCommands],
			["deploy-global-commands.js", paths.deployGlobal],
			["deploy-guild-commands.js", paths.deployGuild],
		];
		const missingFiles = requiredFiles
			.filter(([, filePath]) => !fileExists(filePath))
			.map(([label]) => label);
		const config = this.readConfiguration();
		const packageJson = readJson(paths.packageJson, {});

		return {
			installPath: paths.root,
			projectFound: missingFiles.length === 0,
			packageName: packageJson.name || null,
			packageVersion: packageJson.version || null,
			missingFiles,
			hasEnv: fileExists(paths.env),
			hasConfig: fileExists(paths.configJson),
			hasGit: fileExists(paths.git),
			hasNodeModules: fileExists(paths.nodeModules),
			configurationMissing: config.missing,
			configurationReady: config.missing.length === 0,
		};
	}

	readConfiguration() {
		// Merge blank templates and real config files into one UI-friendly shape.
		// Template values reveal available fields; real user values override them.
		const paths = this.getPaths();
		const envValues = {
			...parseDotEnv(paths.blankEnv),
			...parseDotEnv(paths.env),
		};
		const configValues = {
			...readJson(paths.blankConfig, {}),
			...readJson(paths.configJson, {}),
		};
		const missing = [];

		// Missing lists are used to color dashboard/setup status indicators.
		for (const field of ENV_FIELDS) {
			if (isMissingValue(envValues[field])) {
				missing.push(field);
			}
		}

		for (const field of CONFIG_FIELDS) {
			if (isMissingValue(configValues[field])) {
				missing.push(field);
			}
		}

		return {
			exists: {
				env: fileExists(paths.env),
				config: fileExists(paths.configJson),
			},
			values: {
				...envValues,
				...configValues,
			},
			missing,
		};
	}

	async writeConfiguration(values) {
		// Split the Setup form into the two files Hachi expects: .env for
		// secrets/client IDs and config/config.json for bot behavior settings.
		const paths = this.getPaths();
		ensureDir(paths.configDir);

		const current = this.readConfiguration().values;
		const merged = {
			...current,
			...values,
		};

		const envLines = ENV_FIELDS.map(field => `${field}=${formatEnvValue(merged[field])}`);
		const configValues = {
			// Keep these explicit so saved config only contains supported fields.
			botOwner: merged.botOwner || "",
			guildId: merged.guildId || "",
			twitchCron: merged.twitchCron || CONFIG_DEFAULTS.twitchCron,
			kickCron: merged.kickCron || CONFIG_DEFAULTS.kickCron,
			birthdayCron: merged.birthdayCron || CONFIG_DEFAULTS.birthdayCron,
			statusCron: merged.statusCron || CONFIG_DEFAULTS.statusCron,
			authCron: merged.authCron || CONFIG_DEFAULTS.authCron,
		};

		fs.writeFileSync(paths.env, `${envLines.join("\n")}\n`, "utf8");
		fs.writeFileSync(paths.configJson, `${JSON.stringify(configValues, null, "\t")}\n`, "utf8");
		this.log("Configuration saved.");
		return this.readConfiguration();
	}

	async getState() {
		// Build the complete state object consumed by renderer/app.js. This keeps
		// the renderer simple: it redraws from one object instead of coordinating
		// several backend calls itself.
		const repository = await this.getRepositoryInfo();

		if (!this.updateStateMatchesRepository(repository)) {
			this.updateState = createUncheckedUpdateState("Updates have not been checked for this install path yet.");
		}

		try {
			await this.refreshActiveStash();
		} catch {
			// If Git stash inspection fails, keep the older saved stash value
			// instead of breaking the whole Dashboard render.
			this.updateState.stash = this.settings.activeStash || null;
		}

		return {
			appName: "HachiGen",
			database: await this.getDatabaseState(),
			installPath: this.getInstallPath(),
			repository: await this.getRepositoryInfo(),
			scan: this.quickScan(),
			updates: this.updateState,
			pm2: await this.getPm2Status(),
			recentEvents: this.operationLog.slice(-80),
		};
	}

	async installWithWinget(packageId, label) {
		// Install a missing system tool with winget. This is only called from
		// repair flows, so passive checks never install software unexpectedly.
		const hasWinget = await commandExists("winget");

		if (!hasWinget) {
			throw new Error(`${label} is missing and winget is not available. Install ${label} manually, then try again.`);
		}

		this.log(`${label} is missing. Installing with winget...`);
		await run("winget", [
			"install",
			packageId,
			"-e",
			"--accept-package-agreements",
			"--accept-source-agreements",
		], {
			timeoutMs: 900000,
			onLog: entry => this.logShell(entry),
		});
	}

	async ensureNodeAndNpm(installMissing) {
		// Ensure Node.js and npm are available. installMissing decides whether
		// HachiGen only reports a problem or tries to install Node.js via winget.
		let hasNode = await commandExists("node");
		let hasNpm = await commandExists("npm");

		if ((!hasNode || !hasNpm) && installMissing) {
			await this.installWithWinget("OpenJS.NodeJS", "Node.js");
			hasNode = await commandExists("node");
			hasNpm = await commandExists("npm");
		}

		if (!hasNode || !hasNpm) {
			throw new Error("Node.js and npm are required for Hachi.");
		}

		// Returning versions gives the UI/logs something concrete to display.
		const nodeVersion = await run("node", ["--version"], {
			allowFailure: true,
			onLog: entry => this.logShell(entry),
		});
		const npmVersion = await run("npm", ["--version"], {
			allowFailure: true,
			onLog: entry => this.logShell(entry),
		});

		return {
			node: nodeVersion.stdout.trim(),
			npm: npmVersion.stdout.trim(),
		};
	}

	async ensureGit(installMissing) {
		// Ensure Git is available for clone/update actions. Existing non-Git
		// installs can still be inspected, but updates need Git.
		let hasGit = await commandExists("git");

		if (!hasGit && installMissing) {
			await this.installWithWinget("Git.Git", "Git");
			hasGit = await commandExists("git");
		}

		if (!hasGit) {
			throw new Error("Git is required for install and update actions.");
		}

		const version = await run("git", ["--version"], {
			allowFailure: true,
			onLog: entry => this.logShell(entry),
		});

		return version.stdout.trim();
	}

	async ensurePm2(installMissing) {
		// Ensure PM2 is available because it owns the long-running Hachi process
		// after HachiGen closes.
		let hasPm2 = await commandExists("pm2");

		if (!hasPm2 && installMissing) {
			await this.ensureNodeAndNpm(true);
			this.log("PM2 is missing. Installing globally with npm...");
			await run("npm", ["install", "-g", "pm2"], {
				timeoutMs: 900000,
				onLog: entry => this.logShell(entry),
			});
			hasPm2 = await commandExists("pm2");
		}

		if (!hasPm2) {
			throw new Error("PM2 is required to run Hachi in the background.");
		}

		return true;
	}

	async installRepositoryIfNeeded() {
		// Clone Hachi only when the selected folder is empty or missing. Existing
		// Hachi installs are left alone; non-empty unrelated folders are rejected.
		const paths = this.getPaths();

		if (this.isProjectFolder()) {
			return false;
		}

		if (!this.isEmptyDirectory(paths.root)) {
			throw new Error("The selected install path is not empty and does not look like a Hachi folder.");
		}

		await this.ensureGit(true);
		ensureDir(path.dirname(paths.root));
		this.log(`Cloning Hachi into ${paths.root}`);
		await run("git", ["clone", REPO_URL, paths.root], {
			timeoutMs: 900000,
			onLog: entry => this.logShell(entry),
		});
		return true;
	}

	async ensureNpmDependencies() {
		// Install Hachi's package dependencies into the selected install folder.
		// This is called during validation/start and after updates.
		if (!this.isProjectFolder()) {
			throw new Error("Hachi is not installed in the selected folder.");
		}

		await this.ensureNodeAndNpm(true);
		this.log("Installing Hachi npm dependencies...");
		await run("npm", ["install"], {
			cwd: this.getInstallPath(),
			timeoutMs: 900000,
			onLog: entry => this.logShell(entry),
		});
	}

	async runConfigValidation() {
		// Reuse Hachi's existing configCheck.js so command-line validation and
		// HachiGen validation stay in sync.
		await this.ensureNodeAndNpm(false);
		this.log("Running Hachi configuration validation...");
		await run("node", ["-e", "require('./config/configCheck.js')"], {
			cwd: this.getInstallPath(),
			timeoutMs: 120000,
			onLog: entry => this.logShell(entry),
		});
		return true;
	}

	async installOrValidate() {
		// Handle the Setup page's Install / Validate button. It creates or clones
		// the install when needed, then runs the repair-capable validation path.
		await this.installRepositoryIfNeeded();
		return this.validateInstall({ repair: true });
	}

	async validateInstall({ repair = false } = {}) {
		// Validate the selected install. repair=false only reports problems;
		// repair=true is allowed to create folders, clone, install deps, and PM2.
		this.log(repair ? "Validating and repairing Hachi install..." : "Validating Hachi install...");

		const paths = this.getPaths();

		if (!fileExists(paths.root)) {
			ensureDir(paths.root);
		}

		if (repair) {
			await this.installRepositoryIfNeeded();
		}

		if (!this.isProjectFolder()) {
			const scan = this.quickScan();
			return {
				ok: false,
				message: "The selected path does not contain a complete Hachi install.",
				scan,
			};
		}

		const prerequisites = {};

		// Each prerequisite is checked in order so the log reads like a checklist.
		prerequisites.node = await this.ensureNodeAndNpm(repair);

		if (fileExists(paths.git)) {
			prerequisites.git = await this.ensureGit(repair);
		}

		if (!fileExists(paths.nodeModules)) {
			await this.ensureNpmDependencies();
		} else {
			this.log("Hachi npm dependencies found.");
		}

		if (repair) {
			await this.ensurePm2(true);
		}

		let configOk = false;
		let configMessage = "Configuration was not checked.";

		try {
			// Validation errors are not fatal here; they become a clear status
			// message that the Setup page can show to the user.
			await this.runConfigValidation();
			configOk = true;
			configMessage = "Configuration is valid.";
		} catch (error) {
			configMessage = error.stderr || error.message;
		}

		const scan = this.quickScan();
		const ok = scan.projectFound && scan.hasNodeModules && configOk;

		return {
			ok,
			message: ok ? "Hachi install is ready." : "Hachi install needs attention.",
			scan,
			prerequisites,
			config: {
				ok: configOk,
				message: configMessage,
			},
		};
	}

	async getLocalChanges() {
		// Return raw Git porcelain lines for files changed locally. HachiGen
		// shows these before updating so generated or edited files are visible.
		const paths = this.getPaths();

		if (!fileExists(paths.git)) {
			return [];
		}

		const result = await run("git", ["status", "--porcelain=v1", "-uall"], {
			cwd: paths.root,
			allowFailure: true,
			onLog: entry => this.logShell(entry),
		});

		// Raw lines are parsed later so the UI can show both grouped labels and
		// the original Git-style status if needed. Do not trim each line here:
		// Git porcelain status uses leading spaces as part of its two-character
		// status code, such as " M .gitignore" for a modified unstaged file.
		return result.stdout
			.split(/\r?\n/)
			.filter(line => line.trim());
	}

	async getRepositoryInfo({ onLog = null } = {}) {
		const paths = this.getPaths();
		const info = {
			isGit: fileExists(paths.git),
			currentBranch: null,
			originUrl: null,
			updateRemote: UPDATE_REMOTE,
			updateBranch: UPDATE_BRANCH,
			updateTarget: UPDATE_TARGET,
		};

		if (!info.isGit) {
			return info;
		}

		const runGit = async args => {
			try {
				const result = await run("git", args, {
					cwd: paths.root,
					allowFailure: true,
					onLog,
				});

				return result.code === 0 ? result.stdout.trim() : "";
			} catch {
				return "";
			}
		};

		info.currentBranch = await runGit(["branch", "--show-current"]);
		info.originUrl = await runGit(["remote", "get-url", UPDATE_REMOTE]);

		if (!info.currentBranch) {
			const shortHead = await runGit(["rev-parse", "--short", "HEAD"]);
			info.currentBranch = shortHead ? `detached:${shortHead}` : null;
		}

		return info;
	}

	async getIncomingCommits() {
		// Return commits on the update target that are not present locally, giving the
		// Updates panel a concrete list of incoming work.
		const paths = this.getPaths();
		const result = await run("git", ["log", "--oneline", "--no-decorate", `HEAD..${UPDATE_TARGET}`], {
			cwd: paths.root,
			allowFailure: true,
			onLog: entry => this.logShell(entry),
		});

		return result.stdout
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean)
			.map(parseIncomingCommit);
	}

	async getHachiGenStashes() {
		// Return only auto-stashes created by HachiGen. User-created stashes are
		// intentionally ignored so Restore/Delete buttons cannot touch them.
		const paths = this.getPaths();

		if (!fileExists(paths.git)) {
			return [];
		}

		const result = await run("git", ["stash", "list", "--format=%H%x09%gd%x09%ct%x09%gs"], {
			cwd: paths.root,
			allowFailure: true,
			onLog: entry => this.logShell(entry),
		});

		if (result.code !== 0) {
			return [];
		}

		return result.stdout
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(Boolean)
			.map(parseStashLine)
			.filter(stash => stash.message.includes(HACHIGEN_STASH_PREFIX));
	}

	async getStashChanges(stashRef) {
		// Read the file list inside a stash. Git versions differ on untracked
		// stash display, so this tries the richer command and falls back safely.
		const paths = this.getPaths();
		const commands = [
			["stash", "show", "--name-status", "--include-untracked", stashRef],
			["stash", "show", "--name-status", stashRef],
		];

		for (const args of commands) {
			const result = await run("git", args, {
				cwd: paths.root,
				allowFailure: true,
				onLog: entry => this.logShell(entry),
			});

			if (result.code === 0) {
				return result.stdout
					.split(/\r?\n/)
					.map(line => line.trim())
					.filter(Boolean)
					.map(describeNameStatus);
			}
		}

		return [];
	}

	async refreshActiveStash() {
		// Synchronize settings.activeStash with the real Git stash list. This is
		// why Restore/Delete buttons update correctly if a stash is removed by Git
		// or another tool outside HachiGen.
		const stashes = await this.getHachiGenStashes();
		const savedHash = this.settings.activeStash?.hash;
		const activeStashBase = stashes.find(stash => stash.hash === savedHash) || stashes[0] || null;
		const activeStash = activeStashBase ?
			{
				...activeStashBase,
				changes: await this.getStashChanges(activeStashBase.ref),
			} :
			null;

		if (activeStash) {
			activeStash.changeSummary = summarizeLocalChanges(activeStash.changes);
		}

		if (activeStash?.hash !== this.settings.activeStash?.hash) {
			this.settings.activeStash = activeStash;
			this.saveSettings();
		}

		this.updateState.stash = activeStash;
		this.updateState.stashes = stashes;
		return activeStash;
	}

	async createAutoStash() {
		// Save local work before an update. The -u flag includes untracked files,
		// which are the "??" entries shown in Git status.
		const message = `${HACHIGEN_STASH_PREFIX} ${new Date().toISOString()}`;

		this.log("Saving local changes to a recoverable Git stash...");
		await run("git", ["stash", "push", "-u", "-m", message], {
			cwd: this.getInstallPath(),
			timeoutMs: 300000,
			onLog: entry => this.logShell(entry),
		});

		const stashes = await this.getHachiGenStashes();
		const activeStash = stashes.find(stash => stash.message === message) || stashes[0] || null;
		this.settings.activeStash = activeStash;
		this.saveSettings();

		const enrichedStash = await this.refreshActiveStash();
		this.updateState.stash = enrichedStash;
		this.updateState.stashes = stashes;
		return enrichedStash;
	}

	async checkUpdates() {
		// Fetch and compare local HEAD against the update target. This method reports
		// update availability and local changes, but never modifies the worktree.
		const paths = this.getPaths();

		if (!fileExists(paths.git)) {
			this.updateState = {
				...createUncheckedUpdateState("This install is not a Git checkout, so HachiGen cannot check for updates."),
				status: "not_git",
				checkedAt: new Date().toISOString(),
				updateTarget: UPDATE_TARGET,
				message: "This install is not a Git checkout, so HachiGen cannot check for updates.",
			};
			return this.updateState;
		}

		await this.ensureGit(true);
		const repository = await this.getRepositoryInfo({ onLog: entry => this.logShell(entry) });
		const localChanges = await this.getLocalChanges();
		const localChangeDetails = localChanges.map(describeGitStatus);
		const localChangeSummary = summarizeLocalChanges(localChangeDetails);
		this.log("Checking for Hachi updates...");

		// Fetch updates for the configured update target so the comparison below
		// uses fresh remote data.
		await run("git", ["fetch", UPDATE_REMOTE, UPDATE_BRANCH], {
			cwd: paths.root,
			timeoutMs: 300000,
			onLog: entry => this.logShell(entry),
		});

		const local = (await run("git", ["rev-parse", "HEAD"], {
			cwd: paths.root,
			onLog: entry => this.logShell(entry),
		})).stdout.trim();
		const remote = (await run("git", ["rev-parse", UPDATE_TARGET], {
			cwd: paths.root,
			onLog: entry => this.logShell(entry),
		})).stdout.trim();
		const base = (await run("git", ["merge-base", "HEAD", UPDATE_TARGET], {
			cwd: paths.root,
			onLog: entry => this.logShell(entry),
		})).stdout.trim();
		const localTree = (await run("git", ["rev-parse", "HEAD^{tree}"], {
			cwd: paths.root,
			onLog: entry => this.logShell(entry),
		})).stdout.trim();
		const remoteTree = (await run("git", ["rev-parse", `${UPDATE_TARGET}^{tree}`], {
			cwd: paths.root,
			onLog: entry => this.logShell(entry),
		})).stdout.trim();

		const blocked = localChanges.length > 0;
		const committedFilesMatchTarget = Boolean(localTree && remoteTree && localTree === remoteTree);
		const filesMatchTarget = committedFilesMatchTarget && !blocked;
		const onUpdateBranch = repository.currentBranch === UPDATE_BRANCH;
		const canFastForward = local !== remote && base === local;
		const historyDiverged = local !== remote && base !== local;
		const available = onUpdateBranch && canFastForward;
		let status = "current";
		let message = "Hachi is up to date.";

		if (!onUpdateBranch) {
			status = filesMatchTarget ? "branch_current" : "branch_mismatch";
			if (filesMatchTarget) {
				message = `Current branch is ${repository.currentBranch || "unknown"}. Files match ${UPDATE_TARGET}. Automatic updates only run from ${UPDATE_BRANCH}.`;
			} else if (committedFilesMatchTarget) {
				message = `Current branch is ${repository.currentBranch || "unknown"}. Committed files match ${UPDATE_TARGET}, but local changes exist.`;
			} else {
				message = `Current branch is ${repository.currentBranch || "unknown"} and differs from ${UPDATE_TARGET}. Use Git to update manually.`;
			}
		} else if (available) {
			status = "available";
			message = "Updates available";
		} else if (historyDiverged) {
			status = filesMatchTarget ? "history_current" : "diverged";
			message = filesMatchTarget ?
				`Files match ${UPDATE_TARGET}, but Git history differs. Review with Git before updating.` :
				`Local and ${UPDATE_TARGET} history have diverged. Update manually.`;
		}

		const incomingCommits = filesMatchTarget ? [] : await this.getIncomingCommits();

		this.updateState = {
			status,
			available,
			blocked,
			diverged: historyDiverged,
			checkedAt: new Date().toISOString(),
			installPath: paths.root,
			local,
			remote,
			base,
			localTree,
			remoteTree,
			committedFilesMatchTarget,
			filesMatchTarget,
			onUpdateBranch,
			currentBranch: repository.currentBranch,
			originUrl: repository.originUrl,
			updateRemote: UPDATE_REMOTE,
			updateBranch: UPDATE_BRANCH,
			updateTarget: UPDATE_TARGET,
			repository,
			localChanges,
			localChangeDetails,
			localChangeSummary,
			incomingCommits,
			incomingCommitCount: incomingCommits.length,
			message: available && blocked ?
				"Updates available. Local changes will be stashed before updating." :
				message,
		};

		await this.refreshActiveStash();
		return this.updateState;
	}

	backupBeforeUpdate() {
		// Copy user-owned runtime files before changing code. This is separate
		// from Git stash because .env/database files may be ignored by Git.
		const paths = this.getPaths();
		const backupDir = path.join(paths.root, "manager", "backups", timestampFolderName());
		const files = [
			[paths.env, ".env"],
			[paths.configJson, path.join("config", "config.json")],
			[paths.database, path.join("database", "database.sqlite")],
		];
		const copied = [];

		for (const [source, relativeTarget] of files) {
			if (!fileExists(source)) {
				continue;
			}

			const target = path.join(backupDir, relativeTarget);
			ensureDir(path.dirname(target));
			fs.copyFileSync(source, target);
			copied.push(relativeTarget);
		}

		return {
			backupDir,
			copied,
		};
	}

	async applyUpdate() {
		// Apply an available update by fast-forwarding to the update target. It never
		// hard-resets; local work is stashed first and runtime files are backed up.
		if (!this.updateState.available) {
			await this.checkUpdates();
		}

		if (!this.updateState.available) {
			return this.updateState;
		}

		let autoStash = null;

		if (this.updateState.blocked) {
			// Save local work before the merge so the update can proceed safely.
			autoStash = await this.createAutoStash();
		}

		const backup = this.backupBeforeUpdate();
		this.log(`Backed up local config before update: ${backup.backupDir}`);
		await run("git", ["merge", "--ff-only", UPDATE_TARGET], {
			cwd: this.getInstallPath(),
			timeoutMs: 300000,
			onLog: entry => this.logShell(entry),
		});

		// New bot code may have new package dependencies.
		await this.ensureNpmDependencies();

		const refreshedState = await this.checkUpdates();

		this.updateState = {
			...refreshedState,
			backup,
			stash: autoStash || refreshedState.stash,
			message: autoStash ?
				`Update complete. Local changes were saved as ${autoStash.ref}.` :
				refreshedState.message,
		};

		return this.updateState;
	}

	async restoreStashedChanges() {
		// Apply the active HachiGen stash without dropping it. Keeping the stash
		// lets the user confirm the restore before choosing Delete Changes.
		const activeStash = await this.refreshActiveStash();

		if (!activeStash) {
			throw new Error("No HachiGen saved stash is available to restore.");
		}

		this.log(`Restoring saved changes from ${activeStash.ref}...`);
		await run("git", ["stash", "apply", activeStash.ref], {
			cwd: this.getInstallPath(),
			timeoutMs: 300000,
			onLog: entry => this.logShell(entry),
		});

		await this.checkUpdates();
		return {
			ok: true,
			message: `Restored saved changes from ${activeStash.ref}. The stash is still available until deleted.`,
			stash: activeStash,
		};
	}

	async deleteStashedChanges() {
		// Permanently drop the active HachiGen-created stash after the user no
		// longer needs Restore Changes.
		const activeStash = await this.refreshActiveStash();

		if (!activeStash) {
			throw new Error("No HachiGen saved stash is available to delete.");
		}

		this.log(`Deleting saved changes from ${activeStash.ref}...`);
		await run("git", ["stash", "drop", activeStash.ref], {
			cwd: this.getInstallPath(),
			timeoutMs: 300000,
			onLog: entry => this.logShell(entry),
		});

		this.settings.activeStash = null;
		this.saveSettings();
		await this.refreshActiveStash();

		return {
			ok: true,
			message: `Deleted saved changes from ${activeStash.ref}.`,
		};
	}

	async deployCommands() {
		// Redeploy slash commands from a clean Discord state. Deleting first
		// removes commands that no longer exist locally before the fresh global
		// and guild command lists are uploaded.
		if (!this.isProjectFolder()) {
			throw new Error("Hachi is not installed in the selected folder.");
		}

		await this.runConfigValidation();
		this.log("Deleting existing Hachi slash commands...");
		await run("node", ["delete-all-commands.js"], {
			cwd: this.getInstallPath(),
			timeoutMs: 300000,
			onLog: entry => this.logShell(entry),
		});
		this.log("Deploying fresh Hachi slash commands...");
		await run("node", ["deploy-global-commands.js"], {
			cwd: this.getInstallPath(),
			timeoutMs: 300000,
			onLog: entry => this.logShell(entry),
		});
		await run("node", ["deploy-guild-commands.js"], {
			cwd: this.getInstallPath(),
			timeoutMs: 300000,
			onLog: entry => this.logShell(entry),
		});
		this.log("Slash commands deployed.");
		return { ok: true, message: "Commands deployed." };
	}

	async pm2Describe() {
		// Ask PM2 whether the Hachi process is already registered. Start/restart
		// uses this to choose between registering a new process and restarting it.
		return run("pm2", ["describe", PROCESS_NAME], {
			allowFailure: true,
			timeoutMs: 30000,
			onLog: entry => this.logShell(entry),
		});
	}

	async getPm2Status() {
		// Convert PM2's process list into the small status object used by
		// Dashboard cards, status dots, and runtime details.
		const hasPm2 = await commandExists("pm2");

		if (!hasPm2) {
			return {
				installed: false,
				registered: false,
				status: "pm2-missing",
				message: "PM2 is not installed.",
			};
		}

		// jlist is PM2's machine-readable process list.
		const result = await run("pm2", ["jlist"], {
			allowFailure: true,
			timeoutMs: 30000,
		});

		if (result.code !== 0) {
			return {
				installed: true,
				registered: false,
				status: "error",
				message: result.stderr || "Could not read PM2 status.",
			};
		}

		try {
			const apps = parsePm2Json(result.stdout);
			const app = apps.find(item => item.name === PROCESS_NAME);

			// PM2 can be installed even if Hachi has never been started.
			if (!app) {
				return {
					installed: true,
					registered: false,
					status: "not-registered",
					message: "Hachi is not registered in PM2.",
				};
			}

			return {
				installed: true,
				registered: true,
				status: app.pm2_env?.status || "unknown",
				restarts: app.pm2_env?.restart_time || 0,
				cpu: app.monit?.cpu || 0,
				memory: app.monit?.memory || 0,
				pid: app.pid || null,
				message: `Hachi is ${app.pm2_env?.status || "unknown"}.`,
			};
		} catch (error) {
			return {
				installed: true,
				registered: false,
				status: "error",
				message: error.message,
			};
		}
	}

	async startBot() {
		// Validate and repair before starting so PM2 is never asked to run a
		// half-installed or misconfigured bot.
		const validation = await this.validateInstall({ repair: true });

		if (!validation.ok) {
			throw new Error(validation.config?.message || validation.message || "Hachi validation failed.");
		}

		const paths = this.getPaths();
		await this.ensurePm2(true);
		const describe = await this.pm2Describe();

		// If PM2 already knows about Hachi, restart the existing process using
		// the ecosystem file. Otherwise, register it for the first time.
		if (describe.code === 0) {
			this.log("Restarting Hachi through PM2...");
			await run("pm2", ["restart", paths.ecosystem, "--only", PROCESS_NAME], {
				cwd: paths.root,
				timeoutMs: 120000,
				onLog: entry => this.logShell(entry),
			});
		} else {
			this.log("Starting Hachi through PM2...");
			await run("pm2", ["start", paths.ecosystem, "--only", PROCESS_NAME], {
				cwd: paths.root,
				timeoutMs: 120000,
				onLog: entry => this.logShell(entry),
			});
		}

		// pm2 save makes PM2 remember the process list for future restores/startup.
		await run("pm2", ["save"], {
			timeoutMs: 120000,
			onLog: entry => this.logShell(entry),
		});

		return this.getPm2Status();
	}

	async stopBot() {
		// Stop the PM2 process without deleting its registration. That keeps
		// future Start/Restart behavior predictable.
		await this.ensurePm2(false);
		this.log("Stopping Hachi through PM2...");
		await run("pm2", ["stop", PROCESS_NAME], {
			timeoutMs: 120000,
			onLog: entry => this.logShell(entry),
		});
		return this.getPm2Status();
	}

	async restartBot() {
		// Restart the PM2 process when it exists. If Hachi has not been
		// registered yet, fall back to the full Start path.
		await this.ensurePm2(true);
		const describe = await this.pm2Describe();

		if (describe.code === 0) {
			this.log("Restarting Hachi through PM2...");
			await run("pm2", ["restart", PROCESS_NAME], {
				timeoutMs: 120000,
				onLog: entry => this.logShell(entry),
			});
			return this.getPm2Status();
		}

		return this.startBot();
	}

	readLocalLogs(limit = 160) {
		// Read the newest Hachi runtime log file from the install folder and keep
		// only the tail so the Logs tab stays responsive.
		const paths = this.getPaths();

		if (!fileExists(paths.logs)) {
			return "";
		}

		const files = fs.readdirSync(paths.logs)
			.filter(file => /\.(log|txt)$/i.test(file))
			.map(file => ({
				file,
				fullPath: path.join(paths.logs, file),
				modified: fs.statSync(path.join(paths.logs, file)).mtimeMs,
			}))
			.sort((a, b) => b.modified - a.modified);

		if (!files.length) {
			return "";
		}

		const text = fs.readFileSync(files[0].fullPath, "utf8");
		return text.split(/\r?\n/).slice(-limit).join("\n");
	}

	async getLogs() {
		// Build the combined Logs tab payload: local Hachi logs, PM2 snapshot
		// output, and HachiGen's in-memory operation log.
		const local = this.readLocalLogs();
		let pm2 = "";

		if (await commandExists("pm2")) {
			// --nostream takes a snapshot instead of leaving a live command running.
			const result = await run("pm2", ["logs", PROCESS_NAME, "--lines", "160", "--nostream"], {
				allowFailure: true,
				timeoutMs: 30000,
			});
			pm2 = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		}

		return {
			local,
			pm2,
			events: this.operationLog.slice(-160),
		};
	}
}

module.exports = {
	HachiManager,
};
