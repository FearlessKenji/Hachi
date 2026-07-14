// HachiGen renderer controller.
//
// This file owns browser-window state only. It never reads files or runs shell
// commands directly; every privileged action goes through window.hachiGen, which
// preload.js maps to IPC handlers in the Electron main process.
const api = window.hachiGen;

// renderer/app.js runs inside the visible HachiGen window.
// It reads state from the backend, updates text/classes in index.html,
// and turns button clicks into calls to window.hachiGen from preload.js.

// Human-readable titles for each sidebar view.
const viewTitles = {
	dashboard: "Dashboard",
	setup: "Setup",
	remote: "Remote",
	updates: "Updates",
	database: "Database",
	logs: "Logs",
};

// These names must match the input "name" attributes in index.html and the
// ENV_FIELDS/CONFIG_FIELDS lists in src/manager.js.
const configFields = [
	"TOKEN",
	"clientId",
	"guildIds",
	"botOwners",
	"twitchClientId",
	"twitchSecret",
	"kickClientId",
	"kickSecret",
	"twitchCron",
	"kickCron",
	"birthdayCron",
	"statusCron",
	"authCron",
];
const envConfigFields = [
	"TOKEN",
	"clientId",
	"twitchClientId",
	"twitchSecret",
	"kickClientId",
	"kickSecret",
];

// Shared UI state. Keeping these values here avoids reading the DOM to figure
// out what the app is currently showing.
//
// state: latest backend snapshot from manager.getState().
// activeView: sidebar view currently visible.
// busy: global action lock that disables buttons during backend work.
// logPollTimer/pm2LogBaseline: live log polling and "clear visible logs" offset.
// sanitizeReport: last database sanitation review/apply result.
// databaseView/databaseSort/databaseViewerLoading: table preview state.
// forceMigrationUnlocked: one-session flag for the dangerous migration button.
// confirmationResolve: current modal promise resolver.
// lastConfig: latest Setup config metadata, used to restore copy-button state.
let state = null;
let activeView = "dashboard";
let busy = false;
let logPollTimer = null;
let pm2LogBaseline = null;
let lastPm2LogText = "";
let hachiGenLogHistoryHidden = false;
let sanitizeReport = null;
let databaseView = null;
let databaseViewerLoading = false;
let databaseSort = { column: "", direction: "" };
let forceMigrationUnlocked = false;
let confirmationResolve = null;
let lastConfig = null;

function setDatabaseView(nextView) {
	// Keep database viewer state assignment outside async loader internals.
	// This avoids noisy race-condition lint warnings while staying explicit.
	databaseView = nextView;
}

function setDatabaseViewerLoading(nextLoading) {
	// This flag lets the UI disable viewer controls during a table load.
	databaseViewerLoading = nextLoading;
}

function setDatabaseSort(nextSort) {
	// Keep sort-state writes explicit and lint-friendly around async loads.
	databaseSort = nextSort;
}

// Tiny DOM helpers. They centralize common document lookups so the rest of
// this file can read like UI intent instead of repeated querySelector calls.
function $(selector) {
	return document.querySelector(selector);
}

function $all(selector) {
	return Array.from(document.querySelectorAll(selector));
}

// Safely update text when an element exists. Missing elements are ignored so
// one renderer function can update several views without crashing off-screen tabs.
function setText(selector, value) {
	const element = $(selector);

	if (element) {
		element.textContent = value ?? "";
	}
}

function setInputValue(selector, value) {
	const element = $(selector);

	if (element && document.activeElement !== element) {
		element.value = value ?? "";
	}
}

// Replace a status dot's classes with the current health class. The color is
// defined in CSS, so JavaScript only decides the state, not the styling.
function setDot(selector, status) {
	const element = $(selector);

	if (!element) {
		return;
	}

	element.className = `dot ${status || "muted"}`;
}

// Enable or disable a single button by selector. This is mainly used for
// buttons whose availability depends on backend state, such as stash actions.
function setDisabled(selector, disabled) {
	const element = $(selector);

	if (element) {
		element.disabled = disabled;
	}
}

