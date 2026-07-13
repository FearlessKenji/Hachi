// Electron main process for HachiGen.
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	app,
	BrowserWindow,
	clipboard,
	// ipcMain is Electron's request handler for messages from the renderer window.
	// HachiGen's HTML/JS page cannot call Node.js APIs directly, so it asks the
	// main process to perform approved actions through named IPC channels.
	ipcMain,
	dialog,
	Menu,
	shell,
} = require("electron");
const { HachiManager } = require("./src/manager.js");
const managerPackage = require("./package.json");

const HELP_LINKS = {
	changelog: "https://github.com/FearlessKenji/Hachi/blob/main/CHANGELOG.md",
	docs: "https://fearlesskenji.github.io/Hachi/",
	patchNotes: "https://github.com/FearlessKenji/Hachi/blob/main/docs/patch-notes.md",
	readme: "https://github.com/FearlessKenji/Hachi#readme",
	releases: "https://github.com/FearlessKenji/Hachi/releases/latest",
};

// Electron apps have a "main process" and one or more windows.
// This file is the main process: it creates the HachiGen window and
// connects window button clicks to backend manager actions.
let mainWindow;
let manager;
let clipboardClearTimer = null;

// Forward backend activity to the window when it is available. Backend actions
// can outlive a particular BrowserWindow, so this checks before sending.
function sendEvent(event) {
	if (mainWindow && !mainWindow.isDestroyed()) {
		// This is the opposite direction from ipcMain.handle(): manager.js emits a
		// live event, main.js sends it to the renderer, and preload.js exposes a
		// subscription helper as window.hachiGen.onEvent(...).
		mainWindow.webContents.send("manager:event", event);
	}
}

function sendMenuAction(action, details = {}) {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("manager:menu-action", {
			action,
			...details,
		});
	}
}

function scheduleClipboardClear(secret, ttlMs) {
	if (clipboardClearTimer) {
		clearTimeout(clipboardClearTimer);
	}

	clipboardClearTimer = setTimeout(() => {
		if (clipboard.readText() === secret) {
			clipboard.clear();
		}
	}, ttlMs);

	if (typeof clipboardClearTimer.unref === "function") {
		clipboardClearTimer.unref();
	}
}

function openExternal(url) {
	shell.openExternal(url);
}

async function openHachiGenLogFolder() {
	const logFolder = manager?.logger?.logsPath;

	if (!logFolder) {
		return;
	}

	const result = await shell.openPath(logFolder);

	if (result) {
		dialog.showErrorBox("Open HachiGen Log Folder", result);
	}
}

function readLogSection(label, filePath) {
	if (!filePath || !fs.existsSync(filePath)) {
		return `## ${label}\n\nNot found.`;
	}

	return `## ${label}\n\n${fs.readFileSync(filePath, "utf8").trim() || "Empty."}`;
}

async function exportHachiGenLogs() {
	if (!manager?.logger) {
		return;
	}

	const paths = manager.logger.ensureLogs();
	const stamp = new Date().toISOString().replace(/\D/gu, "").slice(0, 14);
	const result = await dialog.showSaveDialog(mainWindow, {
		defaultPath: `hachigen-logs-${stamp}.txt`,
		filters: [
			{ name: "Text logs", extensions: ["txt"] },
			{ name: "All files", extensions: ["*"] },
		],
		title: "Export HachiGen Logs",
	});

	if (result.canceled || !result.filePath) {
		return;
	}

	const content = [
		`# HachiGen Logs Export`,
		`Exported: ${new Date().toISOString()}`,
		`HachiGen: ${managerPackage.version}`,
		`Install path: ${manager.getInstallPath()}`,
		readLogSection("Raw Log", paths.raw),
		readLogSection("Structured Pretty Log", paths.structuredPretty),
		readLogSection("Crash Log", paths.crash),
	].join("\n\n");

	fs.writeFileSync(result.filePath, `${content}\n`, "utf8");
	manager.log(`HachiGen logs exported to ${result.filePath}.`);
}

