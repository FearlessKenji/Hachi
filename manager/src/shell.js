// Child-process wrapper for HachiGen backend operations.
//
// HachiGen runs Git, npm, node scripts, PM2, ssh, and platform tools. Keeping
// process execution here gives manager.js one consistent timeout, logging, and
// Windows command-shim behavior.
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_COMMANDS = new Set([
	"git",
	"node",
	"npm",
	"npx",
	"pm2",
	"ssh",
	"where",
	"which",
	"winget",
]);
const WINDOWS_COMMAND_PROCESSOR = "C:\\Windows\\System32\\cmd.exe";
const WINDOWS_COMMAND_RESOLVER = "C:\\Windows\\System32\\where.exe";
const POSIX_COMMAND_RESOLVERS = ["/usr/bin/which", "/bin/which"];
const WINDOWS_COMMAND_SHIMS = new Set(["npm", "npx", "pm2"]);
const commandPathCache = new Map();

// ShellError wraps command failures with the command result attached. Callers
// can show a friendly error while still keeping stdout/stderr for the Logs tab.
class ShellError extends Error {
	constructor(message, result) {
		super(message);
		this.name = "ShellError";
		this.result = result;
		this.code = result?.code;
		this.stdout = result?.stdout || "";
		this.stderr = result?.stderr || "";
	}
}

// Build a readable command line for logs, such as:
// > npm install
// This is display-only; command execution still passes args separately.
function displayCommand(command, args) {
	const renderedArgs = args.map(arg => {
		const text = String(arg);
		return /\s/.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
	});

	return [command, ...renderedArgs].join(" ");
}

// Decide whether a command should be launched through cmd.exe on Windows.
// npm/npx/pm2 are usually .cmd shims, and Node's spawn can fail if it treats
// them like normal executable files.
function needsWindowsCommandShell(command) {
	return process.platform === "win32" && ["npm", "npx", "pm2"].includes(command);
}

function shellError(message, command, args = [], cwd = null) {
	return new ShellError(message, {
		args,
		code: 1,
		command,
		cwd,
		stderr: message,
		stdout: "",
	});
}

function validateCommand(command, args = [], cwd = null) {
	if (!ALLOWED_COMMANDS.has(command)) {
		throw shellError(`Unsupported command: ${command}.`, command, args, cwd);
	}
}

