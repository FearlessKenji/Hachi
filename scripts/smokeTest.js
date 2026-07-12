#!/usr/bin/env node

const childProcess = require(`node:child_process`);
const fs = require(`node:fs`);
const os = require(`node:os`);
const path = require(`node:path`);

const projectRoot = path.resolve(__dirname, `..`);
process.chdir(projectRoot);

// Smoke tests are intentionally broad rather than deeply mocked. They catch the
// integration failures most likely to break a self-hosted bot install: missing
// files, command export drift, database/schema drift, encrypted runtime support,
// HachiGen config writes, and generated artifact hygiene.
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
	const { getConfiguredGuildIds } = requireFresh(`utils`, `configValues.js`);
	const { PermissionsBitField } = require(`discord.js`);
	const commandMap = new Map();
	const guildIds = getConfiguredGuildIds(readJson(`config`, `config.json`));

	for (const { command, json } of loadedCommands) {
		commandMap.set(json.name, command);
	}

	const catalog = buildHelpCatalog(commandMap, { guildId: guildIds[0] || null });

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

		if (relative(filePath) === `events/ready.js`) {
			assert(typeof event.reconcileServerRows === `function`, `events/ready.js is missing server-row reconciliation.`);
		}

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
		`.github/workflows/ci.yml`,
		`.github/workflows/release-hachigen.yml`,
		`README.md`,
		`blank.env`,
		`config/blank.json`,
		`config/configCheck.js`,
		`database/dbAudit.js`,
		`database/dbInit.js`,
		`docs/_config.yml`,
		`docs/patch-notes.md`,
		`docs/privacy-policy.md`,
		`docs/terms-and-conditions.md`,
		`events/guildDelete.js`,
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

	const rootChangelog = fs.readFileSync(resolveProject(`CHANGELOG.md`), `utf8`);
	const docsIndex = fs.readFileSync(resolveProject(`docs`, `index.md`), `utf8`);
	const patchNotes = fs.readFileSync(resolveProject(`docs`, `patch-notes.md`), `utf8`);
	const pagesConfig = fs.readFileSync(resolveProject(`docs`, `_config.yml`), `utf8`);
	const releaseWorkflow = fs.readFileSync(resolveProject(`.github`, `workflows`, `release-hachigen.yml`), `utf8`);

	assert(rootChangelog.includes(`## v3.3.0`), `Root CHANGELOG.md should include the latest release entry.`);
	assert(patchNotes.includes(`## v3.3.0`), `docs/patch-notes.md should include the latest user-facing release entry.`);
	assert(docsIndex.includes(`https://github.com/FearlessKenji/Hachi/blob/main/CHANGELOG.md`), `docs/index.md should link to the root changelog.`);
	assert(docsIndex.includes(`patch-notes.html`), `docs/index.md should link to user-facing patch notes.`);
	assert(pagesConfig.includes(`theme: jekyll-theme-midnight`), `docs/_config.yml should use the Midnight GitHub Pages theme.`);
	assert(releaseWorkflow.includes(`branches:`) && releaseWorkflow.includes(`main`), `HachiGen release workflow should run when main changes.`);
	assert(releaseWorkflow.includes(`Resolve release tag`) && releaseWorkflow.includes(`package.json`), `HachiGen release workflow should resolve tags from package.json version bumps.`);
	assert(releaseWorkflow.includes(`version is still $version, but $tag does not exist`), `HachiGen release workflow should release the current version when its tag is missing.`);
	assert(!releaseWorkflow.includes(`ls-remote --exit-code --tags`), `HachiGen release workflow should not fail when a release tag is missing.`);
	assert(releaseWorkflow.includes(`tags:`) && releaseWorkflow.includes(`"v*"`), `HachiGen release workflow should run for v* tags.`);
	assert(releaseWorkflow.includes(`workflow_dispatch:`), `HachiGen release workflow should support manual runs for existing releases.`);
	assert(releaseWorkflow.includes(`HachiGen.exe`), `HachiGen release workflow should upload HachiGen.exe.`);
	assert(releaseWorkflow.includes(`gh release upload`) && releaseWorkflow.includes(`gh release create`), `HachiGen release workflow should create or update releases.`);
}