async function copyDiagnosticInfo() {
	const scan = manager ? await manager.getQuickScan().catch(() => null) : null;
	const repository = manager ? await manager.getRepositoryInfo().catch(() => null) : null;
	const lines = [
		`HachiGen: ${managerPackage.version}`,
		`Hachi: ${scan?.packageVersion || "unknown"}`,
		`Runtime target: ${manager?.getRuntimeTarget?.() || "unknown"}`,
		`Install path: ${manager?.getInstallPath?.() || "unknown"}`,
		`Branch: ${repository?.currentBranch || "unknown"}`,
		`Update target: ${repository?.updateTarget || "origin/main"}`,
		`Git remote: ${repository?.originUrl || "unknown"}`,
		`Project found: ${scan?.projectFound === undefined ? "unknown" : scan.projectFound}`,
	].join("\n");

	clipboard.writeText(lines);
	manager?.log("Diagnostic info copied to clipboard.");
}

async function showAboutDialog() {
	const scan = manager ? await manager.getQuickScan().catch(() => null) : null;

	dialog.showMessageBox(mainWindow, {
		buttons: ["OK"],
		message: "HachiGen",
		detail: [
			`HachiGen version: ${managerPackage.version}`,
			`Hachi version: ${scan?.packageVersion || "unknown"}`,
			`Runtime target: ${manager?.getRuntimeTarget?.() || "unknown"}`,
		].join("\n"),
		type: "info",
	});
}

function escapeBatchValue(value) {
	return String(value || "").replace(/%/gu, "%%");
}