// Quote one argument for the cmd.exe path used by Windows shims. The caret
// escapes characters that cmd.exe would otherwise interpret as syntax.
function quoteForCmd(value) {
	const text = String(value);

	if (!text) {
		return "\"\"";
	}

	if (!/[\s"&<>|^]/.test(text)) {
		return text;
	}

	return `"${text.replace(/(["^&<>|])/g, "^$1")}"`;
}

function getWindowsLookupNames(command) {
	if (WINDOWS_COMMAND_SHIMS.has(command)) {
		return [`${command}.cmd`, command];
	}

	return [command];
}

function getPosixCommandResolver() {
	return POSIX_COMMAND_RESOLVERS.find(resolver => fs.existsSync(resolver)) || null;
}

function parseCommandResolverOutput(output) {
	return String(output || "")
		.split(/\r?\n/u)
		.map(line => line.trim())
		.filter(Boolean);
}

function firstExistingAbsolutePath(paths) {
	return paths.find(candidate => path.isAbsolute(candidate) && fs.existsSync(candidate)) || null;
}

function resolveWindowsCommandPath(command) {
	if (command === "where") {
		return WINDOWS_COMMAND_RESOLVER;
	}

	const resolver = fs.existsSync(WINDOWS_COMMAND_RESOLVER) ? WINDOWS_COMMAND_RESOLVER : "where.exe";

	for (const lookupName of getWindowsLookupNames(command)) {
		const result = spawnSync(resolver, [lookupName], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		const commandPath = firstExistingAbsolutePath(parseCommandResolverOutput(result.stdout));

		if (commandPath) {
			return commandPath;
		}
	}

	return null;
}

function resolvePosixCommandPath(command) {
	const resolver = getPosixCommandResolver();

	if (!resolver) {
		return null;
	}

	if (command === "which") {
		return resolver;
	}

	const result = spawnSync(resolver, [command], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});

	return firstExistingAbsolutePath(parseCommandResolverOutput(result.stdout));
}

function resolveCommandPath(command, args = [], cwd = null) {
	validateCommand(command, args, cwd);

	if (commandPathCache.has(command)) {
		return commandPathCache.get(command);
	}

	const commandPath = process.platform === "win32" ?
		resolveWindowsCommandPath(command) :
		resolvePosixCommandPath(command);

	if (!commandPath) {
		throw shellError(`Command not found: ${command}.`, command, args, cwd);
	}

	commandPathCache.set(command, commandPath);
	return commandPath;
}

function buildSpawnOptions({ cwd, env }) {
	const options = {
		cwd,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	};

	if (env) {
		options.env = Object.fromEntries(
			Object.entries(env).map(([key, value]) => [key, String(value)]),
		);
	}

	return options;
}

// Decide the real process and arguments passed to spawn().
// Most commands run directly; Windows npm/npx/pm2 commands are translated to:
// cmd.exe /d /s /c npm.cmd ...
function spawnTarget(command, args, cwd = null) {
	const commandPath = resolveCommandPath(command, args, cwd);

	if (!needsWindowsCommandShell(command)) {
		return {
			command: commandPath,
			args,
		};
	}

	const commandLine = [commandPath, ...args].map(quoteForCmd).join(" ");

	return {
		command: WINDOWS_COMMAND_PROCESSOR,
		args: ["/d", "/s", "/c", commandLine],
	};
}

// Forward command output into the HachiGen activity stream line by line. This
// keeps long installs readable and lets the UI update while the process runs.
function emitOutput(onLog, stream, chunk, context = {}) {
	if (!onLog) {
		return;
	}

	const lines = String(chunk).replace(/\r/g, "").split("\n");

	for (const line of lines) {
		if (line.trim()) {
			onLog({ ...context, stream, message: line });
		}
	}
}

// Run one external command and return stdout/stderr/exit code. This is the only
// helper manager.js uses for Git, npm, node, winget, and PM2, so timeout and log
// behavior stay consistent across every system operation.
function run(command, args = [], options = {}) {
	const {
		cwd,
		env,
		timeoutMs = 120000,
		allowFailure = false,
		onLog,
	} = options;

	const logContext = {
		args,
		command,
		displayCommand: displayCommand(command, args),
	};

	validateCommand(command, args, cwd);

	if (onLog) {
		onLog({ ...logContext, stream: "command", message: `> ${logContext.displayCommand}` });
	}

	return new Promise((resolve, reject) => {
		// stdout/stderr are collected for result objects and also streamed live
		// through emitOutput() when a caller provides onLog.
		let stdout = "";
		let stderr = "";
		let settled = false;

		const target = spawnTarget(command, args, cwd);
		const child = spawn(target.command, target.args, buildSpawnOptions({ cwd, env }));

		// Long-running installs can hang if another process is waiting for input.
		// The timeout turns that into a visible error instead of a frozen app.
		const timeout = setTimeout(() => {
			child.kill();
			const result = { command, args, cwd, code: 124, stdout, stderr };
			const error = new ShellError(`${command} timed out.`, result);
			settled = true;
			reject(error);
		}, timeoutMs);

		child.stdout.on("data", chunk => {
			stdout += chunk;
			emitOutput(onLog, "stdout", chunk, logContext);
		});

		child.stderr.on("data", chunk => {
			stderr += chunk;
			emitOutput(onLog, "stderr", chunk, logContext);
		});

		child.on("error", error => {
			// "error" means the process could not start at all.
			// Example: the executable is missing or Windows refused to launch it.
			if (settled) {
				return;
			}

			clearTimeout(timeout);
			settled = true;
			const result = { command, args, cwd, code: 1, stdout, stderr: stderr || error.message };
			reject(new ShellError(error.message, result));
		});

		child.on("close", code => {
			// "close" means the process started and has now exited.
			if (settled) {
				return;
			}

			clearTimeout(timeout);
			settled = true;
			const result = { command, args, cwd, code, stdout, stderr };

			if (code === 0 || allowFailure) {
				resolve(result);
				return;
			}

			reject(new ShellError(`${command} exited with code ${code}.`, result));
		});
	});
}

// Check whether a command exists on PATH without throwing. HachiGen uses this
// before deciding whether it can run a tool or should offer/install a repair.
async function commandExists(command) {
	try {
		resolveCommandPath(command);
		return true;
	} catch {
		return false;
	}
}

module.exports = {
	ShellError,
	commandExists,
	run,
};