function validateBlankConfig() {
	const { CronTime } = require(`cron`);
	const blankConfig = readJson(`config`, `blank.json`);
	const requiredFields = [
		`botOwners`,
		`guildIds`,
		`twitchCron`,
		`kickCron`,
		`birthdayCron`,
		`statusCron`,
		`authCron`,
	];

	for (const field of requiredFields) {
		assert(blankConfig[field], `config/blank.json is missing ${field}.`);
	}

	assert(Array.isArray(blankConfig.botOwners), `config/blank.json botOwners should be an array.`);
	assert(Array.isArray(blankConfig.guildIds), `config/blank.json guildIds should be an array.`);

	for (const cronField of requiredFields.filter(field => field.endsWith(`Cron`))) {
		new CronTime(blankConfig[cronField]);
	}
}

function validateConfigCheckIfConfigured() {
	const configPath = resolveProject(`config`, `config.json`);
	const databasePath = resolveProject(`database`, `database.sqlite`);

	if (!fs.existsSync(configPath)) {
		warn(`config/config.json not found; skipped configCheck smoke validation.`);
		return;
	}

	// CI does not keep a real runtime database in the repository. When the
	// database is absent, give configCheck a temporary direct database key so it
	// can verify the mandatory-encryption settings without opening a live file.
	const databaseEnv = fs.existsSync(databasePath) ?
		{} :
		{
			HACHI_DB_ENCRYPTION: `encrypted`,
			HACHI_DB_KEY: `smoke-db-key`,
		};

	const result = spawnNode([`-e`, `require('./config/configCheck.js')`], {
		env: {
			...databaseEnv,
			TOKEN: `smoke-token`,
			clientId: `smoke-client-id`,
			HACHI_SECRETS_ENCRYPTION: `encrypted`,
			HACHI_SECRETS_KEY: `smoke-secret-key`,
			kickClientId: `smoke-kick-client-id`,
			kickSecret: `smoke-kick-secret`,
			twitchClientId: `smoke-twitch-client-id`,
			twitchSecret: `smoke-twitch-secret`,
		},
	});

	assert(result.status === 0, `configCheck failed:\n${result.stdout}${result.stderr}`);
}

function validateSecretEncryptionHelpers() {
	const secrets = requireFresh(`config`, `secretEncryption.js`);
	const key = secrets.generateSecretKey();
	const encrypted = secrets.encryptSecretValue(`TOKEN`, `smoke-token-value`, key);
	const env = {
		HACHI_SECRETS_ENCRYPTION: `encrypted`,
		HACHI_SECRETS_KEY: key,
		TOKEN: encrypted,
	};

	assert(secrets.isEncryptedValue(encrypted), `Encrypted secret does not use the expected envelope prefix.`);
	assert(secrets.decryptSecretValue(`TOKEN`, encrypted, key) === `smoke-token-value`, `Encrypted secret did not decrypt to the original value.`);

	const metadata = secrets.decryptEnvSecrets(env, { fields: [`TOKEN`] });
	assert(env.TOKEN === `smoke-token-value`, `decryptEnvSecrets did not replace encrypted process env value.`);
	assert(metadata.decryptedFields.includes(`TOKEN`), `decryptEnvSecrets did not report TOKEN as decrypted.`);
	assert(secrets.redactSecretText(`TOKEN="smoke-token-value"`).includes(`[redacted]`), `Secret redaction did not redact TOKEN assignment.`);
}