async function installHachiGenUpdate() {
	const update = await manager.checkHachiGenUpdates();

	if (!update.canInstall) {
		throw new Error(update.message || "No HachiGen release asset is available.");
	}

	if (!app.isPackaged || process.platform !== "win32") {
		openExternal(update.assetUrl || update.releaseUrl || HELP_LINKS.releases);
		return {
			...update,
			message: "Development builds cannot replace the running Electron process. Opened the latest HachiGen release download.",
			ok: true,
		};
	}

	const tempDir = path.join(os.tmpdir(), `hachigen-update-${Date.now()}`);
	const updatePath = path.join(tempDir, "HachiGen.exe");
	const scriptPath = path.join(tempDir, "install-hachigen-update.cmd");
	const installed = await manager.downloadHachiGenUpdate(updatePath, update);
	const targetPath = process.execPath;
	const script = [
		"@echo off",
		"setlocal",
		`set "TARGET=${escapeBatchValue(targetPath)}"`,
		`set "UPDATE=${escapeBatchValue(updatePath)}"`,
		`set "PID=${process.pid}"`,
		":wait",
		"tasklist /FI \"PID eq %PID%\" | findstr /R /C:\"%PID%\" >nul",
		"if not errorlevel 1 (",
		"	timeout /t 1 /nobreak >nul",
		"	goto wait",
		")",
		"copy /Y \"%UPDATE%\" \"%TARGET%\" >nul",
		"if errorlevel 1 exit /b 1",
		"start \"\" \"%TARGET%\"",
		"del \"%UPDATE%\" >nul 2>nul",
		"del \"%~f0\" >nul 2>nul",
		"",
	].join("\r\n");

	fs.writeFileSync(scriptPath, script, "utf8");
	manager.markHachiGenReleaseInstalled(update.latestTag);
	manager.log(`HachiGen ${update.latestTag || "update"} downloaded. HachiGen will close, replace itself, and relaunch.`);

	const child = childProcess.spawn(scriptPath, [], {
		detached: true,
		shell: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();

	setTimeout(() => app.quit(), 500);

	return {
		...installed,
		message: `HachiGen ${update.latestTag || "update"} downloaded. HachiGen will close, replace itself, and relaunch.`,
		ok: true,
	};
}

function buildApplicationMenu() {
	return Menu.buildFromTemplate([
		{
			label: "File",
			submenu: [
				{
					label: "Open Hachi Folder",
					click: () => sendMenuAction("open-folder"),
				},
				{
					label: "Open HachiGen Log Folder",
					click: () => openHachiGenLogFolder(),
				},
				{
					label: "Export HachiGen Logs",
					click: () => exportHachiGenLogs(),
				},
				{ type: "separator" },
				{
					label: "Exit",
					role: "quit",
				},
			],
		},
		{
			label: "View",
			submenu: [
				{
					label: "Dashboard",
					click: () => sendMenuAction("show-view", { view: "dashboard" }),
				},
				{
					label: "Setup",
					click: () => sendMenuAction("show-view", { view: "setup" }),
				},
				{
					label: "Remote",
					click: () => sendMenuAction("show-view", { view: "remote" }),
				},
				{
					label: "Updates",
					click: () => sendMenuAction("show-view", { view: "updates" }),
				},
				{
					label: "Database",
					click: () => sendMenuAction("show-view", { view: "database" }),
				},
				{
					label: "Logs",
					click: () => sendMenuAction("show-view", { view: "logs" }),
				},
				{ type: "separator" },
				{
					label: "Refresh Current View",
					accelerator: "F5",
					click: () => sendMenuAction("refresh-current-view"),
				},
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "minimize" },
				{ role: "close" },
			],
		},
		{
			label: "Help",
			submenu: [
				{
					label: "Check for Updates",
					click: () => sendMenuAction("check-version-updates"),
				},
				{ type: "separator" },
				{
					label: "Open Documentation",
					click: () => openExternal(HELP_LINKS.docs),
				},
				{
					label: "Open README",
					click: () => openExternal(HELP_LINKS.readme),
				},
				{
					label: "Open Changelog",
					click: () => openExternal(HELP_LINKS.changelog),
				},
				{
					label: "Open Patch Notes",
					click: () => openExternal(HELP_LINKS.patchNotes),
				},
				{ type: "separator" },
				{
					label: "Open HachiGen Log Folder",
					click: () => openHachiGenLogFolder(),
				},
				{
					label: "Copy Diagnostic Info",
					click: () => copyDiagnosticInfo(),
				},
				{ type: "separator" },
				{
					label: "About HachiGen",
					click: () => showAboutDialog(),
				},
			],
		},
	]);
}

// Create the visible desktop window and load the renderer files. Security
// options here keep the web page isolated from raw Node.js access.
function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1240,
		height: 820,
		minWidth: 1040,
		minHeight: 720,
		title: "HachiGen",
		backgroundColor: "#000000",
		webPreferences: {
			// preload.js is the controlled doorway between the UI and this backend.
			preload: path.join(__dirname, "preload.js"),
			// These two settings keep Node.js APIs out of the web page itself.
			// The UI can only call the safe functions exposed by preload.js.
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

	// Links such as Cron Guru should open in the user's browser instead of
	// creating a second Electron window inside HachiGen.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});
}

// Register every safe action the renderer is allowed to request.
//
// IPC means "inter-process communication." HachiGen has two relevant processes:
//
// - Renderer process: the visible HTML/CSS/JS window in manager/renderer.
// - Main process: this file, which is allowed to use Node.js, Electron dialogs,
//   the clipboard, shell.openPath, filesystem code, child processes, and HachiManager.
//
// The renderer never imports manager.js directly. Instead the flow is:
//
// 1. renderer/app.js calls window.hachiGen.saveConfig(values).
// 2. preload.js maps that to ipcRenderer.invoke("manager:save-config", values).
// 3. ipcMain.handle("manager:save-config", ...) below receives the request here.
// 4. This main-process handler calls manager.writeConfiguration(values).
// 5. The returned value is sent back through the same promise to renderer/app.js.
//
// Each channel below is therefore part of HachiGen's private UI API. If a new
// button needs backend power, add a narrow channel here and expose only that
// specific capability in preload.js.
function registerIpc() {
	// State and install-path channels. These read or update the Hachi install
	// folder that every later operation uses as its root.
	ipcMain.handle("manager:get-state", () => manager.getState());

	ipcMain.handle("manager:choose-install-path", async () => {
		const result = await dialog.showOpenDialog(mainWindow, {
			title: "Choose Hachi install folder",
			properties: ["openDirectory", "createDirectory"],
		});

		if (result.canceled || !result.filePaths.length) {
			return manager.getState();
		}

		await manager.setInstallPath(result.filePaths[0]);
		return manager.getState();
	});

	ipcMain.handle("manager:set-install-path", async (_event, installPath) => {
		await manager.setInstallPath(installPath);
		return manager.getState();
	});

	ipcMain.handle("manager:choose-ssh-key", async () => {
		const result = await dialog.showOpenDialog(mainWindow, {
			filters: [
				{ name: "SSH private keys", extensions: ["key", "pem", "ppk"] },
				{ name: "All files", extensions: ["*"] },
			],
			properties: ["openFile"],
			title: "Choose SSH private key",
		});

		if (result.canceled || !result.filePaths.length) {
			return { ok: false, message: "SSH key selection canceled." };
		}

		return manager.validateSshKeyPath(result.filePaths[0]);
	});

	ipcMain.handle("manager:install-or-validate", () => manager.installOrValidate());
	ipcMain.handle("manager:validate-install", () => manager.validateInstall({ repair: true }));

	// Setup/configuration channels. Secrets are encrypted in HachiManager before
	// being written to disk; decrypted values are never returned to the renderer.
	ipcMain.handle("manager:read-config", () => manager.readActiveConfiguration());
	ipcMain.handle("manager:save-config", (_event, values) => manager.writeConfiguration(values));

	// Secret copy is handled in the main process because the renderer should not
	// receive plaintext secrets. The only renderer-visible result is a status
	// message saying the clipboard was populated temporarily.
	ipcMain.handle("manager:copy-env-secret", async (_event, field) => {
		const secret = await manager.readEnvSecretForCopy(field);

		clipboard.writeText(secret.value);
		scheduleClipboardClear(secret.value, secret.ttlMs);
		manager.log(`Secret protection: ${secret.field} copied to clipboard. Clipboard will be cleared in ${Math.round(secret.ttlMs / 1000)} seconds if unchanged.`);

		return {
			field: secret.field,
			message: `${secret.field} copied. Clipboard clears in ${Math.round(secret.ttlMs / 1000)} seconds if unchanged.`,
			ok: true,
			ttlMs: secret.ttlMs,
		};
	});

	// Remote-server channels. These update saved SSH settings or ask HachiManager
	// to run remote validation/actions through OpenSSH.
	ipcMain.handle("manager:save-remote-settings", (_event, values) => manager.saveRemoteSettings(values));
	ipcMain.handle("manager:set-runtime-target", (_event, target) => manager.setRuntimeTarget(target));
	ipcMain.handle("manager:test-remote-connection", () => manager.testRemoteConnection());

	// Update/runtime channels. These cover Git update checks, stashes, command
	// deployment, PM2 process control, and log/status reads.
	ipcMain.handle("manager:check-updates", () => manager.checkUpdates());
	ipcMain.handle("manager:check-version-updates", () => manager.checkVersionUpdates());
	ipcMain.handle("manager:check-hachigen-updates", () => manager.checkHachiGenUpdates());
	ipcMain.handle("manager:install-hachigen-update", () => installHachiGenUpdate());
	ipcMain.handle("manager:open-hachigen-release", () => {
		const releaseUrl = manager.hachiGenUpdateState?.releaseUrl || HELP_LINKS.releases;
		openExternal(releaseUrl);
		return { ok: true, message: "Opened HachiGen releases." };
	});
	ipcMain.handle("manager:apply-update", () => manager.applyUpdate());
	ipcMain.handle("manager:restore-stashed-changes", () => manager.restoreStashedChanges());
	ipcMain.handle("manager:delete-stashed-changes", () => manager.deleteStashedChanges());
	ipcMain.handle("manager:deploy-commands", () => manager.deployCommands());
	ipcMain.handle("manager:start-bot", () => manager.startBot());
	ipcMain.handle("manager:stop-bot", () => manager.stopBot());
	ipcMain.handle("manager:restart-bot", () => manager.restartBot());
	ipcMain.handle("manager:get-logs", () => manager.getLogs());
	ipcMain.handle("manager:get-pm2-status", () => manager.getPm2Status());
	ipcMain.handle("manager:record-renderer-event", (_event, payload) => manager.recordRendererEvent(payload));

	// Database viewer and maintenance channels. The renderer controls what the
	// user sees and confirms; HachiManager owns actual file/database mutations.
	ipcMain.handle("manager:read-database-table", (_event, tableName, sort) => manager.readDatabaseTable(tableName, sort));
	ipcMain.handle("manager:migrate-database", () => manager.migrateDatabase({ force: false }));
	ipcMain.handle("manager:force-migrate-database", () => manager.migrateDatabase({ force: true }));
	ipcMain.handle("manager:review-database-sanitation", () => manager.reviewDatabaseSanitation());

	ipcMain.handle("manager:backup-database", (_event, options = {}) => {
		// Confirmation is handled by the themed renderer modal. The backend only
		// performs the requested backup or reports that overwrite is needed.
		return manager.backupDatabase({ overwrite: Boolean(options.overwrite) });
	});

	ipcMain.handle("manager:choose-database-backup", async () => {
		// Restrict the file picker to HachiGen's backup folder. The manager still
		// validates the chosen path afterward in case the dialog returns odd input.
		const result = await dialog.showOpenDialog(mainWindow, {
			defaultPath: manager.getDatabaseBackupDir(),
			filters: [
				{ name: "SQLite backups", extensions: ["sqlite"] },
				{ name: "All files", extensions: ["*"] },
			],
			properties: ["openFile"],
			title: "Choose database backup",
		});

		if (result.canceled || !result.filePaths.length) {
			return { ok: false, message: "Database restore canceled." };
		}

		return {
			backupPath: result.filePaths[0],
			fileName: path.basename(result.filePaths[0]),
			ok: true,
			message: "Database backup selected.",
		};
	});

	ipcMain.handle("manager:restore-database", (_event, backupPath) => manager.restoreDatabaseFromBackup(backupPath));

	ipcMain.handle("manager:apply-database-sanitation", (_event, actionIds) => manager.applyDatabaseSanitation(actionIds));

	// Database protection channels. These generate/verify keys, convert plaintext
	// databases, rotate active keys, and maintain encrypted backup metadata.
	ipcMain.handle("manager:prepare-database-protection", () => manager.prepareDatabaseProtection());
	ipcMain.handle("manager:verify-database-protection", () => manager.verifyDatabaseProtection());
	ipcMain.handle("manager:convert-database-encryption", () => manager.convertDatabaseEncryption());
	ipcMain.handle("manager:rotate-database-key", (_event, options = {}) => manager.rotateDatabaseKey({
		rotateBackups: Boolean(options.rotateBackups),
	}));
	ipcMain.handle("manager:rotate-database-backups", () => manager.rotateDatabaseBackups());
	ipcMain.handle("manager:export-database-key-backup", async () => {
		const result = await dialog.showSaveDialog(mainWindow, {
			defaultPath: "hachi-db-key-backup.key",
			filters: [
				{ name: "Key backup", extensions: ["key", "txt"] },
				{ name: "All files", extensions: ["*"] },
			],
			title: "Export database key backup",
		});

		if (result.canceled || !result.filePath) {
			return { ok: false, message: "Database key backup export canceled." };
		}

		return manager.exportDatabaseKeyBackup(result.filePath);
	});

	// OS integration channel. shell.openPath has to stay in the main process
	// because the renderer is intentionally sandboxed away from shell access.
	ipcMain.handle("manager:open-install-folder", async () => {
		const installPath = manager.getInstallPath();
		// shell.openPath returns an empty string when it succeeds.
		const result = await shell.openPath(installPath);
		return { ok: result === "", message: result || "Opened install folder." };
	});
}

// Once Electron is ready, decide the default Hachi install folder, create the
// backend manager, register IPC routes, and show the first window.
app.whenReady().then(() => {
	// In development, HachiGen lives in manager/ and the repo root is one level
	// up. In the packaged exe, the correct default is beside HachiGen.exe.
	const defaultInstallPath = app.isPackaged ?
		path.dirname(process.execPath) :
		path.resolve(__dirname, "..");

	manager = new HachiManager({
		managerRoot: __dirname,
		defaultInstallPath,
		userDataPath: app.getPath("userData"),
		sendEvent,
	});
	manager.startLogCleanup({ runImmediately: true });
	manager.initCrashHandlers();

	registerIpc();
	Menu.setApplicationMenu(buildApplicationMenu());
	createWindow();

	app.on("activate", () => {
		// macOS convention: clicking the app icon should reopen a window.
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on("before-quit", () => {
	if (manager) {
		manager.stopLogCleanup();
	}
});

app.on("window-all-closed", () => {
	// On macOS, apps often stay open after the last window closes.
	// Windows/Linux apps normally quit, so HachiGen follows that behavior.
	if (process.platform !== "darwin") {
		app.quit();
	}
});
