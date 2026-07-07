#!/usr/bin/env node

const childProcess = require(`node:child_process`);
const fs = require(`node:fs`);
const path = require(`node:path`);

const projectRoot = path.resolve(__dirname, `..`);
process.chdir(projectRoot);

const results = {
	failed: 0,
	passed: 0,
	warned: 0,
};

let loadedCommands = null;

function relative(filePath) {
	return path.relative(projectRoot, filePath).replace(/\\/gu, `/`);
}

function resolveProject(...parts) {
	return path.join(projectRoot, ...parts);
}

function readJson(...parts) {
	const filePath = resolveProject(...parts);
	return JSON.parse(fs.readFileSync(filePath, `utf8`));
}

function requireFresh(...parts) {
	const filePath = resolveProject(...parts);
	const resolvedPath = require.resolve(filePath);
	delete require.cache[resolvedPath];
	return require(resolvedPath);
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function warn(message) {
	results.warned += 1;
	console.log(`[warn] ${message}`);
}

function parseVersion(version) {
	const match = String(version).match(/(\d+)\.(\d+)\.(\d+)/u);

	if (!match) {
		return null;
	}

	return match.slice(1).map(Number);
}

function versionAtLeast(actual, minimum) {
	const actualParts = parseVersion(actual);
	const minimumParts = parseVersion(minimum);

	if (!actualParts || !minimumParts) {
		return false;
	}

	for (let index = 0; index < 3; index += 1) {
		if (actualParts[index] > minimumParts[index]) {
			return true;
		}

		if (actualParts[index] < minimumParts[index]) {
			return false;
		}
	}

	return true;
}

function listFiles(directory, predicate = () => true) {
	if (!fs.existsSync(directory)) {
		return [];
	}

	const files = [];

	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const fullPath = path.join(directory, entry.name);

		if (entry.isDirectory()) {
			files.push(...listFiles(fullPath, predicate));
		} else if (predicate(fullPath)) {
			files.push(fullPath);
		}
	}

	return files;
}

function spawnNode(args, options = {}) {
	return childProcess.spawnSync(process.execPath, args, {
		cwd: projectRoot,
		encoding: `utf8`,
		...options,
		env: {
			...process.env,
			...(options.env || {}),
		},
	});
}

function runGit(args) {
	return childProcess.spawnSync(`git`, args, {
		cwd: projectRoot,
		encoding: `utf8`,
	});
}

async function test(name, fn) {
	try {
		await fn();
		results.passed += 1;
		console.log(`[pass] ${name}`);
	} catch (error) {
		results.failed += 1;
		console.error(`[fail] ${name}`);
		console.error(`       ${error.message}`);
	}
}

function packageNodeModulesPath(packageName) {
	return `node_modules/${packageName}`;
}

function assertLockPackage(lock, packageName) {
	const packagePath = packageNodeModulesPath(packageName);
	assert(lock.packages?.[packagePath], `package-lock.json is missing ${packagePath}.`);
}

function allLockedVersions(lock, packageName) {
	const suffix = `/node_modules/${packageName}`;
	const topLevel = packageNodeModulesPath(packageName);

	return Object.entries(lock.packages || {})
		.filter(([packagePath]) => packagePath === topLevel || packagePath.endsWith(suffix))
		.map(([packagePath, details]) => ({
			path: packagePath,
			version: details.version,
		}));
}

function validateCommandJson(command, json) {
	assert(json.name, `${relative(command.filePath)} command JSON is missing name.`);
	assert(json.name.length <= 32, `${json.name} command name is longer than 32 characters.`);

	if (!json.type || json.type === 1) {
		assert(/^[\p{Ll}\p{N}_-]{1,32}$/u.test(json.name), `${json.name} is not a valid lowercase slash command name.`);
		assert(json.description, `${json.name} slash command is missing a description.`);
		assert(json.description.length <= 100, `${json.name} description is longer than 100 characters.`);
	}

	if (json.options) {
		assert(Array.isArray(json.options), `${json.name} options should be an array.`);
		assert(json.options.length <= 25, `${json.name} has more than 25 top-level options.`);
	}

	if (command.help?.entries) {
		for (const entry of command.help.entries) {
			assert(entry.command, `${json.name} has a help entry without command text.`);
			assert(entry.description, `${json.name} has a help entry without description.`);
		}
	}
}