async function validateHachiGenSecretConfigurationRoundTrip() {
	const { HachiManager } = requireFresh(`manager`, `src`, `manager.js`);
	const secrets = requireFresh(`config`, `secretEncryption.js`);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `hachi-hachigen-secrets-`));
	const keyPath = path.join(tempDir, `keys`, `secrets.key`);
	const envPath = path.join(tempDir, `.env`);
	const envFields = [
		`TOKEN`,
		`clientId`,
		`twitchClientId`,
		`twitchSecret`,
		`kickClientId`,
		`kickSecret`,
	];
	const rawValues = {
		TOKEN: `smoke-discord-token`,
		clientId: `smoke-discord-client`,
		twitchClientId: `smoke-twitch-client`,
		twitchSecret: `smoke-twitch-secret`,
		kickClientId: `smoke-kick-client`,
		kickSecret: `smoke-kick-secret`,
	};
	let manager = null;

	try {
		fs.mkdirSync(path.join(tempDir, `config`), { recursive: true });
		fs.mkdirSync(path.dirname(keyPath), { recursive: true });
		fs.writeFileSync(keyPath, `${secrets.generateSecretKey()}\n`, `utf8`);
		fs.copyFileSync(resolveProject(`blank.env`), path.join(tempDir, `blank.env`));
		fs.copyFileSync(resolveProject(`config`, `blank.json`), path.join(tempDir, `config`, `blank.json`));
		fs.writeFileSync(envPath, `HACHI_SECRETS_KEY_FILE=${JSON.stringify(keyPath)}\n`, `utf8`);

		manager = new HachiManager({
			defaultInstallPath: tempDir,
			managerRoot: resolveProject(`manager`),
			userDataPath: path.join(tempDir, `userData`),
		});

		await manager.writeConfiguration({
			...rawValues,
			botOwners: `smoke-owner smoke-owner-two`,
			guildIds: `smoke-guild,smoke-guild-two`,
		});

		const envText = fs.readFileSync(envPath, `utf8`);

		for (const value of Object.values(rawValues)) {
			assert(!envText.includes(value), `.env contains raw HachiGen setup value ${value}.`);
		}

		const savedEnv = secrets.parseDotEnvFile(envPath);

		assert(savedEnv.HACHI_SECRETS_ENCRYPTION === `encrypted`, `HachiGen did not enable .env secret encryption.`);
		assert(savedEnv.HACHI_SECRETS_KEY_FILE === keyPath, `HachiGen changed the configured temp secrets key path.`);

		for (const field of envFields) {
			assert(secrets.isEncryptedValue(savedEnv[field]), `${field} was not saved as an encrypted value.`);
		}

		const tokenCiphertext = savedEnv.TOKEN;
		const savedConfig = JSON.parse(fs.readFileSync(path.join(tempDir, `config`, `config.json`), `utf8`));
		const readBack = manager.readLocalConfiguration();

		assert(Array.isArray(savedConfig.botOwners), `HachiGen did not save botOwners as an array.`);
		assert(Array.isArray(savedConfig.guildIds), `HachiGen did not save guildIds as an array.`);
		assert(savedConfig.botOwners.includes(`smoke-owner-two`), `HachiGen did not split bot owner IDs.`);
		assert(savedConfig.guildIds.includes(`smoke-guild-two`), `HachiGen did not split guild IDs.`);

		for (const field of envFields) {
			assert(readBack.values[field] === ``, `HachiGen exposed ${field} while reading protected config.`);
			assert(readBack.envProtection.fields[field].copyable, `${field} was not marked copyable after encryption.`);
		}

		const copied = await manager.readEnvSecretForCopy(`TOKEN`);
		assert(copied.value === rawValues.TOKEN, `HachiGen copy path did not decrypt TOKEN.`);

		await manager.writeConfiguration(Object.fromEntries(envFields.map(field => [field, ``])));

		const preservedEnv = secrets.parseDotEnvFile(envPath);
		assert(preservedEnv.TOKEN === tokenCiphertext, `Blank HachiGen save did not preserve encrypted TOKEN.`);
	} finally {
		if (manager?.databaseCipherTest) {
			manager.databaseCipherTest = null;
		}

		fs.rmSync(tempDir, { force: true, recursive: true });
	}
}

