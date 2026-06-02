const { dateToString } = require(`./dateToString.js`);
const path = require(`node:path`);
const fs = require(`node:fs`);

const logsFolder = path.join(__dirname, `../logs`);
const logFile = path.join(logsFolder, `console.log`);

function initLog() {
	const header = `=== KenjiB0t Console Log ===`;
	const separator = `============================`;
	const timestamp = dateToString(Date.now());
	return `${header}\n${separator}\n[${timestamp}] Log file created.\n${separator}\n`;
}

function writeLog(message, err) {
	try {
		if (!fs.existsSync(logsFolder)) {
			fs.mkdirSync(logsFolder, { recursive: true });
		}
		if (!fs.existsSync(logFile)) {
			fs.writeFileSync(logFile, initLog());
		}

		const timestamp = dateToString(Date.now());
		const errorText = err ? (err.stack || err.message || err) : ``;
		const logData = `[${timestamp}] ${message}${errorText ? `\n${errorText}` : ``}\n`;

		fs.appendFileSync(logFile, logData);
		return logData.trim();
	} catch (fsErr) {
		console.error(`[writeLog] Failed to write log: ${fsErr.stack || fsErr}`);
		return `[writeLog] Failed to write log: ${fsErr.stack || fsErr}`;
	}
}

module.exports = { writeLog };