function collectCommands() {
	const {
		getCommandData,
		getCommandFiles,
		loadCommand,
	} = requireFresh(`utils`, `commandLoader.js`);
	const commandFiles = getCommandFiles();

	assert(commandFiles.length > 0, `No command files were found.`);

	const commands = [];
	const namesByScope = new Map();

	for (const filePath of commandFiles) {
		const command = loadCommand(filePath, { fresh: true });
		const json = command.data.toJSON();
		const scopeKey = `${command.commandScope}:${json.name.toLowerCase()}`;

		assert(command.commandScope === `global` || command.commandScope === `guild`, `${relative(filePath)} has unknown command scope.`);
		assert(typeof command.execute === `function`, `${relative(filePath)} is missing execute().`);
		assert(!namesByScope.has(scopeKey), `Duplicate ${command.commandScope} command name: ${json.name}.`);

		validateCommandJson(command, json);
		namesByScope.set(scopeKey, filePath);
		commands.push({ command, filePath, json });
	}

	const globalData = getCommandData(`global`);
	const guildData = getCommandData(`guild`);
	const globalCount = commands.filter(({ command }) => command.commandScope === `global`).length;
	const guildCount = commands.filter(({ command }) => command.commandScope === `guild`).length;

	assert(globalData.length === globalCount, `Global command data count does not match loaded global command count.`);
	assert(guildData.length === guildCount, `Guild command data count does not match loaded guild command count.`);

	for (const data of globalData) {
		assert(Array.isArray(data.integration_types), `${data.name} global command is missing integration_types.`);
	}

	loadedCommands = commands;
}

function assertComponentHandlersAreRoutable() {
	assert(loadedCommands, `Commands must be loaded before component handler checks run.`);

	for (const { command, filePath, json } of loadedCommands) {
		if (typeof command.handleComponent !== `function`) {
			continue;
		}

		const source = fs.readFileSync(filePath, `utf8`);
		const prefixPatterns = [
			`\`${json.name}:`,
			`'${json.name}:`,
			`"${json.name}:`,
		];

		assert(
			prefixPatterns.some(pattern => source.includes(pattern)),
			`${relative(filePath)} has handleComponent() but no obvious ${json.name}: customId prefix.`,
		);
	}
}

function assertHelpCatalogBuilds() {
	assert(loadedCommands, `Commands must be loaded before help catalog checks run.`);

	const { buildHelpCatalog, filterCatalogForMember } = requireFresh(`utils`, `helpCatalog.js`);
	const { PermissionsBitField } = require(`discord.js`);
	const commandMap = new Map();

	for (const { command, json } of loadedCommands) {
		commandMap.set(json.name, command);
	}

	const catalog = buildHelpCatalog(commandMap, { guildId: readJson(`config`, `config.json`).guildId });

	assert(catalog.length > 0, `Help catalog was empty.`);
	assert(catalog.some(category => category.id === `streams`), `Help catalog is missing streams category.`);
	assert(catalog.some(category => category.id === `raid`), `Help catalog is missing raid category.`);

	const filtered = filterCatalogForMember(catalog, new PermissionsBitField(PermissionsBitField.Flags.Administrator));
	assert(filtered.length === catalog.length, `Administrator help catalog should include all categories.`);
}

function validateEventFiles() {
	const eventFiles = listFiles(resolveProject(`events`), filePath => filePath.endsWith(`.js`));

	assert(eventFiles.length > 0, `No event files were found.`);

	const eventNames = new Set();

	for (const filePath of eventFiles) {
		const event = requireFresh(relative(filePath));

		assert(event.name, `${relative(filePath)} is missing event name.`);
		assert(typeof event.execute === `function`, `${relative(filePath)} is missing execute().`);
		assert(!eventNames.has(event.name), `Duplicate event handler name: ${event.name}.`);
		eventNames.add(event.name);
	}
}