function validateHachiGenRendererEventLogging() {
	const { HachiManager } = requireFresh(`manager`, `src`, `manager.js`);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `hachi-hachigen-events-`));
	const liveEvents = [];

	try {
		const manager = new HachiManager({
			defaultInstallPath: tempDir,
			managerRoot: resolveProject(`manager`),
			userDataPath: path.join(tempDir, `userData`),
			sendEvent: event => liveEvents.push(event),
		});
		const result = manager.recordRendererEvent({
			type: `error`,
			message: `TOKEN="smoke-secret-token" failed in renderer`,
			details: {
				label: `TOKEN="smoke-secret-token"`,
			},
		});
		const logged = manager.operationLog[0];

		assert(result.ok, `Renderer event logger did not report success.`);
		assert(manager.operationLog.length === 1, `Renderer event was not written to HachiGen operationLog.`);
		assert(liveEvents.length === 1, `Renderer event was not echoed as a live manager event.`);
		assert(logged.type === `error`, `Renderer error event was not logged as an error.`);
		assert(logged.details.source === `renderer`, `Renderer event source detail was not preserved.`);
		assert(!logged.message.includes(`smoke-secret-token`), `Renderer event message leaked a secret.`);
		assert(logged.message.includes(`[redacted]`), `Renderer event message was not redacted.`);
		assert(!logged.details.label.includes(`smoke-secret-token`), `Renderer event details leaked a secret.`);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
}

function validateRuntimeDependencies() {
	const dependencies = [
		`better-sqlite3-multiple-ciphers`,
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

function restoreEnvValue(key, value) {
	if (value === undefined) {
		delete process.env[key];
		return;
	}

	process.env[key] = value;
}

async function validateEncryptedSequelizeRuntime() {
	const Sequelize = require(`sequelize`);
	const dialectModule = requireFresh(`database`, `sqlcipherSqlite3.js`);
	const { databaseFileStatus } = requireFresh(`database`, `dbEncryption.js`);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `hachi-runtime-cipher-`));
	const dbPath = path.join(tempDir, `runtime.sqlite`);
	const previousKey = process.env.HACHI_DB_KEY;
	const previousKeyFile = process.env.HACHI_DB_KEY_FILE;
	let sequelize = null;
	let reopened = null;

	try {
		process.env.HACHI_DB_KEY = `smoke-runtime-${Date.now()}`;
		delete process.env.HACHI_DB_KEY_FILE;

		sequelize = new Sequelize(`database`, ``, ``, {
			dialect: `sqlite`,
			dialectModule,
			logging: false,
			storage: dbPath,
		});
		const Sample = sequelize.define(`sample`, {
			value: {
				allowNull: false,
				type: Sequelize.STRING,
			},
		}, { timestamps: false });
		await sequelize.sync();
		await Sample.create({ value: `ok` });
		await sequelize.transaction(async transaction => {
			await Sample.create({ value: `tx` }, { transaction });
		});
		await sequelize.close();
		sequelize = null;

		const status = databaseFileStatus(dbPath);
		assert(status.encryptedLikely, `Encrypted runtime test database was created with a plain SQLite header.`);

		reopened = new Sequelize(`database`, ``, ``, {
			dialect: `sqlite`,
			dialectModule,
			logging: false,
			storage: dbPath,
		});
		const ReopenedSample = reopened.define(`sample`, {
			value: {
				allowNull: false,
				type: Sequelize.STRING,
			},
		}, { timestamps: false });
		const row = await ReopenedSample.findOne({ where: { value: `ok` } });
		const transactionRow = await ReopenedSample.findOne({ where: { value: `tx` } });

		assert(row?.get(`value`) === `ok`, `Encrypted runtime database did not reopen through Sequelize.`);
		assert(transactionRow?.get(`value`) === `tx`, `Encrypted runtime transaction row did not persist.`);
	} finally {
		if (sequelize) {
			await sequelize.close().catch(() => null);
		}

		if (reopened) {
			await reopened.close().catch(() => null);
		}

		restoreEnvValue(`HACHI_DB_KEY`, previousKey);
		restoreEnvValue(`HACHI_DB_KEY_FILE`, previousKeyFile);

		fs.rmSync(tempDir, { force: true, recursive: true });
	}
}

