// Command discovery, loading, and deployment helpers.
//
// Runtime uses getCommandFiles/loadCommand to build client.commands. Deployment
// scripts use getCommandData/redeployCommands to serialize slash command metadata
// and send it to Discord's REST API.
const { ApplicationIntegrationType, REST, Routes } = require(`discord.js`);
const fs = require(`node:fs`);
const path = require(`node:path`);

const commandsRoot = path.join(__dirname, `../commands`);
const USER_INSTALL_COMMANDS = new Set([
	`roll`,
	`timestamp`,
]);
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

function getAllowedIntegrationTypes(commandName, scope) {
	if (scope !== `global`) {
		return null;
	}

	if (USER_INSTALL_COMMANDS.has(commandName)) {
		return [
			ApplicationIntegrationType.GuildInstall,
			ApplicationIntegrationType.UserInstall,
		];
	}

	return [ApplicationIntegrationType.GuildInstall];
}

function normalizeCommandDataForDeploy(commandData, scope) {
	const integrationTypes = getAllowedIntegrationTypes(commandData.name, scope);

	if (!integrationTypes) {
		return commandData;
	}

	return {
		...commandData,
		integration_types: integrationTypes,
	};
}

function getCommandData(scope) {
	return getCommandFiles(scope).map(filePath =>
		normalizeCommandDataForDeploy(loadCommand(filePath, { fresh: true }).data.toJSON(), scope),
	);
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

	const commandData = (commands || getCommandData(scope))
		.map(command => normalizeCommandDataForDeploy(command, scope));
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

	const normalizedCommandData = normalizeCommandDataForDeploy(commandData, scope);
	const rest = new REST().setToken(token);
	const route = scope === `global` ?
		Routes.applicationCommands(clientId) :
		Routes.applicationGuildCommands(clientId, guildId);
	const data = await rest.post(route, { body: normalizedCommandData });

	return {
		command: normalizedCommandData,
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
