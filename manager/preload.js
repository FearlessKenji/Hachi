// Safe renderer-to-main bridge for HachiGen.
const { contextBridge, ipcRenderer } = require("electron");

// preload.js is the safe bridge between the web page and Electron.
// The renderer can call window.hachiGen.* functions, but it never receives
// direct access to Node.js, the file system, or command execution.
function invoke(channel, ...args) {
	// ipcRenderer.invoke sends a request to ipcMain.handle(channel, ...) in
	// manager/main.js and returns a Promise for that handler's result.
	//
	// Example:
	// renderer/app.js calls api.saveConfig(values)
	// -> preload.js runs invoke("manager:save-config", values)
	// -> main.js receives it in ipcMain.handle("manager:save-config", ...)
	// -> HachiManager writes encrypted .env/config files
	// -> the result resolves back to renderer/app.js.
	//
	// Keeping this tiny wrapper here makes the exposed API below easy to scan and
	// keeps raw channel names out of renderer/app.js.
	return ipcRenderer.invoke(channel, ...args);
}

// Everything exposed here becomes window.hachiGen in renderer/app.js.
// This list is HachiGen's public UI API: renderer code can only ask for these
// specific actions, and main.js decides how to perform them.
contextBridge.exposeInMainWorld("hachiGen", {
	// Install/state actions.
	getState: () => invoke("manager:get-state"),
	chooseInstallPath: () => invoke("manager:choose-install-path"),
	chooseSshKey: () => invoke("manager:choose-ssh-key"),
	setInstallPath: installPath => invoke("manager:set-install-path", installPath),
	installOrValidate: () => invoke("manager:install-or-validate"),
	validateInstall: () => invoke("manager:validate-install"),

	// Setup/config actions. copyEnvSecret asks main.js to write directly to the
	// clipboard, so plaintext secrets do not pass through renderer JavaScript.
	readConfig: () => invoke("manager:read-config"),
	saveConfig: values => invoke("manager:save-config", values),
	copyEnvSecret: field => invoke("manager:copy-env-secret", field),

	// Remote, update, deployment, runtime, and log actions.
	saveRemoteSettings: values => invoke("manager:save-remote-settings", values),
	setRuntimeTarget: target => invoke("manager:set-runtime-target", target),
	testRemoteConnection: () => invoke("manager:test-remote-connection"),
	checkUpdates: () => invoke("manager:check-updates"),
	applyUpdate: () => invoke("manager:apply-update"),
	restoreStashedChanges: () => invoke("manager:restore-stashed-changes"),
	deleteStashedChanges: () => invoke("manager:delete-stashed-changes"),
	deployCommands: () => invoke("manager:deploy-commands"),
	startBot: () => invoke("manager:start-bot"),
	stopBot: () => invoke("manager:stop-bot"),
	restartBot: () => invoke("manager:restart-bot"),
	getLogs: () => invoke("manager:get-logs"),
	getPm2Status: () => invoke("manager:get-pm2-status"),
	recordRendererEvent: payload => invoke("manager:record-renderer-event", payload),

	// Database viewing, maintenance, encryption, and backup actions.
	readDatabaseTable: (tableName, sort) => invoke("manager:read-database-table", tableName, sort),
	migrateDatabase: () => invoke("manager:migrate-database"),
	forceMigrateDatabase: () => invoke("manager:force-migrate-database"),
	backupDatabase: options => invoke("manager:backup-database", options),
	chooseDatabaseBackup: () => invoke("manager:choose-database-backup"),
	restoreDatabase: backupPath => invoke("manager:restore-database", backupPath),
	reviewDatabaseSanitation: () => invoke("manager:review-database-sanitation"),
	applyDatabaseSanitation: actionIds => invoke("manager:apply-database-sanitation", actionIds),
	prepareDatabaseProtection: () => invoke("manager:prepare-database-protection"),
	verifyDatabaseProtection: () => invoke("manager:verify-database-protection"),
	convertDatabaseEncryption: () => invoke("manager:convert-database-encryption"),
	rotateDatabaseKey: options => invoke("manager:rotate-database-key", options),
	rotateDatabaseBackups: () => invoke("manager:rotate-database-backups"),
	exportDatabaseKeyBackup: () => invoke("manager:export-database-key-backup"),

	// OS integration action. main.js owns shell access.
	openInstallFolder: () => invoke("manager:open-install-folder"),

	// Subscribe to live manager events. The function returned here removes the
	// listener, which is the normal cleanup pattern for event subscriptions.
	onEvent(callback) {
		const listener = (_event, payload) => callback(payload);
		ipcRenderer.on("manager:event", listener);
		return () => ipcRenderer.removeListener("manager:event", listener);
	},
});