function validateDatabaseModels() {
	const dbObjects = requireFresh(`database`, `dbObjects.js`);
	const { EXPECTED_SCHEMA } = requireFresh(`database`, `dbAudit.js`);
	const exportedModels = Object.entries(dbObjects)
		.filter(([, value]) => value?.rawAttributes);
	const modelByTable = new Map(exportedModels.map(([, model]) => [model.tableName, model]));

	assert(dbObjects.sequelize, `dbObjects.js does not export sequelize.`);
	assert(exportedModels.length > 0, `dbObjects.js did not export any Sequelize models.`);

	for (const tableSpec of EXPECTED_SCHEMA) {
		const model = modelByTable.get(tableSpec.name);

		assert(model, `No Sequelize model is registered for expected table ${tableSpec.name}.`);

		for (const columnSpec of tableSpec.columns) {
			assert(model.rawAttributes[columnSpec.name], `${tableSpec.name} model is missing ${columnSpec.name}.`);
		}

		assert(model.primaryKeyAttributes.length > 0, `${tableSpec.name} model does not declare a primary key.`);
	}

	assert(Object.keys(dbObjects.Servers.associations).length > 0, `Servers model has no associations.`);
	assert(Object.keys(dbObjects.RaidIncidents.associations).length > 0, `RaidIncidents model has no associations.`);
	assert(Object.keys(dbObjects.TwitchRoleConfigs.associations).length > 0, `TwitchRoleConfigs model has no associations.`);

	return dbObjects;
}

async function auditLocalDatabaseIfPresent() {
	const dbPath = resolveProject(`database`, `database.sqlite`);

	if (!fs.existsSync(dbPath)) {
		warn(`database/database.sqlite not found; skipped local database audit.`);
		return;
	}

	const { auditDatabase } = requireFresh(`database`, `dbAudit.js`);
	const result = await auditDatabase({ dbPath });
	const acceptedStatuses = new Set([`ok`, `compatible-drift`]);

	assert(acceptedStatuses.has(result.status), `Database audit status is ${result.status}: ${result.detail}`);
}

function validatePackageMetadata() {
	const pkg = readJson(`package.json`);
	const lock = readJson(`package-lock.json`);
	const rootPackage = lock.packages?.[``];

	assert(pkg.name === `Hachi`, `package.json name should be Hachi.`);
	assert(pkg.version === lock.version, `package.json and package-lock.json versions do not match.`);
	assert(rootPackage?.version === pkg.version, `package-lock root package version does not match package.json.`);
	assert(pkg.type === `commonjs`, `package type should be commonjs.`);
	assert(fs.existsSync(resolveProject(pkg.main)), `package main file does not exist: ${pkg.main}.`);
	assert(pkg.scripts?.smoke === `node scripts/smokeTest.js`, `package.json is missing the smoke script.`);
	assert(versionAtLeast(process.version, pkg.engines.node), `Node ${process.version} does not satisfy ${pkg.engines.node}.`);

	for (const packageName of Object.keys(pkg.dependencies || {})) {
		assertLockPackage(lock, packageName);
	}

	for (const packageName of Object.keys(pkg.devDependencies || {})) {
		assertLockPackage(lock, packageName);
	}

	for (const { path: packagePath, version } of allLockedVersions(lock, `undici`)) {
		assert(versionAtLeast(version, `6.27.0`), `${packagePath} is locked to vulnerable undici ${version}.`);
	}

	for (const { path: packagePath, version } of allLockedVersions(lock, `js-yaml`)) {
		assert(versionAtLeast(version, `4.2.0`), `${packagePath} is locked to vulnerable js-yaml ${version}.`);
	}
}

function validateProjectFiles() {
	const requiredFiles = [
		`CHANGELOG.md`,
		`README.md`,
		`blank.env`,
		`config/blank.json`,
		`config/configCheck.js`,
		`database/dbAudit.js`,
		`database/dbInit.js`,
		`docs/privacy-policy.md`,
		`docs/terms-and-conditions.md`,
		`events/ready.js`,
		`index.js`,
	];

	for (const file of requiredFiles) {
		assert(fs.existsSync(resolveProject(file)), `Missing required project file: ${file}.`);
	}

	assert(fs.existsSync(resolveProject(`commands`, `globalCommands`)), `Missing global command directory.`);
	assert(fs.existsSync(resolveProject(`commands`, `guildCommands`)), `Missing guild command directory.`);
	assert(fs.existsSync(resolveProject(`commands`, `globalCommands`, `utility`, `twitch.js`)), `Missing /twitch command file.`);
	assert(!fs.existsSync(resolveProject(`commands`, `globalCommands`, `utility`, `twitchroles.js`)), `Old twitchroles command file still exists.`);
}

function validateBlankConfig() {
	const { CronTime } = require(`cron`);
	const blankConfig = readJson(`config`, `blank.json`);
	const requiredFields = [
		`botOwner`,
		`guildId`,
		`twitchCron`,
		`kickCron`,
		`birthdayCron`,
		`statusCron`,
		`authCron`,
	];

	for (const field of requiredFields) {
		assert(blankConfig[field], `config/blank.json is missing ${field}.`);
	}

	for (const cronField of requiredFields.filter(field => field.endsWith(`Cron`))) {
		new CronTime(blankConfig[cronField]);
	}
}