async function validateDatabaseEncryptionConversion() {
	const sqlite3 = require(`sqlite3`).verbose();
	const {
		convertPlainDatabaseToEncrypted,
		databaseFileStatus,
		describeDatabaseBackup,
		openSqlCipherDatabase,
		rekeyEncryptedDatabase,
		rotateDatabaseBackups,
		writeDatabaseBackupMetadata,
	} = requireFresh(`database`, `dbEncryption.js`);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `hachi-convert-cipher-`));
	const plainPath = path.join(tempDir, `plain.sqlite`);
	const encryptedPath = path.join(tempDir, `encrypted.sqlite`);
	const backupDir = path.join(tempDir, `backups`);
	const encryptedBackupPath = path.join(backupDir, `encrypted-backup.sqlite`);
	const plaintextBackupPath = path.join(backupDir, `plaintext-backup.sqlite`);
	const key = `smoke-convert-${Date.now()}`;

	try {
		await new Promise((resolve, reject) => {
			const db = new sqlite3.Database(plainPath, error => {
				if (error) {
					reject(error);
					return;
				}

				db.exec(
					`CREATE TABLE sample (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
					INSERT INTO sample (value) VALUES ('ok');
					PRAGMA user_version = 23;`,
					execError => {
						db.close(closeError => execError || closeError ? reject(execError || closeError) : resolve());
					},
				);
			});
		});

		const result = convertPlainDatabaseToEncrypted({
			key,
			root: projectRoot,
			sourcePath: plainPath,
			targetPath: encryptedPath,
		});

		assert(result.rowsCopied === 1, `Encrypted conversion copied ${result.rowsCopied} rows instead of 1.`);
		assert(databaseFileStatus(encryptedPath).encryptedLikely, `Encrypted conversion output has a plain SQLite header.`);

		const encryptedDb = openSqlCipherDatabase({
			dbPath: encryptedPath,
			key,
			readonly: true,
			root: projectRoot,
		});
		const row = encryptedDb.prepare(`SELECT value FROM sample WHERE id = 1`).get();
		const userVersion = encryptedDb.pragma(`user_version`, { simple: true });
		encryptedDb.close();

		assert(row?.value === `ok`, `Encrypted conversion did not preserve row data.`);
		assert(userVersion === 23, `Encrypted conversion did not preserve user_version.`);

		rekeyEncryptedDatabase({
			dbPath: encryptedPath,
			newKey: `${key}-rotated`,
			oldKey: key,
			root: projectRoot,
		});

		const rekeyedDb = openSqlCipherDatabase({
			dbPath: encryptedPath,
			key: `${key}-rotated`,
			readonly: true,
			root: projectRoot,
		});
		const rekeyedRow = rekeyedDb.prepare(`SELECT value FROM sample WHERE id = 1`).get();
		rekeyedDb.close();

		assert(rekeyedRow?.value === `ok`, `Encrypted rekey did not preserve row data.`);

		fs.mkdirSync(backupDir, { recursive: true });
		fs.copyFileSync(encryptedPath, encryptedBackupPath);
		fs.copyFileSync(plainPath, plaintextBackupPath);
		writeDatabaseBackupMetadata({
			backupPath: encryptedBackupPath,
			key: `${key}-rotated`,
			reason: `smoke`,
			root: tempDir,
			source: `smoke`,
		});

		assert(
			describeDatabaseBackup({ backupPath: encryptedBackupPath, currentKey: `${key}-rotated` }).status === `current-key`,
			`Encrypted backup metadata did not match the current key.`,
		);

		const backupRotation = rotateDatabaseBackups({
			backupDir,
			includePlaintext: true,
			newKey: `${key}-backup-rotated`,
			oldKey: `${key}-rotated`,
			root: projectRoot,
			source: `smoke`,
		});

		assert(backupRotation.rekeyed === 1, `Backup rotation rekeyed ${backupRotation.rekeyed} encrypted backups instead of 1.`);
		assert(backupRotation.converted === 1, `Backup rotation encrypted ${backupRotation.converted} plaintext backups instead of 1.`);

		for (const backupPath of [encryptedBackupPath, plaintextBackupPath]) {
			const backupDb = openSqlCipherDatabase({
				dbPath: backupPath,
				key: `${key}-backup-rotated`,
				readonly: true,
				root: projectRoot,
			});
			const backupRow = backupDb.prepare(`SELECT value FROM sample WHERE id = 1`).get();
			backupDb.close();

			assert(backupRow?.value === `ok`, `Backup rotation did not preserve row data for ${path.basename(backupPath)}.`);
			assert(
				describeDatabaseBackup({ backupPath, currentKey: `${key}-backup-rotated` }).status === `current-key`,
				`Backup rotation did not write current-key metadata for ${path.basename(backupPath)}.`,
			);
		}
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
}