// Convert PM2's byte count into a compact memory label for the runtime card.
function formatBytes(bytes) {
	if (!bytes) {
		return "0 MB";
	}

	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatFileSize(bytes) {
	if (!bytes) {
		return "0 B";
	}

	const units = ["B", "KB", "MB", "GB"];
	let value = Number(bytes) || 0;
	let unitIndex = 0;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}

	return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

// Convert machine-ish statuses like "not-registered" into readable UI text.
function formatStatusLabel(status) {
	const text = String(status || "Unknown").trim();

	if (!text) {
		return "Unknown";
	}

	return text
		.split(/[-_\s]+/)
		.map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
		.join(" ");
}

// Shorten long install paths for the sidebar while keeping the most useful
// right-hand portion visible, which usually contains the project folder name.
function shortPath(filePath) {
	if (!filePath) {
		return "Not set";
	}

	if (filePath.length <= 44) {
		return filePath;
	}

	return `...${filePath.slice(-41)}`;
}

function shortRemoteUrl(remoteUrl) {
	if (!remoteUrl) {
		return "origin not set";
	}

	const text = String(remoteUrl).trim().replace(/\.git$/u, "");
	const githubMatch = text.match(/github\.com[:/](.+)$/u);
	const label = githubMatch ? githubMatch[1] : text;

	if (label.length <= 36) {
		return label;
	}

	return `...${label.slice(-33)}`;
}

function repositoryRemoteLabel(repository) {
	if (!repository?.isGit) {
		return "Repo: Not a Git checkout";
	}

	return `Repo: ${shortRemoteUrl(repository.originUrl)}`;
}

function repositoryBranchLabel(repository) {
	if (!repository?.isGit) {
		return "Branch: Not available";
	}

	return `Branch: ${repository.currentBranch || "Unknown"}`;
}

function remoteRuntimeLabel(remote) {
	const settings = remote?.settings || {};
	const target = settings.host ? `${settings.username || "user"}@${settings.host}` : "Remote not configured";
	const remotePath = settings.remotePath ? ` | ${settings.remotePath}` : "";
	return `${target}${remotePath}`;
}

function activeTargetPathLabel(nextState) {
	if (nextState?.runtimeTarget === "remote") {
		return `Remote: ${remoteRuntimeLabel(nextState.remote)}`;
	}

	return `Local: ${nextState?.installPath || "Not set"}`;
}

function updateTargetLabel(updates) {
	return updates?.updateTarget || state?.repository?.updateTarget || "origin/main";
}

function updateMetaLabel(updates, repository, scan) {
	const version = scan?.packageVersion || "Unknown";

	if (!updates?.checkedAt) {
		return repository?.isGit ?
			`Branch: ${repository.currentBranch || "Unknown"} | Target: ${repository.updateTarget || "origin/main"} | Version: ${version}` :
			`Not checked | Version: ${version}`;
	}

	const checkedAt = new Date(updates.checkedAt).toLocaleString();
	const branch = updates.currentBranch || repository?.currentBranch || "Unknown";
	const target = updateTargetLabel(updates);
	return `Last checked: ${checkedAt} | Branch: ${branch} | Target: ${target} | Version: ${version}`;
}

function hachiGenUpdateMetaLabel(update, hachiGenVersion) {
	const version = update?.currentVersion || hachiGenVersion || "Unknown";

	if (!update?.checkedAt) {
		return `Not checked | HachiGen version: ${version}`;
	}

	const checkedAt = new Date(update.checkedAt).toLocaleString();
	const current = update.currentTag || "Not recorded";
	const latest = update.latestTag || "Unknown";
	const size = update.assetSize ? ` | Asset: ${formatFileSize(update.assetSize)}` : "";

	return `Last checked: ${checkedAt} | HachiGen version: ${version} | Installed release: ${current} | Latest HachiGen release: ${latest}${size}`;
}

// Disable action buttons while a backend action is running. Sidebar navigation
// stays enabled so the user can keep reading status/logs during long work.
function setBusy(nextBusy) {
	busy = nextBusy;
	$all("button:not([data-view])").forEach(button => {
		button.disabled = busy;
	});
}

function rendererLogMessage(message, fallback = "HachiGen event recorded without a message.") {
	// UI-generated errors may include exception text from many places. Redact the
	// common secret shapes before showing a fallback log entry in the renderer.
	return String(message || fallback)
		.replace(/((?:TOKEN|clientId|twitchClientId|twitchSecret|kickClientId|kickSecret|HACHI_DB_KEY|HACHI_SECRETS_KEY)=)(?:"[^"]*"|'[^']*'|\S+)/giu, "$1[redacted]")
		.replace(/(client(?:ID|Id|id|Secret)|token|secret)(["':=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/giu, "$1$2[redacted]");
}

function recordRendererEvent(type, message, details = {}) {
	// Send renderer-only events to the backend operation log. main.js will echo
	// the saved event back through api.onEvent(), so the visible Logs panel and
	// the actual HachiGen event history stay in sync.
	const safeMessage = rendererLogMessage(message, type === "error" ? "Unexpected HachiGen error." : "HachiGen event recorded.");

	if (!api.recordRendererEvent) {
		appendEvent({
			type,
			message: safeMessage,
			details,
			time: new Date().toISOString(),
		});
		return;
	}

	api.recordRendererEvent({
		type,
		message: safeMessage,
		details,
	}).catch(error => {
		// If the IPC bridge itself failed, still leave something visible in the
		// current window instead of letting the error disappear.
		appendEvent({
			type: "error",
			message: `Could not write HachiGen event log: ${rendererLogMessage(error.message || error)} Original event: ${safeMessage}`,
			time: new Date().toISOString(),
		});
	});
}

// Show a small temporary message in the bottom-right corner. Error toasts also
// write to the backend event log so the popup is never the only record.
function toast(message, type = "info", options = {}) {
	const text = rendererLogMessage(message, type === "error" ? "Unexpected HachiGen error." : "");

	if (type === "error" && options.log !== false) {
		recordRendererEvent("error", text, {
			label: options.label || "UI error",
		});
	}

	const region = $("#toastRegion");
	const item = document.createElement("div");
	item.className = `toast ${type}`;
	item.textContent = text;
	region.append(item);
	setTimeout(() => item.remove(), 4200);
}

// Convert a backend event object into one readable log line for the HachiGen
// log window. Shell output keeps its stdout/stderr/command prefix.
function eventLine(event) {
	const time = event.time ? new Date(event.time).toLocaleTimeString() : new Date().toLocaleTimeString();
	const streamLabels = {
		command: "Command",
		stderr: "Notice",
		stdout: "Output",
	};
	const typeLabels = {
		error: "Error",
		log: "HachiGen",
		shell: "Shell",
	};
	const prefix = event.type === "shell" && event.details?.stream ?
		streamLabels[event.details.stream] || "Shell" :
		typeLabels[event.type] || event.type;
	return `[${time}] ${prefix}: ${event.message}`;
}

// Append one live HachiGen event to the visible log window and keep only the
// newest lines so long installs do not make the UI sluggish.
function appendEvent(event) {
	const output = $("#eventLogs");

	if (!output) {
		return;
	}

	const current = output.textContent === "No manager activity yet." ? "" : output.textContent;
	output.textContent = `${current}${current ? "\n" : ""}${eventLine(event)}`.split("\n").slice(-220).join("\n");
	output.scrollTop = output.scrollHeight;
}

// Apply the current tab selection to the sidebar and content panels. This is
// also where log polling starts or stops after view changes.
function renderViews() {
	$all(".nav-item").forEach(button => {
		button.classList.toggle("active", button.dataset.view === activeView);
	});
	$all("[data-view-panel]").forEach(panel => {
		panel.classList.toggle("active", panel.dataset.viewPanel === activeView);
	});
	setText("#viewTitle", viewTitles[activeView] || "HachiGen");
	updateLogPolling();
}

// Change tabs by updating activeView, then redraw view visibility. Opening
// Logs or Database also fetches fresh data so those panels are useful immediately.
function showView(viewName) {
	activeView = viewName;
	renderViews();

	if (activeView === "logs") {
		refreshLogs();
	}

	if (activeView === "database" && state?.database?.exists && !databaseView) {
		loadDatabaseViewer();
	}
}

function installHealth(scan) {
	// Translate quickScan() output into the three values the Dashboard needs:
	// a label, a dot color, and a short detail line.
	if (!scan?.projectFound) {
		return { label: "Missing", dot: "bad", detail: "Project files incomplete" };
	}

	if (!scan.configurationReady) {
		return { label: "Needs config", dot: "warn", detail: `${scan.configurationMissing.length} config fields missing` };
	}

	if (!scan.hasNodeModules) {
		return { label: "Needs deps", dot: "warn", detail: "Dependencies install during validation or start" };
	}

	if (scan.dependenciesReady === false) {
		return { label: "Needs deps", dot: "warn", detail: `${scan.missingDependencies?.length || 0} package dependencies missing` };
	}

	return { label: "Validated", dot: "good", detail: "Project files and config found" };
}

function updateHealth(updates) {
	// Translate the backend update state into a compact Dashboard summary.
	// Detailed commit/file lists are rendered separately on the Updates tab.
	if (!updates || updates.status === "unchecked") {
		return { label: "Not checked", dot: "warn", detail: "Checking on startup" };
	}

	if (updates.status === "available") {
		return {
			label: "Updates available",
			dot: "warn",
			detail: updates.blocked ? "Local changes will be stashed" : "Ready to update",
		};
	}

	if (updates.status === "current") {
		return { label: "Current", dot: "good", detail: "No update found" };
	}

	if (updates.status === "branch_current") {
		return { label: "Branch differs", dot: "info", detail: `Files match ${updateTargetLabel(updates)}` };
	}

	if (updates.status === "history_current") {
		return { label: "History differs", dot: "info", detail: `Files match ${updateTargetLabel(updates)}` };
	}

	if (updates.status === "branch_mismatch") {
		return {
			label: "Manual update",
			dot: "warn",
			detail: updates.committedFilesMatchTarget ? "Local changes found" : `On ${updates.currentBranch || "another branch"}`,
		};
	}

	if (updates.status === "not_git") {
		return { label: "Manual", dot: "warn", detail: "Not a Git checkout" };
	}

	return { label: "Review", dot: "warn", detail: updates.message || "Update state needs review" };
}

function databaseHealth(database) {
	// Database audit status comes from database/dbAudit.js. Keep this small
	// mapping here so the Dashboard can gracefully handle missing audit data.
	const audit = database?.audit;

	if (!database?.exists) {
		return { label: "Not Created", dot: "muted", detail: "No database found" };
	}

	if (!audit) {
		return { label: "Checking", dot: "info", detail: "Audit not loaded" };
	}

	return {
		detail: audit.detail || "Schema status loaded",
		dot: audit.dot || "warn",
		label: audit.label || "Review",
	};
}

function botHealth(pm2) {
	// Translate PM2 process data into a Dashboard status. HachiGen treats a
	// missing or unregistered PM2 process as Stopped rather than an app crash.
	if (pm2?.target === "remote" && pm2.status === "remote-error") {
		return { label: "Remote Error", dot: "bad", detail: pm2.message || "Remote PM2 status unavailable" };
	}

	if (!pm2?.installed) {
		return {
			label: "PM2 missing",
			dot: "warn",
			detail: pm2?.target === "remote" ? pm2.message || "Remote PM2 is unavailable" : "PM2 installs during validation or start",
		};
	}

	if (!pm2.registered) {
		return { label: "Stopped", dot: "bad", detail: pm2.message || "Hachi is not registered" };
	}

	if (pm2.status === "online") {
		const prefix = pm2.target === "remote" ? "Remote " : "";
		return { label: "Online", dot: "good", detail: `${prefix}PID ${pm2.pid || "n/a"} | ${formatBytes(pm2.memory)}` };
	}

	if (pm2.status === "stopped") {
		return { label: "Stopped", dot: "bad", detail: pm2.message || "Hachi is stopped." };
	}

	if (pm2.status === "errored") {
		return { label: "Errored", dot: "bad", detail: pm2.message || "PM2 reported an error" };
	}

	return { label: formatStatusLabel(pm2.status), dot: "warn", detail: pm2.message || "PM2 status loaded" };
}

function renderInstallChecks(scan) {
	// Convert quickScan() output into the checklist under Setup -> Install.
	// Each row answers one setup question: are project files, config, packages,
	// and Git present enough for HachiGen to manage this folder?
	const container = $("#installChecks");

	if (!container || !scan) {
		return;
	}

	const checks = [
		["Project files", scan.projectFound, scan.missingFiles.length ? scan.missingFiles.join(", ") : "Found"],
		["Configuration", scan.configurationReady, scan.configurationReady ? "Ready" : scan.configurationMissing.join(", ")],
		["Node modules", scan.hasNodeModules, scan.hasNodeModules ? "Installed" : "Not installed yet"],
		["Dependencies", scan.dependenciesReady !== false, scan.dependenciesReady === false ? (scan.missingDependencies || []).join(", ") || "Missing packages" : "Ready"],
		["Git checkout", scan.hasGit, scan.hasGit ? "Available" : "Manual update mode"],
	];

	container.innerHTML = "";

	for (const [label, ok, detail] of checks) {
		const item = document.createElement("div");
		item.className = "check-item";

		const dot = document.createElement("span");
		dot.className = `dot ${ok ? "good" : "warn"}`;
		item.append(dot);

		const text = document.createElement("span");
		const strong = document.createElement("strong");
		strong.textContent = label;
		text.append(strong, `: ${detail}`);
		item.append(text);

		container.append(item);
	}
}

function renderConfig(config) {
	// Copy saved config values into the Setup form. The input names match
	// configFields, so this can fill both .env and config.json fields together.
	const form = $("#configForm");

	if (!form || !config?.values) {
		return;
	}

	lastConfig = config;

	for (const field of configFields) {
		const input = form.elements[field];
		const protection = config.envProtection?.fields?.[field];

		if (input) {
			if (protection?.hasValue) {
				input.value = "";
				input.placeholder = protection.encrypted ? "Encrypted value saved" : "Saved value will be encrypted on save";
				input.dataset.protectedValue = "true";
			} else {
				input.value = config.values[field] || "";
				input.placeholder = "";
				delete input.dataset.protectedValue;
			}
		}

		if (envConfigFields.includes(field)) {
			const copyButton = form.querySelector(`[data-action="copy-secret"][data-secret-field="${field}"]`);

			if (copyButton) {
				copyButton.disabled = !protection?.copyable;
				copyButton.title = protection?.copyable ?
					"Copy saved value to clipboard for 60 seconds" :
					"Save an encrypted value before copying";
			}
		}
	}
}

function selectedRemotePortMode() {
	return $("input[name=\"remotePortMode\"]:checked")?.value === "custom" ? "custom" : "default";
}

function updateRemotePortMode() {
	const portInput = $("#remotePortInput");

	if (portInput) {
		portInput.disabled = selectedRemotePortMode() !== "custom";
	}
}

function readRemoteForm() {
	return {
		host: $("#remoteHostInput")?.value || "",
		username: $("#remoteUsernameInput")?.value || "",
		sshKeyPath: $("#remoteSshKeyInput")?.value || "",
		portMode: selectedRemotePortMode(),
		port: $("#remotePortInput")?.value || "22",
		remotePath: $("#remotePathInput")?.value || "",
		pm2Name: $("#remotePm2Input")?.value || "Hachi",
	};
}

function renderRemote(remote, runtimeTarget = "local") {
	const settings = remote?.settings || {};
	const portMode = settings.portMode === "custom" ? "custom" : "default";
	const target = settings.host ? `${settings.username || "user"}@${settings.host}` : "Not configured";
	const portLabel = portMode === "custom" ? String(settings.port || "") : "22 (default)";
	const errors = remote?.errors || [];

	setInputValue("#remoteHostInput", settings.host || "");
	setInputValue("#remoteUsernameInput", settings.username || "");
	setInputValue("#remoteSshKeyInput", settings.sshKeyPath || "");
	setInputValue("#remotePortInput", settings.port || 22);
	setInputValue("#remotePathInput", settings.remotePath || "");
	setInputValue("#remotePm2Input", settings.pm2Name || "Hachi");

	$all("input[name=\"remotePortMode\"]").forEach(input => {
		input.checked = input.value === portMode;
	});
	$all("input[name=\"runtimeTarget\"]").forEach(input => {
		input.checked = input.value === runtimeTarget;
	});
	updateRemotePortMode();

	setText("#remoteMeta", remote?.configured ? `Ready: ${target}` : errors[0] || "Not configured");
	setText("#remotePreviewTarget", target);
	setText("#remotePreviewPort", portLabel);
	setText("#remotePreviewPath", settings.remotePath || "Not configured");
	setText("#remotePreviewPm2", settings.pm2Name || "Hachi");
}

function formatRemoteTestOutput(result) {
	const lines = [`Exit code: ${result.code}`];
	const stdout = String(result.stdout || "").trim();
	const stderr = String(result.stderr || "").trim();

	if (stdout) {
		lines.push(`stdout:\n${stdout}`);
	}

	if (stderr) {
		lines.push(`stderr:\n${stderr}`);
	}

	return lines.join("\n\n");
}

function pluralize(count, singular, plural = `${singular}s`) {
	// Format simple count labels such as "1 file" vs "2 files".
	return `${count} ${count === 1 ? singular : plural}`;
}

function renderSimpleList(selector, items, emptyText, renderItem) {
	// Clear and rebuild a list from data. Callers provide renderItem so the
	// same helper can render commits, empty states, or other simple rows.
	const list = $(selector);

	if (!list) {
		return;
	}

	list.innerHTML = "";

	if (!items.length) {
		const item = document.createElement("li");
		item.className = "update-list-empty";
		item.textContent = emptyText;
		list.append(item);
		return;
	}

	for (const entry of items) {
		list.append(renderItem(entry));
	}
}

function renderGroupedChangesList(selector, changes, emptyText) {
	// Group Git file changes by label, such as New, Modified, and Deleted.
	// The Local changes and Stashed changes panels share this layout so both
	// panels explain file status the same way.
	const list = $(selector);

	if (!list) {
		return;
	}

	if (!changes.length) {
		renderSimpleList(selector, [], emptyText, () => document.createElement("li"));
		return;
	}

	const groups = new Map();
	const groupOrder = ["New", "Modified", "Added", "Deleted", "Renamed", "Copied", "Conflict", "Changed"];

	for (const change of changes) {
		// Build a map such as { Modified: [file1, file2], New: [file3] }.
		if (!groups.has(change.label)) {
			groups.set(change.label, []);
		}

		groups.get(change.label).push(change);
	}

	list.innerHTML = "";

	for (const labelName of groupOrder) {
		const group = groups.get(labelName);

		if (!group?.length) {
			continue;
		}

		const groupItem = document.createElement("li");
		groupItem.className = "local-change-group";

		const heading = document.createElement("div");
		heading.className = "local-change-heading";

		const label = document.createElement("span");
		// CSS colors the label chip based on the change type.
		label.className = `change-label change-label-${labelName.toLowerCase()}`;
		label.textContent = labelName;
		heading.append(label);

		const count = document.createElement("span");
		count.textContent = pluralize(group.length, "file");
		heading.append(count);
		groupItem.append(heading);

		const fileList = document.createElement("ul");
		fileList.className = "local-change-files";

		for (const change of group) {
			const fileItem = document.createElement("li");
			fileItem.textContent = change.path;
			fileList.append(fileItem);
		}

		groupItem.append(fileList);
		list.append(groupItem);
	}
}

function renderIncomingUpdates(updates) {
	// Render commits that exist on the update target but not in the local install.
	// This lets the Updates panel show what an update would actually bring in.
	const commits = updates?.incomingCommits || [];
	const summary = $("#incomingSummary");
	const target = updateTargetLabel(updates);

	if (!summary) {
		return;
	}

	if (!updates || updates.status === "unchecked") {
		summary.textContent = "No update check has run yet.";
		renderSimpleList("#incomingCommitsList", [], "Check updates to see incoming commits.", () => document.createElement("li"));
		return;
	}

	if (updates.status === "not_git") {
		summary.textContent = "This install is not a Git checkout, so incoming changes cannot be shown.";
		renderSimpleList("#incomingCommitsList", [], "Manual update mode.", () => document.createElement("li"));
		return;
	}

	if (updates.status === "branch_current" || updates.status === "history_current") {
		summary.textContent = `Files match ${target}. No update is needed for this build.`;
	} else if (updates.status === "branch_mismatch") {
		summary.textContent = updates.message || `Current branch differs from ${target}. Use Git to update manually.`;
	} else if (updates.diverged) {
		summary.textContent = `Local and ${target} history have diverged. Review with Git before updating.`;
	} else if (commits.length) {
		summary.textContent = `${pluralize(commits.length, "incoming commit")} available from ${target}.`;
	} else {
		summary.textContent = "No incoming commits. Hachi is up to date.";
	}

	const visibleCommits = commits.slice(0, 12);
	const hiddenCount = Math.max(0, commits.length - visibleCommits.length);
	// Keep the panel readable by showing the first 12 commits plus a summary row.
	const listItems = hiddenCount ?
		[...visibleCommits, { hash: "", message: `${pluralize(hiddenCount, "more commit")} not shown.`, text: "" }] :
		visibleCommits;

	renderSimpleList("#incomingCommitsList", listItems, "No incoming commits.", commit => {
		const item = document.createElement("li");
		item.className = "update-list-row";

		if (commit.hash) {
			const hash = document.createElement("code");
			hash.textContent = commit.hash;
			item.append(hash);
		}

		const message = document.createElement("span");
		message.textContent = commit.message || commit.text;
		item.append(message);
		return item;
	});
}

function renderLocalChanges(updates) {
	// Render files changed in the selected install folder. These files do not
	// block updates anymore, but HachiGen shows them before stashing/updating.
	const changes = updates?.localChangeDetails || [];
	const summary = $("#localChangesSummary");
	const list = $("#localChangesList");
	const sourceLabel = updates?.source === "remote" ? "Remote" : "Local";

	if (!summary || !list) {
		return;
	}

	if (!updates || updates.status === "unchecked") {
		summary.textContent = "Local changes have not been checked yet.";
		renderSimpleList("#localChangesList", [], "Check updates to see local changes.", () => document.createElement("li"));
		return;
	}

	if (!changes.length) {
		summary.textContent = `Clean working tree. ${sourceLabel} files will not block updates.`;
		renderSimpleList("#localChangesList", [], "No local changes.", () => document.createElement("li"));
		return;
	}

	summary.textContent = updates?.available ?
		`${pluralize(changes.length, `${sourceLabel.toLowerCase()} file`)} changed. These files will be saved to a recoverable stash before updating.` :
		`${pluralize(changes.length, `${sourceLabel.toLowerCase()} file`)} changed.`;

	renderGroupedChangesList("#localChangesList", changes, "No local changes.");
}

function renderStashedChanges(updates) {
	// Render the active HachiGen-created stash and enable Restore/Delete only
	// when there is actually a saved stash available.
	const stash = updates?.stash || null;
	const changes = stash?.changes || [];

	setDisabled("#restoreChangesButton", !stash);
	setDisabled("#deleteChangesButton", !stash);

	if (!stash) {
		setText("#stashSummary", "No saved HachiGen stash. If local changes exist during update, HachiGen will save them here first.");
		renderGroupedChangesList("#stashChangesList", [], "No stashed changes.");
		return;
	}

	const created = stash.createdAt ? new Date(stash.createdAt).toLocaleString() : "unknown time";
	setText(
		"#stashSummary",
		`Saved changes are available to restore from ${stash.ref}. Created ${created}. Restore applies them and keeps the stash until you delete it.`,
	);
	renderGroupedChangesList("#stashChangesList", changes, "No file list available for this stash.");
}

function renderHachiGenUpdate(update) {
	// HachiGen updates come from GitHub release assets rather than the Hachi Git
	// checkout, so they have their own status text and install button.
	setText("#hachigenUpdateMeta", hachiGenUpdateMetaLabel(update, state?.hachiGenVersion));
	setText("#hachigenUpdateMessage", update?.message || "Check for the latest HachiGen release.");
	setDisabled("#installHachiGenUpdateButton", !update?.canInstall);
}

function formatDateTime(value) {
	// Convert an ISO timestamp into local time for compact status rows.
	if (!value) {
		return "Unknown";
	}

	return new Date(value).toLocaleString();
}

function describeProtectionItem(item) {
	if (!item) {
		return "Not checked";
	}

	const version = item.version ? ` ${item.version}` : "";
	return `${item.label || "Not Verified"}${version}: ${item.detail || "No detail available."}`;
}

function renderDatabaseProtection(protection) {
	const sourceLabel = protection?.source === "remote" ? "Remote" : "Local";
	const keyFile = protection?.configuredKeyFile || (protection?.directKeyConfigured ? "Direct key configured" : "Not configured");
	const recommended = protection?.locations?.recommended?.path || "Not resolved";
	const detail = protection?.detail || "No protection state loaded.";
	const keyReady = [`key-ready`, `direct-key`].includes(protection?.status);
	const databaseFile = protection?.databaseFile;
	const driver = protection?.driver;
	const cipherTest = protection?.cipherTest;
	const runtime = protection?.runtime;
	const databasePlain = databaseFile?.status === "plaintext";
	const databaseEncrypted = Boolean(databaseFile?.encryptedLikely);
	const keyActionLabel = keyReady ? "Rotate Key" : "Generate Key";
	let message = "Generate a key so Hachi can create or use encrypted databases.";

	if (databaseEncrypted) {
		message = "Database is encrypted. Keep the key backup somewhere protected.";
	} else if (databaseFile?.status === "missing" && keyReady) {
		message = "No database exists yet. Hachi will create an encrypted database on first start.";
	} else if (databaseFile?.status === "invalid") {
		message = "Database file could not be opened with the configured key. Restore a valid encrypted backup.";
	} else if (databasePlain && keyReady) {
		message = "Plaintext database detected. HachiGen will convert it during validation/start, or Hachi will refuse to start.";
	} else if (keyReady) {
		message = "Key and runtime are ready.";
	}

	if (cipherTest) {
		message = `${cipherTest.label || "Cipher Test"}: ${cipherTest.detail || "No detail available."}`;
	}

	setText("#databaseProtectionMeta", `${sourceLabel} key management`);
	setDot("#databaseProtectionDot", protection?.dot || "muted");
	setText("#databaseProtectionStatus", protection?.label || "Checking");
	setText("#databaseProtectionDetail", detail);
	setText("#databaseProtectionKeyFile", keyFile);
	setText("#databaseProtectionRecommendedPath", recommended);
	setText("#databaseProtectionDatabaseFile", describeProtectionItem(databaseFile));
	setText("#databaseProtectionDriver", describeProtectionItem(driver));
	setText("#databaseProtectionCipherTest", describeProtectionItem(cipherTest));
	setText("#databaseProtectionRuntime", describeProtectionItem(runtime));
	setText("#databaseProtectionChecked", protection?.updatedAt ? formatDateTime(protection.updatedAt) : "Not checked");
	setText("#databaseProtectionMessage", message);
	setText("#databaseKeyActionButton", keyActionLabel);
	setDisabled("#exportDatabaseKeyBackupButton", !keyReady);
}

function databaseBackupProtectionSummary(backups) {
	const counts = {
		current: 0,
		invalid: 0,
		older: 0,
		plaintext: 0,
		unverified: 0,
	};

	for (const backup of backups) {
		const status = backup?.protection?.status;

		if (status === "current-key") {
			counts.current += 1;
		} else if (status === "older-key" || status === "tracked-key") {
			counts.older += 1;
		} else if (status === "plaintext") {
			counts.plaintext += 1;
		} else if (status === "invalid") {
			counts.invalid += 1;
		} else {
			counts.unverified += 1;
		}
	}

	const parts = [];

	if (counts.current) {
		parts.push(`${counts.current} current`);
	}

	if (counts.older) {
		parts.push(`${counts.older} older-key`);
	}

	if (counts.plaintext) {
		parts.push(`${counts.plaintext} plaintext`);
	}

	if (counts.invalid) {
		parts.push(`${counts.invalid} invalid`);
	}

	if (counts.unverified) {
		parts.push(`${counts.unverified} not verified`);
	}

	return parts.length ? `Protection: ${parts.join(", ")}.` : "";
}

function databaseBackupProtectionLabel(backup) {
	const protection = backup?.protection;

	if (!protection) {
		return "Protection not verified";
	}

	const preview = protection.keyFingerprintPreview &&
		["older-key", "tracked-key"].includes(protection.status) ?
		` ${protection.keyFingerprintPreview}` :
		"";

	return `${protection.label || "Protection not verified"}${preview}`;
}

function renderDatabase(database) {
	// Render database file status and known backups. Database actions handle
	// their own shared confirmation prompts before changing files.
	// This function only paints the current known state; it never touches files.
	const exists = Boolean(database?.exists);
	const backups = database?.backups || [];
	const audit = database?.audit;
	const sourcePrefix = database?.source === "remote" ? "Remote " : "";
	const keyReady = ["key-ready", "direct-key"].includes(database?.protection?.status);
	const backupSummary = databaseBackupProtectionSummary(backups);

	setText("#databaseMeta", exists ? `${sourcePrefix}SQLite database ${audit?.label || "ready"}` : `No ${sourcePrefix.toLowerCase()}database found`);
	setText("#databaseMessage", exists ? audit?.detail || "Maintenance actions create safety backups before risky changes." : "Start Hachi once to create the database.");
	setText("#databaseStatus", exists ? "Found" : "Missing");
	setText("#databasePath", database?.path || "Not found");
	setText("#databaseSize", database?.sizeLabel || "0 B");
	setText("#databaseModified", formatDateTime(database?.modifiedAt));
	setText("#databaseAuditStatus", audit ? `${audit.label}: ${audit.detail}` : "Not checked");
	setDisabled("#migrateDatabaseButton", !audit?.migrationAvailable);
	setDisabled("#forceMigrateDatabaseButton", !(audit?.forceMigrationAvailable || forceMigrationUnlocked));
	setDisabled("button[data-action=\"restore-database\"]", database?.source === "remote");
	setDisabled("#rotateDatabaseBackupsButton", !keyReady || !backups.length);
	renderDatabaseProtection(database?.protection);

	const latest = database?.latestBackup;
	setText(
		"#databaseBackupSummary",
		latest ?
			`${pluralize(backups.length, "backup")} available. Latest: ${latest.file}. ${backupSummary}` :
			"No database backups found.",
	);

	renderSimpleList("#databaseBackupList", backups.slice(0, 8), "No backups yet.", backup => {
		// Show a compact newest-first backup list. The full path is kept in the
		// backend; the UI only needs filename, size, and modified time.
		const item = document.createElement("li");
		item.className = "update-list-row";

		const file = document.createElement("code");
		file.textContent = backup.file;
		item.append(file);

		const detail = document.createElement("span");
		detail.textContent = `${backup.sizeLabel} | ${formatDateTime(backup.modifiedAt)} | ${databaseBackupProtectionLabel(backup)}`;
		item.append(detail);
		return item;
	});
}

function formatDatabaseValue(value) {
	// Database cells can be null, numbers, strings, or occasionally binary data.
	// Convert everything to readable text while making null values obvious.
	if (value === null || value === undefined) {
		return "NULL";
	}

	if (typeof value === "object") {
		return JSON.stringify(value);
	}

	return String(value);
}

function renderDatabaseViewer(view) {
	// Render the read-only table viewer. The backend chooses and validates the
	// table; this function only updates the dropdown and table element.
	const select = $("#databaseTableSelect");
	const table = $("#databaseViewerTable");
	const tables = view?.tables || [];
	const selectedTable = view?.selectedTable || "";
	const columns = view?.columns || [];
	const rows = view?.rows || [];
	const activeSortColumn = view?.sortColumn || "";
	const activeSortDirection = view?.sortDirection || "";

	if (select) {
		select.innerHTML = "";

		if (!tables.length) {
			const option = document.createElement("option");
			option.textContent = "No tables";
			option.value = "";
			select.append(option);
		} else {
			for (const tableInfo of tables) {
				const option = document.createElement("option");
				option.textContent = `${tableInfo.name} (${pluralize(tableInfo.rowCount, "row")})`;
				option.value = tableInfo.name;
				select.append(option);
			}
		}

		select.value = selectedTable;
		select.disabled = databaseViewerLoading || !tables.length;
	}

	setDisabled("#refreshDatabaseViewerButton", databaseViewerLoading || !tables.length);

	if (!view) {
		setText("#databaseViewerMeta", "No table loaded.");
	} else if (!selectedTable) {
		setText("#databaseViewerMeta", "No database tables found.");
	} else {
		const shownCount = Math.min(rows.length, view.totalRows || rows.length);
		setText(
			"#databaseViewerMeta",
			`${selectedTable}: showing ${shownCount} of ${pluralize(view.totalRows || 0, "row")}.`,
		);
	}

	if (!table) {
		return;
	}

	table.innerHTML = "";

	if (!view || !selectedTable) {
		const body = document.createElement("tbody");
		const row = document.createElement("tr");
		const cell = document.createElement("td");
		cell.textContent = "No table loaded.";
		row.append(cell);
		body.append(row);
		table.append(body);
		return;
	}

	const head = document.createElement("thead");
	const headRow = document.createElement("tr");

	for (const column of columns) {
		const cell = document.createElement("th");
		const button = document.createElement("button");
		button.className = "database-sort-button";
		button.dataset.action = "sort-database-column";
		button.dataset.column = column;
		button.textContent = activeSortColumn === column ?
			`${column} ${activeSortDirection === "desc" ? "↓" : "↑"}` :
			column;
		cell.append(button);
		headRow.append(cell);
	}

	head.append(headRow);
	table.append(head);

	const body = document.createElement("tbody");

	if (!rows.length) {
		const row = document.createElement("tr");
		const cell = document.createElement("td");
		cell.colSpan = Math.max(columns.length, 1);
		cell.textContent = "This table is empty.";
		row.append(cell);
		body.append(row);
	} else {
		for (const rowData of rows) {
			const row = document.createElement("tr");

			for (const column of columns) {
				const cell = document.createElement("td");
				cell.textContent = formatDatabaseValue(rowData[column]);
				row.append(cell);
			}

			body.append(row);
		}
	}

	table.append(body);
}

function severityRank(severity) {
	// Sort sanitation findings from most urgent to least urgent.
	const ranks = {
		critical: 0,
		warning: 1,
		info: 2,
	};

	return ranks[severity] ?? 3;
}

function renderSanitizeSummary(report) {
	// Keep the Database tab's small review panel synchronized with the latest
	// modal report so users can close the modal without losing the result.
	// The modal has the full details; this panel is just a quick reminder.
	const summary = report?.summary;
	const findings = report?.findings || [];

	if (!summary) {
		setText("#databaseSanitizeSummary", "No review has run yet.");
		renderSimpleList("#databaseSanitizeList", [], "Run Sanitize to review the database.", () => document.createElement("li"));
		return;
	}

	if (!findings.length) {
		setText("#databaseSanitizeSummary", "Database review found no issues.");
		renderSimpleList("#databaseSanitizeList", [], "No sanitation findings.", () => document.createElement("li"));
		return;
	}

	setText(
		"#databaseSanitizeSummary",
		`${pluralize(summary.findingCount, "finding")} found. ${pluralize(summary.cleanableCount, "group")} can be cleaned.`,
	);

	renderSimpleList("#databaseSanitizeList", findings.slice(0, 6), "No sanitation findings.", finding => {
		// Use the same colored label pattern as the Updates page so severity is
		// easy to scan: critical/red, warning/yellow, info/blue.
		const item = document.createElement("li");
		item.className = "update-list-row";

		const label = document.createElement("span");
		label.className = `change-label change-label-${finding.severity || "info"}`;
		label.textContent = finding.severity || "info";
		item.append(label);

		const detail = document.createElement("span");
		detail.textContent = `${finding.title} (${finding.count})`;
		item.append(detail);
		return item;
	});
}

function createModalSummary(text) {
	// Modal summaries use the same spacing and text color no matter which
	// feature opened the shared popup.
	const summary = document.createElement("div");
	summary.className = "modal-summary";
	summary.textContent = text || "";
	return summary;
}

function createModalDetails(details) {
	// Confirmation prompts show their supporting notes as one consistent list.
	const list = document.createElement("ul");
	list.className = "modal-details";

	for (const detail of details) {
		const item = document.createElement("li");
		item.textContent = detail;
		list.append(item);
	}

	return list;
}

function createModalCheckbox({ checked = false, description = "", id = "modalCheckbox", label = "" } = {}) {
	const wrapper = document.createElement("label");
	wrapper.className = "modal-choice";

	const input = document.createElement("input");
	input.checked = Boolean(checked);
	input.id = id;
	input.type = "checkbox";
	wrapper.append(input);

	const body = document.createElement("span");
	body.className = "modal-choice-body";

	const title = document.createElement("strong");
	title.textContent = label || "Enable option";
	body.append(title);

	if (description) {
		const detail = document.createElement("span");
		detail.textContent = description;
		body.append(detail);
	}

	wrapper.append(body);
	return wrapper;
}

function createModalButton({ action, disabled = false, id, label, variant = "secondary" }) {
	// The shared modal footer is rebuilt each time the popup opens. Buttons use
	// the same data-action event routing as the rest of HachiGen.
	const button = document.createElement("button");
	button.className = `button ${variant}`;
	button.disabled = disabled;
	button.textContent = label;
	button.type = "button";

	if (action) {
		button.dataset.action = action;
	}

	if (id) {
		button.id = id;
	}

	return button;
}

function showSharedModal({ actions = [], content = [], meta, title }) {
	// This is the one modal frame used for both review popups and confirmations.
	// Callers provide the title, body nodes, and footer buttons they need.
	const modal = $("#sharedModal");
	const body = $("#sharedModalBody");
	const footer = $("#sharedModalActions");

	if (!modal || !body || !footer) {
		return false;
	}

	setText("#sharedModalTitle", title || "Review");
	setText("#sharedModalMeta", meta || "Review loaded");

	body.replaceChildren(...content.filter(Boolean));
	footer.replaceChildren(...actions.map(createModalButton));
	modal.hidden = false;
	return true;
}

function closeSharedModal() {
	// Close the one shared popup and clear its dynamic body/footer content.
	const modal = $("#sharedModal");
	const body = $("#sharedModalBody");
	const footer = $("#sharedModalActions");

	if (modal) {
		modal.hidden = true;
	}

	if (body) {
		body.replaceChildren();
	}

	if (footer) {
		footer.replaceChildren();
	}
}

function renderSanitizeModal(report, selectedActionIds = null) {
	// Build the review popup. Cleanable findings get checkboxes; schema and
	// review-only findings are shown for awareness but cannot be auto-cleaned.
	// Nothing is changed by opening this modal. Cleanup only starts when the
	// user clicks Clean Selected and confirms the themed HachiGen prompt.
	sanitizeReport = report;

	const findings = [...(report?.findings || [])].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
	const cleanableCount = findings.filter(finding => finding.cleanable).length;
	const selectedActions = selectedActionIds ? new Set(selectedActionIds) : null;
	const summary = createModalSummary(
		findings.length ?
			`${pluralize(findings.length, "finding")} found. ${pluralize(cleanableCount, "cleanable group")} selected by default.` :
			"No database issues found.",
	);
	const findingsContainer = document.createElement("div");
	findingsContainer.className = "sanitize-findings";

	if (!findings.length) {
		const empty = document.createElement("div");
		empty.className = "sanitize-empty";
		empty.textContent = "No sanitation findings.";
		findingsContainer.append(empty);
	} else {
		for (const finding of findings) {
			const item = document.createElement("label");
			item.className = `sanitize-finding sanitize-${finding.severity || "info"}`;

			if (finding.cleanable) {
				// Cleanable findings are checked by default because the review has
				// already limited them to conservative, database-only fixes.
				const checkbox = document.createElement("input");
				checkbox.type = "checkbox";
				checkbox.checked = selectedActions ? selectedActions.has(finding.id) : true;
				checkbox.value = finding.id;
				checkbox.dataset.cleanAction = finding.id;
				item.append(checkbox);
			} else {
				// Non-cleanable findings still appear in the modal, but without a
				// checkbox. These are issues the user should review manually.
				const spacer = document.createElement("span");
				spacer.className = "sanitize-spacer";
				item.append(spacer);
			}

			const body = document.createElement("span");
			body.className = "sanitize-finding-body";

			const title = document.createElement("strong");
			title.textContent = `${finding.title} (${finding.count})`;
			body.append(title);

			const description = document.createElement("span");
			description.textContent = finding.description;
			body.append(description);

			item.append(body);
			findingsContainer.append(item);
		}
	}

	renderSanitizeSummary(report);
	showSharedModal({
		actions: [
			{ action: "sanitize-close", label: "Cancel", variant: "secondary" },
			{
				action: "apply-sanitize",
				disabled: cleanableCount === 0,
				id: "applySanitizeButton",
				label: "Clean Selected",
				variant: "warning",
			},
		],
		content: [summary, findingsContainer],
		meta: `Reviewed ${formatDateTime(report?.reviewedAt)}`,
		title: "Database sanitation review",
	});
}

function hideSanitizeModal() {
	// Close the review popup without discarding the summary shown on the tab.
	closeSharedModal();
}

function selectedSanitizeActionIds() {
	// Read the checked cleanup actions from the review popup.
	return $all("[data-clean-action]:checked").map(input => input.value);
}

function migrationIssuesForMode(force) {
	// Safe migration shows safe issues. Force migration also shows destructive
	// issues so the warning is specific instead of vague.
	const audit = state?.database?.audit;

	if (!audit) {
		return [];
	}

	return force ?
		[...(audit.forceIssues || []), ...(audit.safeIssues || [])] :
		audit.safeIssues || [];
}

function databaseMigrationDetails(force) {
	// Build the detail rows shown in the shared confirmation modal. The audit
	// messages come from database/dbAudit.js and are read-only until confirmed.
	const issues = migrationIssuesForMode(force);

	if (!issues.length) {
		const emptyMessage = force ?
			"No destructive issues are currently reported." :
			"No safe migration issues are currently reported.";

		return [emptyMessage];
	}

	return issues.map(issue => issue.message || issue.id || "Database schema issue");
}

function confirmDatabaseMigration(force) {
	// Migration uses the same confirmation template as backup, restore, and
	// sanitation so all yes/no prompts look and behave consistently.
	showConfirmModal({
		confirmText: force ? "Force Migrate" : "Migrate",
		details: databaseMigrationDetails(force),
		meta: force ? "Destructive migration confirmation" : "Safe migration confirmation",
		summary: force ?
			"HachiGen will create a backup first, then force the database into the current Hachi schema. Extra columns may be dropped." :
			"HachiGen will create a backup first and stop if destructive changes are required.",
		title: force ? "Force database migration" : "Database migration",
		variant: force ? "danger" : "warning",
	}).then(confirmed => {
		if (!confirmed) {
			toast(force ? "Force database migration canceled." : "Database migration canceled.");
			return;
		}

		runAction(force ? "Force migrate database" : "Migrate database", () => force ? api.forceMigrateDatabase() : api.migrateDatabase())
			.then(result => {
				if (result?.ok) {
					forceMigrationUnlocked = false;
					databaseView = null;
					setDatabaseSort({ column: "", direction: "" });
					refreshCurrentDatabaseViewer();
				} else if (!force) {
					forceMigrationUnlocked = true;
					renderDatabase(state?.database);
				}
			});
	});
}

function closeConfirmModal(confirmed) {
	// Resolve the promise created by showConfirmModal(). This keeps each caller
	// free to decide what happens after the themed confirmation closes.
	const resolve = confirmationResolve;
	confirmationResolve = null;

	closeSharedModal();

	if (resolve) {
		resolve(confirmed);
	}
}

function showConfirmModal({ checkbox = null, confirmText = "Confirm", details = [], meta, summary, title, variant = "warning" }) {
	// Shared themed confirmation modal for every yes/no action. File/folder
	// pickers still remain native Windows dialogs.
	return new Promise(resolve => {
		const checkboxNode = checkbox ? createModalCheckbox(checkbox) : null;
		const checkboxInput = checkboxNode?.querySelector("input") || null;
		confirmationResolve = confirmed => {
			if (!checkbox) {
				resolve(confirmed);
				return;
			}

			resolve({
				checked: Boolean(checkboxInput?.checked),
				confirmed,
			});
		};
		const opened = showSharedModal({
			actions: [
				{ action: "confirm-cancel", label: "Cancel", variant: "secondary" },
				{ action: "confirm-accept", label: confirmText, variant },
			],
			content: [createModalSummary(summary), createModalDetails(details), checkboxNode],
			meta: meta || "Review the action before continuing",
			title: title || "Confirm action",
		});

		if (!opened) {
			confirmationResolve = null;
			resolve(false);
		}
	});
}

async function loadDatabaseViewer(tableName = "", sort = databaseSort) {
	// Load one table preview for the read-only Database viewer. This avoids the
	// shared runAction() wrapper so table changes feel quiet and immediate.
	if (databaseViewerLoading) {
		return null;
	}

	const selectedTable = tableName || $("#databaseTableSelect")?.value || databaseView?.selectedTable || "";
	setDatabaseViewerLoading(true);
	setText("#databaseViewerMeta", "Loading table data...");
	renderDatabaseViewer(databaseView);

	try {
		const result = await api.readDatabaseTable(selectedTable, sort);
		setDatabaseSort({
			column: result.sortColumn || "",
			direction: result.sortDirection || "",
		});
		setDatabaseView(result);
		renderDatabase(result.database);
		renderDatabaseViewer(result);
		return result;
	} catch (error) {
		const message = error.message || "Database viewer failed.";
		setText("#databaseViewerMeta", message);
		toast(message, "error", { label: "Database viewer" });
		return null;
	} finally {
		setDatabaseViewerLoading(false);
		renderDatabaseViewer(databaseView);
	}
}

function refreshCurrentDatabaseViewer() {
	// The viewer caches the last table payload for fast redraws. After database
	// maintenance actions, reload that payload so stale IDs/rows are not shown as
	// if they still exist.
	if (!state?.database?.exists) {
		databaseView = null;
		renderDatabaseViewer(null);
		return Promise.resolve(null);
	}

	return loadDatabaseViewer(databaseView?.selectedTable || $("#databaseTableSelect")?.value || "", databaseSort);
}

async function refreshCurrentView() {
	if (activeView === "database") {
		await refreshCurrentDatabaseViewer();
		return { message: "Database view refreshed." };
	}

	if (activeView === "logs") {
		await refreshLogs();
		return { message: "Logs refreshed." };
	}

	if (activeView === "setup") {
		await refreshConfig();
		return { message: "Setup refreshed." };
	}

	await refreshState();
	return { message: "Current view refreshed." };
}

function renderState(nextState) {
	// Main redraw function for the app. It takes one backend state object and
	// updates every status card, path label, update list, and setup checklist.
	state = nextState;

	const scan = state.scan;
	const install = installHealth(scan);
	const bot = botHealth(state.pm2);
	const updates = updateHealth(state.updates);
	const database = databaseHealth(state.database);
	const updateButtonText = state.updates?.available ? "Update" : "Check Updates";
	const dashboardUpdateButtonText = state.updates?.available ? "View Updates" : "Check Updates";

	// Sidebar.
	setText("#activeInstallPath", activeTargetPathLabel(state));
	setText("#sidebarInstallPath", shortPath(state.installPath));
	setText("#sidebarRepoRemote", repositoryRemoteLabel(state.repository));
	setText("#sidebarRepoBranch", repositoryBranchLabel(state.repository));
	setText("#sidebarStatusText", install.label);
	setDot("#sidebarStatusDot", install.dot);

	// Dashboard status cards.
	setText("#botStatus", bot.label);
	setText("#botDetail", bot.detail);
	setDot("#botDot", bot.dot);

	setText("#installStatus", install.label);
	setText("#installDetail", install.detail);
	setDot("#installDot", install.dot);

	setText("#updateStatus", updates.label);
	setText("#updateDetail", updates.detail);
	setDot("#updateDot", updates.dot);

	setText("#deployStatus", scan.configurationReady ? "Ready" : "Needs config");
	setText("#deployDetail", scan.configurationReady ? "Global and guild commands" : "Save configuration first");
	setDot("#deployDot", scan.configurationReady ? "good" : "warn");

	setText("#dashboardDatabaseStatus", database.label);
	setText("#dashboardDatabaseDetail", database.detail);
	setDot("#dashboardDatabaseDot", database.dot);

	// Dashboard/panel metadata.
	setText("#runtimeMeta", state.pm2?.message || (state.runtimeTarget === "remote" ? "Remote PM2 process: Hachi" : "PM2 process: Hachi"));
	setText("#updatesMeta", updateMetaLabel(state.updates, state.repository, scan));
	setText("#incomingHeading", `Available from ${updateTargetLabel(state.updates)}`);
	setText("#updateMessage", state.updates?.message || "");
	setText("#dashboardUpdateButton", dashboardUpdateButtonText);
	setText("#updatesButton", updateButtonText);
	setDisabled("#openFolderButton", state.runtimeTarget === "remote");
	setDisabled("#browseInstallButton", state.runtimeTarget === "remote");
	setDisabled("#saveInstallPathButton", state.runtimeTarget === "remote");
	renderIncomingUpdates(state.updates);
	renderLocalChanges(state.updates);
	renderStashedChanges(state.updates);
	renderHachiGenUpdate(state.hachiGenUpdate);
	if (!state.database?.audit?.migrationAvailable && !state.database?.audit?.forceMigrationAvailable) {
		forceMigrationUnlocked = false;
	}
	renderDatabase(state.database);
	renderDatabaseViewer(databaseView);
	renderSanitizeSummary(sanitizeReport);
	renderRemote(state.remote, state.runtimeTarget);

	if (!state.database?.exists) {
		databaseView = null;
		renderDatabaseViewer(null);
	} else if (activeView === "database" && !databaseView && !databaseViewerLoading) {
		loadDatabaseViewer();
	}

	const installInput = $("#installPathInput");

	// Do not overwrite the user's typing while the install path input has focus.
	if (installInput && document.activeElement !== installInput) {
		installInput.value = state.runtimeTarget === "remote" ? state.scan?.installPath || "" : state.installPath || "";
	}

	renderInstallChecks(scan);
}

async function refreshState() {
	// Ask the backend for fresh scan/update/PM2 state, then redraw the UI.
	renderState(await api.getState());
}

async function refreshConfig() {
	// Load .env and config/config.json values into the Setup form.
	renderConfig(await api.readConfig());
}

async function refreshLogs() {
	// Refresh visible log snapshots. updateLogPolling calls this repeatedly
	// while Logs is open so the panel feels close to real time.
	const logs = await api.getLogs();
	const pm2Text = logs.pm2 || logs.local || "No logs found.";
	lastPm2LogText = pm2Text;

	if (pm2LogBaseline !== null) {
		// Clearing PM2 logs only clears the visible window. The baseline lets
		// future refreshes show new lines without deleting real PM2 logs.
		setText("#pm2Logs", pm2Text.startsWith(pm2LogBaseline) ? pm2Text.slice(pm2LogBaseline.length).trimStart() : "");
	} else {
		setText("#pm2Logs", pm2Text);
	}

	if (!hachiGenLogHistoryHidden && logs.events?.length) {
		// Same idea for HachiGen logs: clearing hides old visible history only.
		setText("#eventLogs", logs.events.map(eventLine).join("\n"));
	}
}

function updateLogPolling() {
	// Start polling logs only while the Logs tab is visible, and stop polling
	// when the user leaves it so background work stays light.
	if (activeView === "logs" && !logPollTimer) {
		logPollTimer = setInterval(() => {
			refreshLogs().catch(error => {
				// Polling runs in the background, so log the failure without a
				// repeating popup if the Logs panel cannot refresh.
				recordRendererEvent("error", `Log refresh failed: ${error.message || error}`, {
					label: "Refresh logs",
				});
			});
		}, 5000);
		return;
	}

	if (activeView !== "logs" && logPollTimer) {
		clearInterval(logPollTimer);
		logPollTimer = null;
	}
}

async function checkUpdatesOnStartup() {
	// Check updates after the first render. Doing this in the background lets
	// the window open before Git/network work has finished.
	try {
		await api.checkUpdates();
		await refreshState();
	} catch (error) {
		recordRendererEvent("error", `Startup update check failed: ${error.message || error}`, {
			label: "Startup update check",
		});
	}
}

function clearPm2LogWindow() {
	// Clear only the PM2 text currently visible in HachiGen. The baseline keeps
	// future polling from immediately repopulating the old lines.
	pm2LogBaseline = lastPm2LogText || $("#pm2Logs")?.textContent || "";
	setText("#pm2Logs", "");
	toast("PM2 log window cleared.");
}

function clearHachiGenLogWindow() {
	// Hide the currently visible HachiGen event history. The in-memory event log
	// still exists so future actions can keep appending new events.
	hachiGenLogHistoryHidden = true;
	setText("#eventLogs", "");
	toast("HachiGen log window cleared.");
}

async function runAction(label, action, options = {}) {
	// Shared wrapper for button actions. It prevents double-click races, runs
	// the backend action, refreshes state afterward, and routes errors to both
	// a toast and the HachiGen log.
	if (busy) {
		return;
	}

	setBusy(true);

	try {
		const result = await action();
		// Most actions can affect several panels, so redraw state afterward.
		await refreshState();
		if (options.toast !== false) {
			toast(result?.message || `${label} complete.`);
		}
		return result;
	} catch (error) {
		toast(error.message || `${label} failed.`, "error", { label });
		return null;
	} finally {
		setBusy(false);
		// Buttons may have been disabled while busy; re-apply stash-specific
		// and database-specific enable/disable rules after restoring button state.
		renderStashedChanges(state?.updates);
		renderHachiGenUpdate(state?.hachiGenUpdate);
		renderDatabase(state?.database);
		renderDatabaseViewer(databaseView);
		renderConfig(lastConfig);
		setDisabled("#openFolderButton", state?.runtimeTarget === "remote");
		setDisabled("#browseInstallButton", state?.runtimeTarget === "remote");
		setDisabled("#saveInstallPathButton", state?.runtimeTarget === "remote");
		setDisabled("button[data-action=\"restore-database\"]", state?.database?.source === "remote");
	}
}

function readConfigForm() {
	// Read every configured input from the Setup form and return a plain object
	// that writeConfiguration() can split between .env and config.json.
	const form = $("#configForm");
	const values = {};

	for (const field of configFields) {
		values[field] = form.elements[field]?.value || "";
	}

	return values;
}

function handleNav(event) {
	// Handle sidebar tab clicks. Buttons declare their target with data-view,
	// so HTML controls navigation without hard-coding IDs here.
	const button = event.target.closest("[data-view]");

	if (!button) {
		return;
	}

	showView(button.dataset.view);
}

function handleChange(event) {
	// The Database table dropdown is intentionally read-only; changing it only
	// asks the backend for a new preview of another table.
	const tableSelect = event.target.closest("#databaseTableSelect");

	if (tableSelect) {
		setDatabaseSort({ column: "", direction: "" });
		loadDatabaseViewer(tableSelect.value);
	}

	if (event.target.name === "remotePortMode") {
		updateRemotePortMode();
	}

	if (event.target.name === "runtimeTarget") {
		const nextTarget = event.target.value === "remote" ? "remote" : "local";

		runAction("Set runtime target", () => api.setRuntimeTarget(nextTarget))
			.then(async result => {
				if (!result) {
					renderRemote(state?.remote, state?.runtimeTarget);
					return;
				}

				databaseView = null;
				sanitizeReport = null;
				await refreshConfig();
				if (activeView === "database" && state?.database?.exists) {
					loadDatabaseViewer();
				}
			});
	}
}

function handleMenuAction(payload = {}) {
	const action = payload.action || "";

	if (action === "show-view") {
		showView(payload.view || "dashboard");
		return;
	}

	if (action === "refresh-current-view") {
		runAction("Refresh current view", refreshCurrentView);
		return;
	}

	if (action === "check-version-updates") {
		showView("updates");
		runAction("Check for updates", async () => {
			const hachi = await api.checkVersionUpdates();
			const hachiGen = await api.checkHachiGenUpdates();

			return {
				message: `${hachi.message || "Hachi check complete."} ${hachiGen.message || "HachiGen check complete."}`,
				ok: true,
			};
		});
		return;
	}

	if (action === "open-folder") {
		runAction("Open folder", () => api.openInstallFolder());
	}
}

function handleAction(event) {
	// Route every non-form button click by its data-action value. This keeps
	// index.html declarative: adding a button usually means adding one case here.
	const button = event.target.closest("[data-action]");

	if (!button) {
		return;
	}

	const action = button.dataset.action;

	if (action === "browse") {
		// Open the native folder picker, then redraw because the install path changed.
		runAction("Choose install path", async () => {
			const result = await api.chooseInstallPath();
			renderState(result);
			await refreshConfig();
			return { message: "Install path selected." };
		});
		return;
	}

	if (action === "save-path") {
		// Save whatever the user typed into the install path text field.
		runAction("Save path", async () => api.setInstallPath($("#installPathInput").value));
		return;
	}

	if (action === "copy-secret") {
		const field = button.dataset.secretField || "";

		runAction("Copy saved value", () => api.copyEnvSecret(field), { toast: false })
			.then(result => {
				if (result?.message) {
					toast(result.message);
				}
			});
		return;
	}

	if (action === "browse-ssh-key") {
		// Pick a private key without saving it until the user chooses Save/Test.
		runAction("Choose SSH key", () => api.chooseSshKey(), { toast: false })
			.then(result => {
				if (result?.ok) {
					setInputValue("#remoteSshKeyInput", result.sshKeyPath);
					toast(result.message || "SSH key selected.");
				} else if (result?.message) {
					toast(result.message);
				}
			});
		return;
	}

	if (action === "save-remote-settings") {
		runAction("Save remote settings", () => api.saveRemoteSettings(readRemoteForm()));
		return;
	}

	if (action === "test-remote") {
		setText("#remoteTestOutput", "Testing remote connection...");
		runAction("Test remote connection", async () => {
			await api.saveRemoteSettings(readRemoteForm());
			return api.testRemoteConnection();
		}, { toast: false })
			.then(result => {
				if (!result) {
					setText("#remoteTestOutput", "Remote test failed. Check HachiGen logs for details.");
					return;
				}

				setText("#remoteTestOutput", formatRemoteTestOutput(result));
				toast(result.message, result.ok ? "info" : "error", { label: "Test remote connection" });
			});
		return;
	}

	if (action === "install-validate") {
		// Setup page's main action: install if needed, then validate/repair.
		runAction("Install / Validate", () => api.installOrValidate());
		return;
	}

	if (action === "validate") {
		// Dashboard quick validation. It can repair missing dependencies.
		runAction("Validate install", () => api.validateInstall());
		return;
	}

	if (action === "update") {
		// If an update is available, this button updates. The backend saves
		// local changes to a recoverable stash first when needed.
		runAction("Update", async () => {
			if (state?.updates?.available) {
				return api.applyUpdate();
			}

			return api.checkUpdates();
		});
		return;
	}

	if (action === "check-hachigen-update") {
		runAction("Check HachiGen update", () => api.checkHachiGenUpdates());
		return;
	}

	if (action === "install-hachigen-update") {
		showConfirmModal({
			confirmText: "Install Latest",
			details: [
				"HachiGen will download HachiGen.exe from the latest HachiGen release.",
				"Packaged Windows builds close, replace the running executable, and relaunch.",
				"Development builds open the release download instead of replacing Electron.",
			],
			meta: "HachiGen self-update",
			summary: "Install the latest HachiGen release?",
			title: "Install HachiGen update?",
			variant: "primary",
		}).then(confirmed => {
			if (!confirmed) {
				toast("HachiGen update canceled.");
				return;
			}

			runAction("Install HachiGen update", () => api.installHachiGenUpdate());
		});
		return;
	}

	if (action === "open-hachigen-release") {
		runAction("Open HachiGen releases", () => api.openHachiGenRelease());
		return;
	}

	if (action === "restore-stash") {
		// Apply the active HachiGen stash without deleting it.
		runAction("Restore changes", () => api.restoreStashedChanges());
		return;
	}

	if (action === "delete-stash") {
		// Permanently drop the active HachiGen stash.
		runAction("Delete changes", () => api.deleteStashedChanges());
		return;
	}

	if (action === "show-setup") {
		// Dashboard shortcut to the Setup tab.
		showView("setup");
		return;
	}

	if (action === "show-updates") {
		// Dashboard shortcut to the Updates tab.
		showView("updates");
		return;
	}

	if (action === "show-database") {
		// Dashboard shortcut to the Database tab.
		showView("database");
		return;
	}

	if (action === "sort-database-column") {
		// Clicking a viewer column toggles ascending/descending sort in SQLite.
		const column = button.dataset.column || "";
		const direction = databaseSort.column === column && databaseSort.direction === "asc" ? "desc" : "asc";
		setDatabaseSort({ column, direction });
		loadDatabaseViewer(databaseView?.selectedTable, databaseSort);
		return;
	}

	if (action === "generate-database-key") {
		const protection = state?.database?.protection;
		const keyReady = [`key-ready`, `direct-key`].includes(protection?.status);

		if (!keyReady) {
			runAction("Generate database key", () => api.prepareDatabaseProtection());
			return;
		}

		showConfirmModal({
			checkbox: {
				checked: false,
				description: "Rekey encrypted backups that use the current key and encrypt plaintext backups while HachiGen still has both keys.",
				id: "rotateDatabaseBackupsWithKey",
				label: "Also rotate existing backups",
			},
			confirmText: "Rotate Key",
			details: [
				"HachiGen will create a safety backup before changing the key.",
				"The encrypted database will be rekeyed and verified before the key file is replaced.",
				"Backups that require an even older key will be skipped and reported.",
				"Stop Hachi before rotating the key so the database is not in use.",
			],
			meta: "Database key rotation",
			summary: "Rotate the database encryption key?",
			title: "Rotate database key?",
			variant: "warning",
		}).then(result => {
			if (!result?.confirmed) {
				toast("Database key rotation canceled.");
				return;
			}

			runAction("Rotate database key", () => api.rotateDatabaseKey({ rotateBackups: result.checked }))
				.then(actionResult => {
					if (actionResult?.ok) {
						refreshCurrentDatabaseViewer();
					}
				});
		});
		return;
	}

	if (action === "rotate-database-backups") {
		showConfirmModal({
			confirmText: "Rotate Backups",
			details: [
				"Plaintext backups will be encrypted with the current database key.",
				"Encrypted backups that already use the current key will be verified and tagged.",
				"Backups that need an older key will be skipped; keep old key backups if you still need those restore points.",
			],
			meta: "Database backup key maintenance",
			summary: "Rotate backup encryption to the current database key where possible?",
			title: "Rotate database backups?",
			variant: "warning",
		}).then(confirmed => {
			if (!confirmed) {
				toast("Database backup rotation canceled.");
				return;
			}

			runAction("Rotate database backups", () => api.rotateDatabaseBackups());
		});
		return;
	}

	if (action === "verify-database-protection") {
		runAction("Verify database protection", () => api.verifyDatabaseProtection());
		return;
	}

	if (action === "export-database-key-backup") {
		showConfirmModal({
			confirmText: "Export Key",
			details: [
				"This writes a copy of the database key to a file you choose.",
				"Anyone with this key and the encrypted database can decrypt it.",
				"Store the backup in a password manager, offline drive, or another protected location.",
			],
			meta: "Database key recovery",
			summary: "Export a recovery copy of the database key?",
			title: "Export database key backup?",
			variant: "warning",
		}).then(confirmed => {
			if (!confirmed) {
				toast("Database key backup export canceled.");
				return;
			}

			runAction("Export database key backup", () => api.exportDatabaseKeyBackup());
		});
		return;
	}

	if (action === "backup-database") {
		// Make a dated copy of database/database.sqlite in manager/backups.
		// If today's backup already exists, ask with the themed confirmation modal.
		runAction("Backup database", () => api.backupDatabase(), { toast: false })
			.then(async result => {
				if (!result) {
					return;
				}

				if (result.needsOverwrite) {
					const confirmed = await showConfirmModal({
						confirmText: "Overwrite",
						details: ["The existing backup file will be replaced.", "Manual restore backups are not affected."],
						meta: "Database backup already exists",
						summary: `${result.fileName} already exists. Overwrite today's database backup?`,
						title: "Overwrite database backup?",
						variant: "warning",
					});

					if (!confirmed) {
						toast("Database backup canceled.");
						return;
					}

					await runAction("Overwrite database backup", () => api.backupDatabase({ overwrite: true }));
					return;
				}

				toast(result.message || "Database backup created.");
			});
		return;
	}

	if (action === "restore-database") {
		// Let the native picker choose a backup, then use a themed confirmation
		// before the backend replaces the current database file.
		runAction("Choose database backup", () => api.chooseDatabaseBackup(), { toast: false })
			.then(async selection => {
				if (!selection?.ok) {
					if (selection?.message) {
						toast(selection.message);
					}
					return;
				}

				const confirmed = await showConfirmModal({
					confirmText: "Restore",
					details: [
						`Selected backup: ${selection.fileName}`,
						"HachiGen will create a pre-restore safety backup first.",
						"Stop Hachi before restoring if it is currently running.",
					],
					meta: "Database restore confirmation",
					summary: "The current database will be overwritten with the selected backup.",
					title: "Restore this database backup?",
					variant: "warning",
				});

				if (!confirmed) {
					toast("Database restore canceled.");
					return;
				}

				const result = await runAction("Restore database", () => api.restoreDatabase(selection.backupPath));

				if (result?.ok) {
					databaseView = null;
					refreshCurrentDatabaseViewer();
				}
			});
		return;
	}

	if (action === "refresh-database-viewer") {
		// Reload the selected table without changing any database rows.
		loadDatabaseViewer(databaseView?.selectedTable, databaseSort);
		return;
	}

	if (action === "migrate-database") {
		// Safe migration confirms through the shared HachiGen prompt.
		confirmDatabaseMigration(false);
		return;
	}

	if (action === "force-migrate-database") {
		// Force migration confirms through the same prompt with danger styling.
		confirmDatabaseMigration(true);
		return;
	}

	if (action === "confirm-cancel") {
		closeConfirmModal(false);
		return;
	}

	if (action === "confirm-accept") {
		closeConfirmModal(true);
		return;
	}

	if (action === "sanitize-database") {
		// Review the database first. The modal explains what can be cleaned
		// before anything is changed on disk.
		// The review result is saved so the Database tab can keep showing it.
		runAction("Sanitize database", () => api.reviewDatabaseSanitation())
			.then(result => {
				if (result?.ok) {
					renderSanitizeModal(result);
					refreshCurrentDatabaseViewer();
				}
			});
		return;
	}

	if (action === "sanitize-close") {
		hideSanitizeModal();
		return;
	}

	if (action === "apply-sanitize") {
		// Collect only the checked items from the modal. Unchecked findings stay
		// untouched, even if they are technically cleanable.
		const actionIds = selectedSanitizeActionIds();

		if (!actionIds.length) {
			toast("No cleanable database findings selected.", "error", { label: "Database sanitation" });
			return;
		}

		showConfirmModal({
			confirmText: "Clean Selected",
			details: [
				`${pluralize(actionIds.length, "database issue group")} selected.`,
				"HachiGen will create a backup before changing the database.",
			],
			meta: "Database sanitation confirmation",
			summary: "Clean the selected database issue groups?",
			title: "Confirm database sanitation",
			variant: "warning",
		}).then(confirmed => {
			if (!confirmed) {
				// The shared modal temporarily swaps the review for this final
				// confirmation, so restore the review when the user backs out.
				renderSanitizeModal(sanitizeReport, actionIds);
				toast("Database sanitation canceled.");
				return;
			}

			// Cleanup creates a pre-sanitize backup before running selected fixes.
			runAction("Clean database", () => api.applyDatabaseSanitation(actionIds))
				.then(result => {
					if (result?.ok) {
						hideSanitizeModal();
						sanitizeReport = result;
						renderSanitizeSummary(result);
						refreshCurrentDatabaseViewer();
					}
				});
		});
		return;
	}

	if (action === "deploy") {
		runAction("Deploy commands", () => api.deployCommands());
		return;
	}

	if (action === "start") {
		runAction("Start Hachi", () => api.startBot());
		return;
	}

	if (action === "stop") {
		runAction("Stop Hachi", () => api.stopBot());
		return;
	}

	if (action === "restart") {
		runAction("Restart Hachi", () => api.restartBot());
		return;
	}

	if (action === "refresh") {
		// Manual state refresh without changing anything.
		runAction("Refresh", () => refreshState().then(() => ({ message: "State refreshed." })));
		return;
	}

	if (action === "refresh-logs") {
		// Kept for compatibility if a refresh-logs button is reintroduced later.
		runAction("Refresh logs", () => refreshLogs().then(() => ({ message: "Logs refreshed." })));
		return;
	}

	if (action === "clear-pm2-logs") {
		clearPm2LogWindow();
		return;
	}

	if (action === "clear-hachigen-logs") {
		clearHachiGenLogWindow();
		return;
	}

	if (action === "open-folder") {
		// Opens the selected install folder in File Explorer.
		runAction("Open folder", () => api.openInstallFolder());
	}
}

function handleConfigSubmit(event) {
	// Save Config is a real form submit, so prevent page reload and send the
	// collected field values to the backend writer.
	event.preventDefault();
	runAction("Save configuration", async () => {
		const config = await api.saveConfig(readConfigForm());
		renderConfig(config);
		return { message: "Configuration saved." };
	});
}

async function init() {
	// Wire up event listeners, perform the first data load, and then begin the
	// background startup update check.
	document.addEventListener("click", handleNav);
	document.addEventListener("click", handleAction);
	document.addEventListener("change", handleChange);
	$("#configForm").addEventListener("submit", handleConfigSubmit);

	api.onEvent(event => {
		// Live backend events arrive here while commands are running.
		appendEvent(event);
	});

	api.onMenuAction(handleMenuAction);

	// First render: show static view state, then fetch dynamic backend data.
	renderViews();
	await refreshState();
	await refreshConfig();
	await refreshLogs();
	checkUpdatesOnStartup();
}

init();