function validateConfigCheckIfConfigured() {
	const configPath = resolveProject(`config`, `config.json`);

	if (!fs.existsSync(configPath)) {
		warn(`config/config.json not found; skipped configCheck smoke validation.`);
		return;
	}

	const result = spawnNode([`-e`, `require('./config/configCheck.js')`], {
		env: {
			TOKEN: `smoke-token`,
			clientId: `smoke-client-id`,
			kickClientId: `smoke-kick-client-id`,
			kickSecret: `smoke-kick-secret`,
			twitchClientId: `smoke-twitch-client-id`,
			twitchSecret: `smoke-twitch-secret`,
		},
	});

	assert(result.status === 0, `configCheck failed:\n${result.stdout}${result.stderr}`);
}

function validateRuntimeDependencies() {
	const dependencies = [
		`cron`,
		`discord.js`,
		`dotenv`,
		`he`,
		`luxon`,
		`sequelize`,
		`sqlite3`,
		`tar`,
		`ws`,
	];

	for (const dependency of dependencies) {
		require(dependency);
	}

	require(`sqlite3`).verbose();
}

function validatePureHelpers() {
	const { birthdayAutocompletes, timezoneAutocompletes } = requireFresh(`utils`, `autocompletes.js`);
	const { normalizeColorInput } = requireFresh(`utils`, `colors.js`);
	const { dateToString } = requireFresh(`utils`, `dateToString.js`);
	const {
		getTimezoneChoicesForRegion,
		getTimezoneRegionId,
	} = requireFresh(`utils`, `timezones.js`);

	assert(birthdayAutocompletes(`jan`).some(choice => choice.value === `January`), `Birthday autocomplete did not find January.`);
	assert(timezoneAutocompletes(`new_york`).some(choice => choice.value === `America/New_York`), `Timezone autocomplete did not find America/New_York.`);
	assert(normalizeColorInput(`#abc`)?.color === 0xaabbcc, `Short hex color normalization failed.`);
	assert(getTimezoneRegionId(`America/New_York`) === `us`, `Timezone region detection failed.`);
	assert(getTimezoneChoicesForRegion(`us`).length <= 25, `Timezone region choices exceed Discord limit.`);
	assert(typeof dateToString(new Date(`2026-07-07T12:00:00Z`)) === `string`, `dateToString did not return a string.`);
}

function validateGitHygiene() {
	const gitResult = runGit([`ls-files`, `node_modules`]);

	if (gitResult.error) {
		warn(`git is unavailable; skipped tracked node_modules check.`);
		return;
	}

	assert(gitResult.status === 0, `git ls-files failed: ${gitResult.stderr}`);
	assert(gitResult.stdout.trim() === ``, `node_modules files are tracked by git.`);
}

async function main() {
	let dbObjects = null;

	await test(`package metadata and lockfile are consistent`, validatePackageMetadata);
	await test(`required project files exist`, validateProjectFiles);
	await test(`blank config cron fields are valid`, validateBlankConfig);
	await test(`runtime dependencies can be required`, validateRuntimeDependencies);
	await test(`commands load and serialize for Discord deployment`, collectCommands);
	await test(`component handlers have routable customId prefixes`, assertComponentHandlersAreRoutable);
	await test(`events load with valid handlers`, validateEventFiles);
	await test(`help catalog builds from loaded commands`, assertHelpCatalogBuilds);
	await test(`database models match audited schema columns`, () => {
		dbObjects = validateDatabaseModels();
	});
	await test(`local database audit is clean when database exists`, auditLocalDatabaseIfPresent);
	await test(`configCheck validates local config when present`, validateConfigCheckIfConfigured);
	await test(`pure utility helpers return expected values`, validatePureHelpers);
	await test(`git hygiene checks pass`, validateGitHygiene);

	if (dbObjects?.sequelize) {
		await dbObjects.sequelize.close().catch(() => null);
	}

	console.log(``);
	console.log(`Smoke test complete: ${results.passed} passed, ${results.warned} warning(s), ${results.failed} failed.`);

	if (results.failed) {
		process.exitCode = 1;
	}
}

main().catch(error => {
	console.error(`[fail] smoke test crashed`);
	console.error(error);
	process.exitCode = 1;
});
