// Child-process wrapper for HachiGen backend operations.
//
// HachiGen runs Git, npm, node scripts, PM2, ssh, and platform tools. Keeping
// process execution here gives manager.js one consistent timeout, logging, and
// Windows command-shim behavior.
const { spawn } = require("node:child_process");

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

// Decide the real process and arguments passed to spawn().
// Most commands run directly; Windows npm/npx/pm2 commands are translated to:
// cmd.exe /d /s /c npm.cmd ...
function spawnTarget(command, args) {
	if (!needsWindowsCommandShell(command)) {
		return {
			command,
			args,
		};
	}

	const commandLine = [`${command}.cmd`, ...args].map(quoteForCmd).join(" ");

	return {
		command: "cmd.exe",
		args: ["/d", "/s", "/c", commandLine],
	};
}

// Forward command output into the HachiGen activity stream line by line. This
// keeps long installs readable and lets the UI update while the process runs.
function emitOutput(onLog, stream, chunk) {
	if (!onLog) {
		return;
	}

	const lines = String(chunk).replace(/\r/g, "").split("\n");

	for (const line of lines) {
		if (line.trim()) {
			onLog({ stream, message: line });
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

	if (onLog) {
		onLog({ stream: "command", message: `> ${displayCommand(command, args)}` });
	}

	return new Promise((resolve, reject) => {
		// stdout/stderr are collected for result objects and also streamed live
		// through emitOutput() when a caller provides onLog.
		let stdout = "";
		let stderr = "";
		let settled = false;

		const target = spawnTarget(command, args);
		const child = spawn(target.command, target.args, {
			cwd,
			env: { ...process.env, ...env },
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

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
			emitOutput(onLog, "stdout", chunk);
		});

		child.stderr.on("data", chunk => {
			stderr += chunk;
			emitOutput(onLog, "stderr", chunk);
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
	const checker = process.platform === "win32" ? "where" : "which";
	const result = await run(checker, [command], {
		allowFailure: true,
		timeoutMs: 10000,
	});

	return result.code === 0;
}

module.exports = {
	ShellError,
	commandExists,
	run,
};
