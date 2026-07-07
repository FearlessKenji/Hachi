const path = require("node:path");
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { HachiManager } = require("./src/manager.js");

// Electron apps have a "main process" and one or more windows.
// This file is the main process: it creates the HachiGen window and
// connects window button clicks to backend manager actions.
let mainWindow;
let manager;

// Forward backend activity to the window when it is available. Backend actions
// can outlive a particular BrowserWindow, so this checks before sending.
function sendEvent(event) {
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("manager:event", event);
	}
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

// Register every safe action the renderer is allowed to request. IPC means
// "inter-process communication": the UI sends a channel name, and this main
// process runs the matching HachiManager method.
function registerIpc() {
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

	ipcMain.handle("manager:install-or-validate", () => manager.installOrValidate());
	ipcMain.handle("manager:validate-install", () => manager.validateInstall({ repair: true }));
	ipcMain.handle("manager:read-config", () => manager.readConfiguration());
	ipcMain.handle("manager:save-config", (_event, values) => manager.writeConfiguration(values));
	ipcMain.handle("manager:check-updates", () => manager.checkUpdates());
	ipcMain.handle("manager:apply-update", () => manager.applyUpdate());
	ipcMain.handle("manager:restore-stashed-changes", () => manager.restoreStashedChanges());
	ipcMain.handle("manager:delete-stashed-changes", () => manager.deleteStashedChanges());
	ipcMain.handle("manager:deploy-commands", () => manager.deployCommands());
	ipcMain.handle("manager:start-bot", () => manager.startBot());
	ipcMain.handle("manager:stop-bot", () => manager.stopBot());
	ipcMain.handle("manager:restart-bot", () => manager.restartBot());
	ipcMain.handle("manager:get-logs", () => manager.getLogs());
	ipcMain.handle("manager:get-pm2-status", () => manager.getPm2Status());
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

	registerIpc();
	createWindow();

	app.on("activate", () => {
		// macOS convention: clicking the app icon should reopen a window.
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on("window-all-closed", () => {
	// On macOS, apps often stay open after the last window closes.
	// Windows/Linux apps normally quit, so HachiGen follows that behavior.
	if (process.platform !== "darwin") {
		app.quit();
	}
});