function validatePureHelpers() {
	const { HachiManager } = requireFresh(`manager`, `src`, `manager.js`);
	const { birthdayAutocompletes, timezoneAutocompletes } = requireFresh(`utils`, `autocompletes.js`);
	const { normalizeColorInput } = requireFresh(`utils`, `colors.js`);
	const { dateToString } = requireFresh(`utils`, `dateToString.js`);
	const serverLifecycle = requireFresh(`utils`, `serverLifecycle.js`);
	const {
		getTimezoneChoicesForRegion,
		getTimezoneRegionId,
	} = requireFresh(`utils`, `timezones.js`);

	assert(typeof HachiManager.prototype.updateStateMatchesRepository === `function`, `HachiManager update-state repository guard is missing.`);
	assert(typeof serverLifecycle.reconcileServerRows === `function`, `server lifecycle reconciliation helper is missing.`);
	assert(typeof serverLifecycle.markServerLeft === `function`, `server lifecycle leave tracker is missing.`);
	assert(birthdayAutocompletes(`jan`).some(choice => choice.value === `January`), `Birthday autocomplete did not find January.`);
	assert(timezoneAutocompletes(`new_york`).some(choice => choice.value === `America/New_York`), `Timezone autocomplete did not find America/New_York.`);
	assert(normalizeColorInput(`#abc`)?.color === 0xaabbcc, `Short hex color normalization failed.`);
	assert(getTimezoneRegionId(`America/New_York`) === `us`, `Timezone region detection failed.`);
	assert(getTimezoneChoicesForRegion(`us`).length <= 25, `Timezone region choices exceed Discord limit.`);
	assert(typeof dateToString(new Date(`2026-07-07T12:00:00Z`)) === `string`, `dateToString did not return a string.`);
}

function validateGitHygiene() {
	const nodeModulesResult = runGit([`ls-files`, `node_modules`]);

	if (nodeModulesResult.error) {
		warn(`git is unavailable; skipped tracked generated-file checks.`);
		return;
	}

	assert(nodeModulesResult.status === 0, `git ls-files failed: ${nodeModulesResult.stderr}`);
	assert(nodeModulesResult.stdout.trim() === ``, `node_modules files are tracked by git.`);

	const hachiGenResult = runGit([`ls-files`, `HachiGen.exe`]);

	assert(hachiGenResult.status === 0, `git ls-files failed: ${hachiGenResult.stderr}`);

	if (hachiGenResult.stdout.trim() !== ``) {
		const hachiGenStatus = runGit([`status`, `--short`, `--`, `HachiGen.exe`]);

		assert(hachiGenStatus.status === 0, `git status failed: ${hachiGenStatus.stderr}`);
		assert(
			hachiGenStatus.stdout.trim().startsWith(`D`),
			`HachiGen.exe should be a release artifact, not a tracked repository file.`,
		);
	}
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
	await test(`encrypted Sequelize runtime opens SQLCipher databases`, validateEncryptedSequelizeRuntime);
	await test(`database encryption conversion preserves SQLite data`, validateDatabaseEncryptionConversion);
	await test(`local database audit is clean when database exists`, auditLocalDatabaseIfPresent);
	await test(`secret encryption helpers round-trip env values`, validateSecretEncryptionHelpers);
	await test(`HachiGen saves setup env values encrypted`, validateHachiGenSecretConfigurationRoundTrip);
	await test(`HachiGen records renderer errors in event log`, validateHachiGenRendererEventLogging);
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
