const { REST, Routes } = require(`discord.js`);
const fs = require(`node:fs`);
const path = require(`node:path`);

const commandsRoot = path.join(__dirname, `../commands`);
const scopeDirectoryByName = {
	global: `globalCommands`,
	guild: `guildCommands`,
};
const scopeNameByDirectory = {
	globalCommands: `global`,
	guildCommands: `guild`,
};

function getScopeDirectory(scope) {
	const scopeDirectory = scopeDirectoryByName[scope];

	if (!scopeDirectory) {
		throw new Error(`Unknown command scope: ${scope}`);
	}

	return scopeDirectory;
}

function getCommandScope(filePath) {
	const [scopeDirectory] = path.relative(commandsRoot, filePath).split(path.sep);

	return scopeNameByDirectory[scopeDirectory] || null;
}

function getCommandFiles(scope = null) {
	const scopeDirectories = scope ?
		[getScopeDirectory(scope)] :
		Object.keys(scopeNameByDirectory);
	const files = [];

	for (const scopeDirectory of scopeDirectories) {
		const scopePath = path.join(commandsRoot, scopeDirectory);

		if (!fs.existsSync(scopePath)) {
			continue;
		}

		for (const folder of fs.readdirSync(scopePath)) {
			const folderPath = path.join(scopePath, folder);

			if (!fs.statSync(folderPath).isDirectory()) {
				continue;
			}

			for (const file of fs.readdirSync(folderPath).filter(f => f.endsWith(`.js`))) {
				files.push(path.join(folderPath, file));
			}
		}
	}

	return files;
}

function attachCommandMetadata(command, filePath) {
	command.filePath = filePath;
	command.commandScope = getCommandScope(filePath);

	return command;
}

function loadCommand(filePath, { fresh = false } = {}) {
	const resolvedPath = require.resolve(filePath);

	if (fresh) {
		delete require.cache[resolvedPath];
	}

	const command = require(resolvedPath);

	if (!command.data || !command.execute) {
		throw new Error(`${filePath} is missing data or execute.`);
	}

	return attachCommandMetadata(command, resolvedPath);
}

function findCommandFile(commandName) {
	const normalizedName = commandName.toLowerCase();

	for (const filePath of getCommandFiles()) {
		const command = loadCommand(filePath);

		if (command.data.name.toLowerCase() === normalizedName) {
			return filePath;
		}
	}

	return null;
}

function getCommandData(scope) {
	return getCommandFiles(scope).map(filePath => loadCommand(filePath, { fresh: true }).data.toJSON());
}

async function redeployCommands(scope, { clientId, commands = null, guildId, token }) {
	if (!token) {
		throw new Error(`TOKEN is required to redeploy commands.`);
	}

	if (!clientId) {
		throw new Error(`clientId is required to redeploy commands.`);
	}

	if (scope === `guild` && !guildId) {
		throw new Error(`guildId is required to redeploy guild commands.`);
	}

	const commandData = commands || getCommandData(scope);
	const rest = new REST().setToken(token);
	const route = scope === `global` ?
		Routes.applicationCommands(clientId) :
		Routes.applicationGuildCommands(clientId, guildId);

	const data = await rest.put(route, { body: commandData });

	return {
		commands: commandData,
		data,
		scope,
	};
}

async function redeployCommand(scope, commandData, { clientId, guildId, token }) {
	if (!token) {
		throw new Error(`TOKEN is required to redeploy commands.`);
	}

	if (!clientId) {
		throw new Error(`clientId is required to redeploy commands.`);
	}

	if (scope === `guild` && !guildId) {
		throw new Error(`guildId is required to redeploy guild commands.`);
	}

	const rest = new REST().setToken(token);
	const route = scope === `global` ?
		Routes.applicationCommands(clientId) :
		Routes.applicationGuildCommands(clientId, guildId);
	const data = await rest.post(route, { body: commandData });

	return {
		command: commandData,
		data,
		scope,
	};
}

module.exports = {
	findCommandFile,
	getCommandFiles,
	getCommandScope,
	getCommandData,
	loadCommand,
	redeployCommand,
	redeployCommands,
};
