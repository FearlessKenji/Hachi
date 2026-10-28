#!/usr/bin/env node

const childProcess = require(`node:child_process`);
const fs = require(`node:fs`);
const os = require(`node:os`);
const path = require(`node:path`);
const { URL, URLSearchParams } = require(`node:url`);

const projectRoot = path.resolve(__dirname, `..`);
process.chdir(projectRoot);

// Smoke tests cover the integration failures most likely to break a self-hosted
// bot install: missing files, command export drift, database/schema drift,
// encrypted runtime support, and generated artifact hygiene. Focused mocks use
// disposable state for provider requests and failure paths that cannot safely
// run against a live installation.
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

function validateCommandOptionJson(commandName, option, pathParts = []) {
	const optionPath = [...pathParts, option.name].filter(Boolean).join(` `);

	assert(option.name, `${commandName} has an option without a name.`);
	assert(/^[\p{Ll}\p{N}_-]{1,32}$/u.test(option.name), `${commandName} option ${optionPath} has an invalid name.`);
	assert(option.description, `${commandName} option ${optionPath} is missing a description.`);
	assert(option.description.length <= 100, `${commandName} option ${optionPath} description is longer than 100 characters.`);

	if (option.choices) {
		assert(Array.isArray(option.choices), `${commandName} option ${optionPath} choices should be an array.`);
		assert(option.choices.length <= 25, `${commandName} option ${optionPath} has more than 25 choices.`);

		for (const choice of option.choices) {
			assert(choice.name, `${commandName} option ${optionPath} has a choice without a name.`);
			assert(choice.name.length <= 100, `${commandName} option ${optionPath} choice ${choice.name} is longer than 100 characters.`);
			assert(choice.value !== undefined, `${commandName} option ${optionPath} choice ${choice.name} is missing a value.`);
		}
	}

	if (option.autocomplete) {
		assert(!option.choices?.length, `${commandName} option ${optionPath} uses autocomplete and static choices together.`);
	}

	if (option.options) {
		assert(Array.isArray(option.options), `${commandName} option ${optionPath} child options should be an array.`);
		assert(option.options.length <= 25, `${commandName} option ${optionPath} has more than 25 child options.`);

		for (const childOption of option.options) {
			validateCommandOptionJson(commandName, childOption, [...pathParts, option.name]);
		}
	}
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

		for (const option of json.options) {
			validateCommandOptionJson(json.name, option);
		}
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
	const messageContextNames = commands
		.filter(({ json }) => json.type === 3)
		.map(({ json }) => json.name)
		.sort();

	assert(globalData.length === globalCount, `Global command data count does not match loaded global command count.`);
	assert(guildData.length === guildCount, `Guild command data count does not match loaded guild command count.`);
	assert(
		messageContextNames.join(`|`) === `Convert to Reaction Roles|Edit Reaction Roles`,
		`Unexpected message context command set: ${messageContextNames.join(`, `) || `none`}.`,
	);

	for (const data of globalData) {
		assert(Array.isArray(data.integration_types), `${data.name} global command is missing integration_types.`);
	}

	loadedCommands = commands;
}

async function validateSetupHubOrdering() {
	const { ButtonStyle } = require(`discord.js`);
	const setup = requireFresh(`commands`, `globalCommands`, `setup`, `setup.js`);
	let replyPayload = null;

	await setup.execute({
		id: `smoke-setup-order`,
		guild: { id: `smoke-guild` },
		user: { id: `smoke-user` },
		reply(payload) {
			replyPayload = payload;
			return Promise.resolve();
		},
	});

	const fields = replyPayload?.embeds?.[0]?.data?.fields?.map(field => field.name) || [];
	const buttons = replyPayload?.components?.[0]?.components?.map(button => button.data) || [];
	const expectedOrder = [
		`Hachi Updates`,
		`Stream Notifications`,
		`Birthday Posts`,
		`Security Reporting`,
		`Raid Protection`,
	];

	assert(fields.slice(0, 5).join(`|`) === expectedOrder.join(`|`), `/setup embed fields are not in the expected order.`);
	assert(buttons.map(button => button.label).join(`|`) === expectedOrder.join(`|`), `/setup buttons are not in the expected order.`);
	assert(buttons[0]?.style === ButtonStyle.Primary, `Hachi Updates should be the primary setup button.`);
	assert(buttons.slice(1).every(button => button.style === ButtonStyle.Secondary), `Non-primary setup buttons should use secondary style.`);
}

async function validateTwitchVerificationPanelPrivacyCopy() {
	const { panelPayload } = requireFresh(`utils`, `twitchVerificationPanels.js`);
	const payload = panelPayload();

	assert(payload.content.includes(`-# Hachi never sees your Twitch password`), `Twitch verification panel is missing Discord subtext privacy copy.`);
	assert(payload.content.includes(`does not store OAuth tokens from this verification`), `Twitch verification panel should explain OAuth token storage behavior.`);
	assert(payload.content.includes(`VIP for the connected channel`), `Twitch verification panel should describe VIP role linking.`);
	assert(!payload.content.includes(`Moderator`), `Twitch verification panel should not advertise Moderator role linking.`);
	assert(payload.components[0].components[0].data.custom_id === `twitch:verify`, `Managed Twitch verification panel should retain its restart-safe button ID.`);
}

async function validateVipOnlyTwitchRoleSync() {
	const { PermissionFlagsBits } = require(`discord.js`);
	const {
		BROADCASTER_SCOPES,
		cleanupLegacyModeratorRoles,
	} = requireFresh(`modules`, `twitchRoles.js`);
	const removedRoles = [];
	const legacyRole = {
		comparePositionTo: () => -1,
		id: `legacy-moderator-role`,
		managed: false,
	};
	const member = {
		roles: {
			cache: new Map([[legacyRole.id, legacyRole]]),
			remove: async (roleId, reason) => removedRoles.push({ reason, roleId }),
		},
	};
	const guild = {
		id: `vip-only-guild`,
		members: {
			fetch: async () => member,
			me: {
				permissions: { has: permission => permission === PermissionFlagsBits.ManageRoles },
				roles: { highest: {} },
			},
		},
		roles: { cache: new Map([[legacyRole.id, legacyRole]]) },
	};
	const config = {
		moderatorRoleId: legacyRole.id,
		async update(values) {
			Object.assign(this, values);
		},
	};
	const result = await cleanupLegacyModeratorRoles(guild, config, [{ discordUserId: `linked-member` }]);

	assert(BROADCASTER_SCOPES.join(` `) === `channel:read:vips`, `Twitch broadcaster authorization should request only the VIP scope.`);
	assert(result.complete && removedRoles.length === 1, `Legacy Twitch Moderator roles should be removed from linked members.`);
	assert(config.moderatorRoleId === null, `Legacy Twitch Moderator mapping should clear after successful cleanup.`);
	assert(removedRoles[0].reason === `Retiring Twitch Moderator role sync`, `Legacy role cleanup should use an auditable reason.`);
}

async function validateManagedTwitchVerificationPanelLifecycle() {
	const { PermissionFlagsBits } = require(`discord.js`);
	const { TwitchVerificationPanels } = require(resolveProject(`database`, `dbObjects.js`));
	const {
		removeVerificationPanel,
		repairVerificationPanel,
		sendVerificationPanelWarningToManager,
		setVerificationPanel,
	} = requireFresh(`utils`, `twitchVerificationPanels.js`);
	const originalFindByPk = TwitchVerificationPanels.findByPk;
	const originalUpsert = TwitchVerificationPanels.upsert;
	const lifecycle = [];
	const oldMessage = { delete: async () => lifecycle.push(`delete-old`) };
	let nextMessageId = 1;
	let panel = {
		channelId: `old-channel`,
		failureCode: null,
		guildId: `panel-guild`,
		lastRepairAt: null,
		messageId: `old-message`,
		async destroy() {
			lifecycle.push(`destroy-record`);
		},
		async update(values) {
			Object.assign(this, values);
		},
	};
	const permissions = { has: permission => [
		PermissionFlagsBits.ReadMessageHistory,
		PermissionFlagsBits.SendMessages,
		PermissionFlagsBits.ViewChannel,
	].includes(permission) };
	const channels = new Map();
	const makeChannel = (id, fetchedMessage = null) => ({
		id,
		isTextBased: () => true,
		messages: { fetch: async () => fetchedMessage },
		permissionsFor: () => permissions,
		async send(payload) {
			assert(payload.content.startsWith(`## Twitch Verification`), `Managed panel should use the canonical payload.`);
			return { id: `new-message-${nextMessageId++}` };
		},
	});
	channels.set(`old-channel`, makeChannel(`old-channel`, oldMessage));
	channels.set(`new-channel`, makeChannel(`new-channel`));
	const guild = {
		channels: { fetch: async id => channels.get(id) || null },
		id: `panel-guild`,
		members: { me: {} },
	};
	const client = { guilds: { cache: new Map([[guild.id, guild]]) } };

	try {
		TwitchVerificationPanels.findByPk = async () => panel;
		TwitchVerificationPanels.upsert = async values => {
			panel = { ...panel, ...values };
		};

		const movedMessage = await setVerificationPanel(guild, channels.get(`new-channel`));
		assert(movedMessage.id === `new-message-1`, `Moving a managed panel should create its replacement.`);
		assert(lifecycle[0] === `delete-old`, `Moving a managed panel should delete the old message only after replacement succeeds.`);
		assert(panel.channelId === `new-channel` && panel.messageId === movedMessage.id, `Moving a managed panel should store its replacement IDs.`);

		panel.update = async values => Object.assign(panel, values);
		panel.lastRepairAt = null;
		const repaired = await repairVerificationPanel(client, panel, { force: true });
		assert(repaired.repaired && panel.messageId === `new-message-2`, `Missing managed panel messages should be recreated and stored.`);

		let warningCount = 0;
		Object.assign(panel, {
			failureCode: `send-history`,
			warningCount: 0,
			warningLastSentAt: null,
			warningWindowStartedAt: null,
		});
		const managerInteraction = {
			deferred: true,
			async followUp(payload) {
				assert(payload.flags === 64, `Managed-panel warnings should be ephemeral.`);
				assert(payload.content.includes(`Send Messages, Read Message History`), `Managed-panel warnings should name missing permissions.`);
				warningCount += 1;
			},
			guildId: guild.id,
			isChatInputCommand: () => true,
			memberPermissions: { has: permission => permission === PermissionFlagsBits.ManageGuild },
		};
		const warningStart = new Date(`2026-08-16T12:00:00.000Z`);
		for (const minutes of [0, 5, 15, 30, 45]) {
			await sendVerificationPanelWarningToManager(
				managerInteraction,
				new Date(warningStart.getTime() + minutes * 60 * 1000),
			);
		}
		assert(warningCount === 3, `Managed-panel warnings should allow three reminders at least 15 minutes apart.`);
		await sendVerificationPanelWarningToManager(
			managerInteraction,
			new Date(warningStart.getTime() + 24 * 60 * 60 * 1000),
		);
		assert(warningCount === 4, `Managed-panel warning budget should refresh after 24 hours.`);

		const removalMessage = { delete: async () => lifecycle.push(`delete-removed`) };
		channels.set(`new-channel`, makeChannel(`new-channel`, removalMessage));
		panel.destroy = async () => lifecycle.push(`destroy-record`);
		await removeVerificationPanel(guild);
		assert(
			lifecycle.slice(-2).join(`,`) === `destroy-record,delete-removed`,
			`Removing a managed panel should clear ownership before deleting its message.`,
		);
	} finally {
		TwitchVerificationPanels.findByPk = originalFindByPk;
		TwitchVerificationPanels.upsert = originalUpsert;
	}
}

async function validateAnnouncementChannelIdNormalization() {
	const announcements = requireFresh(`utils`, `announcements.js`);
	const { AnnouncementDeliveryProgress, Servers } = require(resolveProject(`database`, `dbObjects.js`));
	const originalFindByPk = Servers.findByPk;
	const originalFindOne = Servers.findOne;
	const originalCreate = Servers.create;
	const originalDestroyProgress = AnnouncementDeliveryProgress.destroy;
	const writes = [];

	try {
		AnnouncementDeliveryProgress.destroy = async () => 0;
		Servers.findByPk = async guildId => {
			assert(typeof guildId === `string`, `Announcement guild lookup received a non-string guild ID.`);
			return null;
		};
		Servers.create = async values => {
			writes.push(values);
			assert(typeof values.guildId === `string`, `Announcement settings create received a non-string guild ID.`);
			assert(typeof values.hachiAnnouncementChannelId === `string`, `Announcement settings create received a non-string channel ID.`);
			return values;
		};
		Servers.findOne = async options => {
			assert(typeof options.where.guildId === `string`, `Announcement settings read received a non-string guild ID.`);
			return {
				guildId: options.where.guildId,
				hachiAnnouncementChannelId: writes.at(-1)?.hachiAnnouncementChannelId || null,
				hachiAnnouncementLastId: null,
			};
		};

		const settings = await announcements.saveAnnouncementChannel(
			{ id: `smoke-guild-id` },
			{ id: `smoke-channel-id` },
		);

		assert(settings.guildId === `smoke-guild-id`, `Announcement settings did not normalize object-shaped guild ID.`);
		assert(settings.hachiAnnouncementChannelId === `smoke-channel-id`, `Announcement settings did not normalize object-shaped channel ID.`);
		assert(announcements.normalizeAnnouncementId(123456789n) === `123456789`, `Announcement ID normalization did not handle bigint IDs.`);
	} finally {
		Servers.findByPk = originalFindByPk;
		Servers.findOne = originalFindOne;
		Servers.create = originalCreate;
		AnnouncementDeliveryProgress.destroy = originalDestroyProgress;
	}
}

async function validateManagerAnnouncementWarnings() {
	const announcements = requireFresh(`utils`, `announcements.js`);
	const { PermissionFlagsBits } = require(`discord.js`);
	const { Servers } = require(resolveProject(`database`, `dbObjects.js`));
	const originalFindByPk = Servers.findByPk;
	let managerWarnings = 0;
	const server = {
		hachiAnnouncementChannelId: `updates-channel`,
		hachiAnnouncementWarningCount: 0,
		hachiAnnouncementWarningKey: `updates-channel:send`,
		hachiAnnouncementWarningLastSentAt: null,
		hachiAnnouncementWarningWindowStartedAt: null,
		async update(values) {
			Object.assign(this, values);
		},
	};

	try {
		Servers.findByPk = async guildId => {
			assert(guildId === `warning-guild`, `Manager warning looked up the wrong server.`);
			return server;
		};
		const managerInteraction = {
			deferred: true,
			async followUp(payload) {
				assert(payload.flags === 64, `Manager warning should be ephemeral.`);
				assert(payload.content.startsWith(`## Hachi updates need attention:`), `Manager warning should start with the attention header.`);
				assert(payload.content.includes(`**Missing permissions:** Send Messages`), `Manager warning should name missing permissions.`);
				managerWarnings += 1;
			},
			guildId: `warning-guild`,
			isChatInputCommand: () => true,
			memberPermissions: { has: permission => permission === PermissionFlagsBits.ManageGuild },
		};
		const warningStart = new Date(`2026-08-11T12:00:00.000Z`);

		await announcements.sendAnnouncementWarningToManager(managerInteraction, warningStart);
		await announcements.sendAnnouncementWarningToManager(managerInteraction, new Date(warningStart.getTime() + 5 * 60 * 1000));
		await announcements.sendAnnouncementWarningToManager(managerInteraction, new Date(warningStart.getTime() + 15 * 60 * 1000));
		await announcements.sendAnnouncementWarningToManager(managerInteraction, new Date(warningStart.getTime() + 30 * 60 * 1000));
		await announcements.sendAnnouncementWarningToManager(managerInteraction, new Date(warningStart.getTime() + 45 * 60 * 1000));
		assert(managerWarnings === 3, `Manager warnings should allow three reminders with at least 15 minutes between them.`);
		await announcements.sendAnnouncementWarningToManager(managerInteraction, new Date(warningStart.getTime() + 24 * 60 * 60 * 1000));
		assert(managerWarnings === 4, `Manager warning budget should refresh after 24 hours.`);

		const channelWithViewOnly = {
			isTextBased: () => true,
			permissionsFor: () => ({ has: permission => permission === PermissionFlagsBits.ViewChannel }),
			send: () => null,
		};
		const access = await announcements.checkAnnouncementChannelAccess({ members: { me: {} } }, channelWithViewOnly);
		assert(access.code === `send`, `Announcement access checks should identify a missing Send Messages permission.`);
	} finally {
		Servers.findByPk = originalFindByPk;
	}
}

async function validateRaidAuditExplicitAllowFiltering() {
	const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require(`discord.js`);
	const raidProtection = requireFresh(`utils`, `raidProtection.js`);
	const allPermissions = Object.values(PermissionFlagsBits);
	const usableChannelPermissions = new PermissionsBitField([
		PermissionFlagsBits.ViewChannel,
		PermissionFlagsBits.SendMessages,
		PermissionFlagsBits.EmbedLinks,
		PermissionFlagsBits.ManageRoles,
	]);

	function makeRole({ id, managed = false, name, permissions = [], position = 1, tags = {} }) {
		return {
			id,
			managed,
			name,
			permissions: new PermissionsBitField(permissions),
			position,
			tags,
			comparePositionTo(otherRole) {
				return this.position - (otherRole?.position || 0);
			},
		};
	}

	function makeOverwrite(id, allow = [], deny = []) {
		return {
			allow: new PermissionsBitField(allow),
			deny: new PermissionsBitField(deny),
			id,
		};
	}

	const roles = new Map();
	const guild = {
		id: `smoke-guild`,
		members: {
			cache: new Map(),
			fetchMe: () => Promise.resolve(guild.members.me),
			me: null,
		},
		roles: {
			cache: roles,
			fetch: () => Promise.resolve(roles),
		},
		channels: {
			cache: new Map(),
			fetch: channelId => Promise.resolve(channelId ? guild.channels.cache.get(channelId) : guild.channels.cache),
		},
	};
	const everyoneRole = makeRole({ id: guild.id, name: `@everyone`, position: 0 });
	const quarantineRole = makeRole({ id: `quarantine`, name: `Quarantine`, position: 1 });
	const memberRole = makeRole({
		id: `member`,
		name: `Member`,
		permissions: [PermissionFlagsBits.Connect],
		position: 2,
	});
	const officerRole = makeRole({ id: `officers`, name: `Officers`, position: 3 });
	const hachiRole = makeRole({
		id: `hachi`,
		managed: true,
		name: `Hachi`,
		permissions: [PermissionFlagsBits.ManageRoles],
		position: 10,
		tags: { botId: `hachi-bot` },
	});

	for (const role of [everyoneRole, quarantineRole, memberRole, officerRole, hachiRole]) {
		roles.set(role.id, role);
	}

	guild.members.me = {
		id: `hachi-bot`,
		permissions: new PermissionsBitField([
			PermissionFlagsBits.ManageRoles,
			PermissionFlagsBits.ManageMessages,
			PermissionFlagsBits.ModerateMembers,
		]),
		roles: {
			cache: new Map([[hachiRole.id, hachiRole]]),
			highest: hachiRole,
		},
	};

	function makeChannel({ id, name, overwrites, type = ChannelType.GuildText }) {
		return {
			guild,
			id,
			name,
			parentId: null,
			permissionOverwrites: { cache: new Map(overwrites.map(overwrite => [overwrite.id, overwrite])) },
			permissionsFor: () => usableChannelPermissions,
			permissionsLocked: true,
			send: () => Promise.resolve(),
			type,
		};
	}

	const quarantineDeny = makeOverwrite(quarantineRole.id, [], allPermissions);
	const partialQuarantineDeny = makeOverwrite(quarantineRole.id, [], [PermissionFlagsBits.ViewChannel]);
	const channels = [
		makeChannel({
			id: `alert`,
			name: `raid-alerts`,
			overwrites: [quarantineDeny],
		}),
		makeChannel({
			id: `report`,
			name: `raid-reports`,
			overwrites: [quarantineDeny],
		}),
		makeChannel({
			id: `voice`,
			name: `voice-lobby`,
			overwrites: [
				quarantineDeny,
				makeOverwrite(hachiRole.id, [PermissionFlagsBits.ManageRoles]),
				makeOverwrite(memberRole.id, [PermissionFlagsBits.Connect]),
			],
			type: ChannelType.GuildVoice,
		}),
		makeChannel({
			id: `staff`,
			name: `staff-chat`,
			overwrites: [
				quarantineDeny,
				makeOverwrite(officerRole.id, [PermissionFlagsBits.SendMessages]),
			],
		}),
		makeChannel({
			id: `limited`,
			name: `limited-chat`,
			overwrites: [partialQuarantineDeny],
		}),
	];

	for (const channel of channels) {
		guild.channels.cache.set(channel.id, channel);
	}

	const audit = await raidProtection.auditRaidConfiguration(guild, {
		...raidProtection.getDefaultRaidConfig(guild.id),
		alertChannelId: `alert`,
		enabled: true,
		quarantineRoleId: quarantineRole.id,
		reportChannelId: `report`,
	});
	const warningText = audit.warnings
		.map(issue => `${issue.message} ${issue.detail || ``}`)
		.join(`\n`);

	assert(warningText.includes(`Explicit channel/category allow permissions: Send Messages (1).`), `Raid audit should report risky channel overwrite allows.`);
	assert(warningText.includes(`\`Officers\` (1)`), `Raid audit should report the role with the risky overwrite.`);
	assert(warningText.includes(`cannot apply full quarantine denies`), `Raid audit should report broad Manage Roles without explicit Manage Permissions as limited for full-deny sync.`);
	assert(warningText.includes(`grant Hachi Administrator`), `Raid audit should mention Administrator as the easiest full-deny sync option.`);
	assert(warningText.includes(`Manage Permissions allows for Hachi on affected categories/channels`), `Raid audit should mention category/channel Manage Permissions exceptions.`);
	assert(warningText.includes(`limited-chat`), `Raid audit should include a sample location for full-deny sync limits.`);
	assert(!warningText.includes(`\`Hachi\``), `Raid audit should not warn against Hachi's own role overwrites.`);
	assert(!warningText.includes(`Connect`), `Raid audit should not report ordinary voice Connect access as a risky explicit allow.`);
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

function validateHachiCommandSurfaces() {
	assert(loadedCommands, `Commands must be loaded before command surface checks run.`);

	const { buildHelpCatalog } = requireFresh(`utils`, `helpCatalog.js`);
	const commandMap = new Map();

	for (const { command, filePath, json } of loadedCommands) {
		commandMap.set(json.name, command);

		assert(command.execute.constructor.name === `AsyncFunction`, `${relative(filePath)} execute() should be async.`);

		for (const optionalHandler of [`autocomplete`, `handleComponent`, `handleModalSubmit`]) {
			if (command[optionalHandler] !== undefined) {
				assert(typeof command[optionalHandler] === `function`, `${relative(filePath)} ${optionalHandler} should be a function when exported.`);
				assert(command[optionalHandler].constructor.name === `AsyncFunction`, `${relative(filePath)} ${optionalHandler} should be async.`);
			}
		}

		if (!command.help?.hidden) {
			assert(command.help, `${relative(filePath)} should provide help metadata or explicitly hide itself.`);
			assert(command.help.category || command.commandScope === `guild`, `${relative(filePath)} help metadata is missing a category.`);
		}
	}

	const catalog = buildHelpCatalog(commandMap, { guildId: null });
	const catalogEntries = catalog.flatMap(category => category.entries.map(entry => entry.command));

	for (const { command, filePath, json } of loadedCommands) {
		if (command.commandScope !== `global` || command.help?.hidden) {
			continue;
		}

		const commandPrefix = json.type && json.type !== 1 ? json.name : `/${json.name}`;

		assert(
			catalogEntries.some(entry => entry === commandPrefix || entry.startsWith(`${commandPrefix} `)),
			`${relative(filePath)} is not represented in the help catalog.`,
		);
	}

	const raidCommand = commandMap.get(`raid`);
	const longSyncErrors = Array.from({ length: 40 }, (_, index) =>
		`category raid-sync-${index}: full quarantine sync needs Administrator or an explicit Manage Permissions allow.`,
	);
	const syncErrorField = raidCommand.formatSyncErrorField(longSyncErrors);

	assert(syncErrorField.length <= 1024, `Raid sync error embed field should stay within Discord's field limit.`);
	assert(syncErrorField.includes(`...and`), `Raid sync error embed field should summarize omitted errors.`);
}

function validateEventFiles() {
	const eventFiles = listFiles(resolveProject(`events`), filePath => filePath.endsWith(`.js`));

	assert(eventFiles.length > 0, `No event files were found.`);

	const eventNames = new Set();

	for (const filePath of eventFiles) {
		const event = requireFresh(relative(filePath));

		assert(event.name, `${relative(filePath)} is missing event name.`);
		assert(typeof event.execute === `function`, `${relative(filePath)} is missing execute().`);
		assert(event.execute.constructor.name === `AsyncFunction`, `${relative(filePath)} execute() should be async.`);

		if (event.once !== undefined) {
			assert(typeof event.once === `boolean`, `${relative(filePath)} once should be a boolean when provided.`);
		}

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
	assert(Object.keys(dbObjects.PendingStreamVods.associations).length > 0,
		`PendingStreamVods model is not tied to configured stream channels.`);
	assert(Object.keys(dbObjects.KickLiveSessions.associations).length > 0 &&
		dbObjects.KickLiveSessions.primaryKeyAttributes.join(`,`) === `channelId`,
	`Each Kick channel should have one durable exact live-start record.`);
	assert(dbObjects.PendingStreamVods.options.indexes.some(index =>
		index.unique && index.fields.join(`,`) === `messageId`),
	`Pending replay rows must be unique per Discord announcement.`);

	return dbObjects;
}

async function validateReusableChannelIds() {
	const Sequelize = require(`sequelize`);
	const { findReusableChannelId } = requireFresh(`database`, `channelIds.js`);
	const database = new Sequelize({ dialect: `sqlite`, storage: `:memory:`, logging: false });

	try {
		for (const table of [`channels`, `streamChannelIdentities`, `kickLiveSessions`, `pendingStreamVods`]) {
			const column = table === `channels` ? `id` : `channelId`;
			await database.query(`CREATE TABLE ${table} (${column} INTEGER NOT NULL)`);
		}
		await database.query(`INSERT INTO channels (id) VALUES (1), (3)`);
		// Simulate an orphan left by an older cleanup. Its ID must never be reused
		// for a different streamer until the child record is repaired or removed.
		await database.query(`INSERT INTO streamChannelIdentities (channelId) VALUES (2)`);
		await database.transaction({ type: Sequelize.Transaction.TYPES.IMMEDIATE }, async transaction => {
			assert(await findReusableChannelId(database, transaction) === 4,
				`An orphaned stream identity did not reserve its former channel ID.`);
			await database.query(`DELETE FROM streamChannelIdentities WHERE channelId = 2`, { transaction });
			assert(await findReusableChannelId(database, transaction) === 2,
				`A safe gap was not reused for a new streamer.`);
		});
	} finally {
		await database.close();
	}
}

async function validateOneOpenModmailTicketIndex() {
	const Sequelize = require(`sequelize`);
	const { ensureOneOpenModmailTicketIndex } = requireFresh(`database`, `dbInit.js`);
	const database = new Sequelize({ dialect: `sqlite`, storage: `:memory:`, logging: false });

	try {
		await database.query(`CREATE TABLE modmailTickets (id INTEGER PRIMARY KEY, guildId TEXT, openerId TEXT, status TEXT)`);
		await database.query(`INSERT INTO modmailTickets (guildId, openerId, status) VALUES ('guild', 'member', 'open')`);
		await ensureOneOpenModmailTicketIndex(database);
		let duplicateRejected = false;
		try {
			await database.query(`INSERT INTO modmailTickets (guildId, openerId, status) VALUES ('guild', 'member', 'open')`);
		} catch (error) {
			duplicateRejected = error.name === `SequelizeUniqueConstraintError`;
		}
		assert(duplicateRejected, `The database accepted a second open ticket for the same member.`);

		await database.query(`DROP INDEX modmailTicketsOneOpenPerUser`);
		await database.query(`INSERT INTO modmailTickets (guildId, openerId, status) VALUES ('guild', 'member', 'open')`);
		await ensureOneOpenModmailTicketIndex(database);
		const [indexes] = await database.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'modmailTicketsOneOpenPerUser'`);
		const [tickets] = await database.query(`SELECT id FROM modmailTickets WHERE guildId = 'guild' AND openerId = 'member' AND status = 'open'`);
		assert(indexes.length === 0 && tickets.length === 2,
			`The index installer altered or blocked legacy duplicate open tickets.`);
	} finally {
		await database.close();
	}
}

async function auditIsolatedDatabase() {
	const sqlite3 = require(`sqlite3`).verbose();
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `hachi-schema-audit-`));
	const dbPath = path.join(tempDir, `audit.sqlite`);

	try {
		await new Promise((resolve, reject) => {
			const database = new sqlite3.Database(dbPath, openError => {
				if (openError) {
					reject(openError);
					return;
				}
				database.close(closeError => closeError ? reject(closeError) : resolve());
			});
		});

		// Build and inspect a disposable schema. Smoke testing must never open an
		// installation's database, even when no journal sidecars are visible.
		const { applyMigration, auditDatabase } = requireFresh(`database`, `dbAudit.js`);
		const migration = await applyMigration({ dbPath });
		const audit = await auditDatabase({ dbPath });
		assert(migration.ok && audit.status === `ok`,
			`Isolated database audit status is ${audit.status}: ${audit.detail}`);

		// A schema rebuild must restore the partial open-ticket guard. Closed
		// tickets from one member are valid and must not block that repair.
		const { openToolDatabase } = requireFresh(`database`, `dbToolConnection.js`);
		const toolDatabase = await openToolDatabase({ dbPath, readonly: false, root: projectRoot });
		try {
			await toolDatabase.exec(`
				INSERT INTO servers (guildId) VALUES ('guild');
				INSERT INTO modmailTickets (guildId, ticketNumber, openerId, status, openedAt)
				VALUES ('guild', 1, 'member', 'closed', '2026-01-01');
				INSERT INTO modmailTickets (guildId, ticketNumber, openerId, status, openedAt)
				VALUES ('guild', 2, 'member', 'closed', '2026-01-02');
				DROP INDEX modmailTicketsOneOpenPerUser;
			`);
		} finally {
			await toolDatabase.close();
		}
		const drift = await auditDatabase({ dbPath });
		assert(drift.safeIssues.some(issue => issue.id === `modmailTickets:modmailTicketsOneOpenPerUser:index-mismatch`) &&
			!drift.forceIssues.some(issue => issue.table === `modmailTickets`),
		`Audit did not identify the missing partial Modmail index as a safe repair.`);
		const repaired = await applyMigration({ dbPath });
		assert(repaired.ok, `The partial Modmail index was not repaired by migration.`);
		const verifiedDatabase = await openToolDatabase({ dbPath, readonly: true, root: projectRoot });
		try {
			const index = await verifiedDatabase.get(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'modmailTicketsOneOpenPerUser'`);
			const ticketCount = await verifiedDatabase.get(`SELECT COUNT(*) AS count FROM modmailTickets WHERE guildId = 'guild' AND openerId = 'member'`);
			assert(index?.sql?.includes(`WHERE "status" = 'open'`) && Number(ticketCount.count) === 2,
				`Migration lost the open-ticket predicate or existing closed tickets.`);
		} finally {
			await verifiedDatabase.close();
		}
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
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
	assert(pkg.scripts?.check === `node scripts/syntaxCheck.js`, `package.json is missing the check script.`);
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
		`.github/workflows/release-hachi.yml`,
		`README.md`,
		`blank.env`,
		`config/blank.json`,
		`config/configCheck.js`,
		`database/dbAudit.js`,
		`database/dbInit.js`,
		`docs/_config.yml`,
		`docs/patch-notes.md`,
		`scripts/releaseCheck.js`,
		`scripts/validateReleaseMetadata.js`,
		`docs/privacy-policy.md`,
		`docs/terms-and-conditions.md`,
		`events/guildDelete.js`,
		`events/ready.js`,
		`index.js`,
		`scripts/syntaxCheck.js`,
	];

	for (const file of requiredFiles) {
		assert(fs.existsSync(resolveProject(file)), `Missing required project file: ${file}.`);
	}

	assert(fs.existsSync(resolveProject(`commands`, `globalCommands`)), `Missing global command directory.`);
	assert(fs.existsSync(resolveProject(`commands`, `guildCommands`)), `Missing guild command directory.`);
	assert(fs.existsSync(resolveProject(`commands`, `globalCommands`, `utility`, `twitch.js`)), `Missing /twitch command file.`);
	assert(!fs.existsSync(resolveProject(`commands`, `globalCommands`, `utility`, `twitchroles.js`)), `Old twitchroles command file still exists.`);

	const docsIndex = fs.readFileSync(resolveProject(`docs`, `index.md`), `utf8`);
	const patchNotes = fs.readFileSync(resolveProject(`docs`, `patch-notes.md`), `utf8`);
	const releaseCheck = fs.readFileSync(resolveProject(`scripts`, `releaseCheck.js`), `utf8`);
	const pagesConfig = fs.readFileSync(resolveProject(`docs`, `_config.yml`), `utf8`);
	const ciWorkflow = fs.readFileSync(resolveProject(`.github`, `workflows`, `ci.yml`), `utf8`);
	const hachiReleaseWorkflow = fs.readFileSync(resolveProject(`.github`, `workflows`, `release-hachi.yml`), `utf8`);
	const currentReleaseTag = `hachi-v${readJson(`package.json`).version}`;
	requireFresh(`scripts`, `validateReleaseMetadata.js`).validateReleaseMetadata(currentReleaseTag, projectRoot);
	assert(readJson(`package.json`).scripts?.[`release:check`] === `node scripts/releaseCheck.js`, `package.json should expose the release preparation check.`);
	assert(releaseCheck.includes("branch === `main`"), `Release preparation should refuse to run on main.`);
	assert(!/^## Hachi$/mu.test(patchNotes), `docs/patch-notes.md should not embed redundant Hachi product sections.`);
	assert(!/^## HachiGen$/mu.test(patchNotes), `docs/patch-notes.md should not embed HachiGen release sections.`);
	assert(docsIndex.includes(`https://github.com/FearlessKenji/Hachi/blob/main/CHANGELOG.md`), `docs/index.md should link to the root changelog.`);
	assert(docsIndex.includes(`patch-notes.html`), `docs/index.md should link to user-facing patch notes.`);
	assert(pagesConfig.includes(`theme: jekyll-theme-midnight`), `docs/_config.yml should use the Midnight GitHub Pages theme.`);
	assert(hachiReleaseWorkflow.includes(`branches:`) && hachiReleaseWorkflow.includes(`main`), `Hachi release workflow should run when main changes.`);
	assert(ciWorkflow.includes(`name: check`) && ciWorkflow.includes(`npm run check`), `Hachi CI should run the syntax check job.`);
	assert(hachiReleaseWorkflow.includes(`"hachi-v*"`) &&
		hachiReleaseWorkflow.includes(`node scripts/validateReleaseMetadata.js $tag`),
	`Hachi release workflow should validate hachi-v* tags against package metadata.`);
	assert(hachiReleaseWorkflow.includes(`release_title=Hachi v$version`), `Hachi release workflow should title releases as Hachi vX.X.X.`);
	assert(!hachiReleaseWorkflow.includes(`HachiGen.exe`), `Hachi release workflow should not upload HachiGen.exe.`);
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

function validateConfigCheckInIsolatedFixture() {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `hachi-config-check-`));
	const configPath = path.join(tempDir, `config`, `config.json`);
	const config = readJson(`config`, `blank.json`);
	const configCheckPath = resolveProject(`config`, `configCheck.js`);
	const fixtureEnvironment = {
		TOKEN: `smoke-token`,
		clientId: `smoke-client-id`,
		HACHI_DB_ENCRYPTION: `encrypted`,
		HACHI_DB_KEY: `smoke-db-key`,
		HACHI_SECRETS_ENCRYPTION: `encrypted`,
		HACHI_SECRETS_KEY: `smoke-secret-key`,
		kickClientId: `smoke-kick-client-id`,
		kickSecret: `smoke-kick-secret`,
		twitchClientId: `smoke-twitch-client-id`,
		twitchSecret: `smoke-twitch-secret`,
	};
	config.botOwners = [`111111111111111111`];
	config.guildIds = [`222222222222222222`];

	try {
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
		const runConfigCheck = () => spawnNode([`-e`, `require(${JSON.stringify(configCheckPath)})`], {
			cwd: tempDir,
			env: fixtureEnvironment,
		});
		const validResult = runConfigCheck();
		assert(validResult.status === 0, `configCheck failed on an isolated fixture:\n${validResult.stdout}${validResult.stderr}`);

		config.twitchCron = `invalid cron expression`;
		fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
		const invalidResult = runConfigCheck();
		assert(invalidResult.status === 78 && `${invalidResult.stdout}${invalidResult.stderr}`.includes(`twitchCron`),
			`configCheck did not identify an invalid configured cron expression.`);
	} finally {
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
}

async function validateProviderAppTokenRequests() {
	const previousFetch = global.fetch;
	const capturedRequests = [];
	const { fetchAuthToken } = requireFresh(`auth`, `fetchAuthToken.js`);
	const providers = [
		{ provider: `Twitch`, tokenUrl: `https://id.twitch.tv/oauth2/token` },
		{ provider: `Kick`, tokenUrl: `https://id.kick.com/oauth/token` },
	];

	try {
		global.fetch = async (url, options) => {
			capturedRequests.push({ url, options });
			return { ok: true, json: async () => ({ access_token: `smoke-app-token` }) };
		};

		for (const { provider, tokenUrl } of providers) {
			const token = await fetchAuthToken({
				provider,
				tokenUrl,
				clientID: `client id`,
				clientSecret: `secret+with&symbols`,
			});
			assert(token === `smoke-app-token`, `${provider} app-token response was not accepted.`);
		}

		for (const [index, request] of capturedRequests.entries()) {
			const provider = providers[index];
			const form = new URLSearchParams(request.options.body);
			assert(request.url === provider.tokenUrl && !String(request.url).includes(`secret`),
				`${provider.provider} token credentials appeared in the request URL.`);
			assert(request.options.method === `POST` &&
				request.options.headers?.[`Content-Type`] === `application/x-www-form-urlencoded`,
			`${provider.provider} token request did not use a form-encoded POST.`);
			assert(request.options.signal instanceof globalThis.AbortSignal,
				`${provider.provider} token request did not include a timeout signal.`);
			assert(form.get(`client_id`) === `client id` &&
				form.get(`client_secret`) === `secret+with&symbols` &&
				form.get(`grant_type`) === `client_credentials`,
			`${provider.provider} token request did not preserve client credentials in the form body.`);
		}
	} finally {
		global.fetch = previousFetch;
	}
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

function adapterRun(database, sql, params = []) {
	return new Promise((resolve, reject) => {
		database.run(sql, params, function onRun(error) {
			if (error) {
				reject(error);
				return;
			}

			resolve(this);
		});
	});
}

function adapterGet(database, sql, params = []) {
	return new Promise((resolve, reject) => {
		database.get(sql, params, (error, row) => {
			if (error) {
				reject(error);
				return;
			}

			resolve(row);
		});
	});
}

function adapterClose(database) {
	return new Promise((resolve, reject) => {
		database.close(error => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}

async function validateSqlcipherAdapterBindNormalization() {
	const dialectModule = requireFresh(`database`, `sqlcipherSqlite3.js`);
	const { databaseFileStatus } = requireFresh(`database`, `dbEncryption.js`);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `hachi-adapter-bind-`));
	const dbPath = path.join(tempDir, `adapter.sqlite`);
	const previousKey = process.env.HACHI_DB_KEY;
	const previousKeyFile = process.env.HACHI_DB_KEY_FILE;
	let database = null;

	try {
		const initialDate = new Date(`2026-07-13T12:00:00.000Z`);
		const updatedDate = new Date(`2026-07-13T12:05:00.000Z`);
		process.env.HACHI_DB_KEY = `smoke-adapter-${Date.now()}`;
		delete process.env.HACHI_DB_KEY_FILE;

		database = new dialectModule.Database(dbPath);
		await adapterRun(database, `CREATE TABLE sample (id INTEGER PRIMARY KEY, isLive INTEGER NOT NULL, checkedAt TEXT, note TEXT)`);
		await adapterRun(database, `INSERT INTO sample (isLive, checkedAt, note) VALUES ($isLive, :checkedAt, @note)`, {
			$isLive: true,
			':checkedAt': initialDate,
			'@note': `named`,
		});
		await adapterRun(database, `UPDATE sample SET isLive = ?, checkedAt = ? WHERE note = ?`, [false, updatedDate, `named`]);
		const row = await adapterGet(database, `SELECT isLive, checkedAt, note FROM sample WHERE note = $note`, { $note: `named` });

		assert(row?.isLive === 0, `SQLCipher adapter did not normalize a boolean bind value.`);
		assert(row?.checkedAt === updatedDate.toISOString(), `SQLCipher adapter did not normalize a Date bind value.`);
		assert(row?.note === `named`, `SQLCipher adapter did not normalize named bind prefixes.`);
		await adapterClose(database);
		database = null;

		const status = databaseFileStatus(dbPath);
		assert(status.encryptedLikely, `SQLCipher adapter bind test database was created with a plain SQLite header.`);
	} finally {
		if (database) {
			await adapterClose(database).catch(() => null);
		}

		restoreEnvValue(`HACHI_DB_KEY`, previousKey);
		restoreEnvValue(`HACHI_DB_KEY_FILE`, previousKeyFile);

		fs.rmSync(tempDir, { force: true, recursive: true });
	}
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
			isLive: {
				allowNull: false,
				defaultValue: false,
				type: Sequelize.BOOLEAN,
			},
			checkedAt: {
				allowNull: true,
				type: Sequelize.DATE,
			},
		}, { timestamps: false });
		await sequelize.sync();
		const liveRow = await Sample.create({ checkedAt: new Date(`2026-07-13T10:00:00.000Z`), isLive: true, value: `ok` });
		await liveRow.update({ checkedAt: new Date(`2026-07-13T10:01:00.000Z`), isLive: false });
		await sequelize.transaction(async transaction => {
			await Sample.create({ isLive: true, value: `tx` }, { transaction });
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
			isLive: {
				allowNull: false,
				defaultValue: false,
				type: Sequelize.BOOLEAN,
			},
			checkedAt: {
				allowNull: true,
				type: Sequelize.DATE,
			},
		}, { timestamps: false });
		const row = await ReopenedSample.findOne({ where: { value: `ok` } });
		const transactionRow = await ReopenedSample.findOne({ where: { value: `tx` } });

		assert(row?.get(`value`) === `ok`, `Encrypted runtime database did not reopen through Sequelize.`);
		assert(row?.get(`isLive`) === false, `Encrypted runtime boolean update did not persist.`);
		assert(row?.get(`checkedAt`) instanceof Date, `Encrypted runtime Date bind did not persist as a Date value.`);
		assert(transactionRow?.get(`value`) === `tx`, `Encrypted runtime transaction row did not persist.`);
		assert(transactionRow?.get(`isLive`) === true, `Encrypted runtime transaction boolean did not persist.`);
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

async function validateToolDatabaseConnectionPromises() {
	const {
		openSqlCipherDatabase,
	} = requireFresh(`database`, `dbEncryption.js`);
	const {
		all,
		closeDatabase,
		exec,
		get,
		openToolDatabase,
	} = requireFresh(`database`, `dbToolConnection.js`);
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `hachi-tool-db-`));
	const dbPath = path.join(tempDir, `database.sqlite`);
	const key = `smoke-tool-${Date.now()}`;
	let toolDb = null;

	try {
		const setupDb = openSqlCipherDatabase({
			dbPath,
			fileMustExist: false,
			key,
			root: projectRoot,
		});
		setupDb.exec(`CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`);
		setupDb.close();

		fs.writeFileSync(path.join(tempDir, `.env`), `HACHI_DB_KEY=${key}\n`, `utf8`);

		toolDb = await openToolDatabase({
			dbPath,
			envPath: path.join(tempDir, `.env`),
			root: projectRoot,
		});
		const execResult = exec(toolDb, `INSERT INTO sample (value) VALUES ('ok')`);

		assert(typeof execResult?.then === `function`, `Encrypted tool database exec() did not return a Promise.`);
		await execResult;
		await exec(toolDb, `BEGIN IMMEDIATE TRANSACTION`);
		await exec(toolDb, `ROLLBACK`).catch(() => null);

		const row = await get(toolDb, `SELECT value FROM sample WHERE id = ?`, [1]);

		assert(row?.value === `ok`, `Encrypted tool database get() did not read inserted data.`);

		const allResult = all(toolDb, `SELECT value FROM sample ORDER BY id`);

		assert(typeof allResult?.then === `function`, `Encrypted tool database all() did not return a Promise.`);
		assert((await allResult)[0]?.value === `ok`, `Encrypted tool database all() did not read inserted data.`);

		const closeResult = closeDatabase(toolDb);

		assert(typeof closeResult?.then === `function`, `Encrypted tool database close() did not return a Promise.`);
		await closeResult;
		toolDb = null;
	} finally {
		if (toolDb) {
			await closeDatabase(toolDb).catch(() => null);
		}

		fs.rmSync(tempDir, { force: true, recursive: true });
	}
}

function validatePureHelpers() {
	const { DateTime } = require(`luxon`);
	const { birthdayAutocompletes, timezoneAutocompletes } = requireFresh(`utils`, `autocompletes.js`);
	const {
		buildCreateCardButton,
		buildBirthdayPanelComponents,
		deriveBirthdayDeliveryUrl,
		formatBoardEntry,
		getBirthdayBoardRefreshAction,
		getBirthdayNotificationUserIds,
		getNewBirthdayAnnouncementAction,
		getPendingUpcomingBirthdayEntries,
		IMMEDIATE_BIRTHDAY_REMINDER_DAYS,
		normalizeBirthdayCardUrl,
		pendingBirthdayCardDeliveryCandidates,
		selectBirthdayCardDeliveryGuild,
		shouldSendLateBirthdayCard,
		UPCOMING_BIRTHDAY_DAYS,
	} = requireFresh(`utils`, `birthdays.js`);
	const { normalizeColorInput } = requireFresh(`utils`, `colors.js`);
	const { dateToString } = requireFresh(`utils`, `dateToString.js`);
	const {
		formatPatchNotesMessages,
		parseLatestPatchNotes,
		parsePatchNoteReleases,
		selectPatchNotesForAnnouncement,
	} = requireFresh(`utils`, `announcements.js`);
	const {
		buildFixedSocialLinks,
		fixSocialUrl,
		normalizeDomain,
		RECOMMENDED_FIX_RULES,
	} = requireFresh(`utils`, `socialLinks.js`);
	const { findKickVodUrl } = requireFresh(`modules`, `getKick.js`);
	const {
		domainKeyword,
		expandAffiliateDomains,
		MAX_BLOCKED_DOMAINS,
		syncAllLinkBlockRules,
	} = requireFresh(`utils`, `linkBlocking.js`);
	const { isSecurityPolicyBlock } = requireFresh(`modules`, `kickVods.js`);
	const {
		getEventSubWebSocketUrlRejectionReason,
		normalizeEventSubWebSocketUrl,
	} = requireFresh(`modules`, `twitchRoleEventSub.js`);
	const { offlineEmbed, vodWaitExpired } = requireFresh(`modules`, `streamUtils.js`);
	const serverLifecycle = requireFresh(`utils`, `serverLifecycle.js`);
	const {
		getTimezoneChoicesForRegion,
		getTimezoneRegionId,
	} = requireFresh(`utils`, `timezones.js`);

	assert(typeof serverLifecycle.reconcileServerRows === `function`, `server lifecycle reconciliation helper is missing.`);
	assert(typeof serverLifecycle.markServerLeft === `function`, `server lifecycle leave tracker is missing.`);
	assert(
		fixSocialUrl(`https://www.instagram.com/reel/DbAO3edgEWh/?igsh=tracking`, RECOMMENDED_FIX_RULES)?.url ===
		`https://www.kkinstagram.com/reel/DbAO3edgEWh/`,
		`Instagram link fixing did not remove tracking data.`,
	);
	assert(
		fixSocialUrl(`https://www.facebook.com/watch/?v=1481060365360701`, RECOMMENDED_FIX_RULES) === null,
		`Facebook unexpectedly remained a recommended link-fixing provider.`,
	);
	const fixedSocialLinks = buildFixedSocialLinks([
		`https://www.tiktok.com/@example/video/123?tracking=one`,
		`https://www.instagram.com/reel/DbAO3edgEWh/?igsh=one`,
		`https://www.instagram.com/reel/DbAO3edgEWh/?igsh=duplicate`,
	].join(`\n`), RECOMMENDED_FIX_RULES);

	assert(fixedSocialLinks.links.length === 2, `Social-link fixing did not remove a canonical duplicate.`);
	assert(
		fixedSocialLinks.content === [
			`https://kktiktok.com/@example/video/123`,
			`https://www.kkinstagram.com/reel/DbAO3edgEWh/`,
		].join(`\n`),
		`Fixed social links did not expose their replacement URLs.`,
	);
	const customFixedLinks = buildFixedSocialLinks(
		`https://www.example.com/one?tracking=yes\nhttps://example.com/two?tracking=yes`,
		[{ sourceDomain: `example.com`, targetDomain: `embed.example.net` }],
	);
	assert(
		customFixedLinks.content === [
			`https://embed.example.net/one`,
			`https://embed.example.net/two`,
		].join(`\n`),
		`Custom fixed links did not expose their replacement URLs.`,
	);
	assert(normalizeDomain(`Instagram.com`) === `instagram.com`, `Domain normalization failed.`);
	assert(normalizeDomain(`https://instagram.com`) === null, `Domain normalization accepted a URL.`);
	assert(normalizeDomain(`127.0.0.1`) === null, `Domain normalization accepted an IPv4 address.`);
	assert(domainKeyword(`blocked.example`) === `*blocked.example*`, `Blocked-domain wildcard was not generated correctly.`);
	assert(MAX_BLOCKED_DOMAINS === 100, `Blocked-domain keyword capacity does not match Discord's limit.`);
	assert(typeof syncAllLinkBlockRules === `function`, `Periodic link-block synchronization helper is missing.`);
	assert(
		expandAffiliateDomains(`www.instagram.com`).join(`|`) === `instagram.com|kkinstagram.com`,
		`Instagram affiliate blocking did not include its embed provider.`,
	);
	assert(
		expandAffiliateDomains(`facecot.com`).join(`|`) === `facebook.com|facecot.com`,
		`Facebook affiliate blocking was not bidirectional.`,
	);
	assert(
		expandAffiliateDomains(`example.com`, [{ sourceDomain: `example.com`, targetDomain: `embed.example.net` }]).join(`|`) ===
		`embed.example.net|example.com`,
		`Configured link-fixing affiliates were not expanded.`,
	);
	assert(birthdayAutocompletes(`jan`).some(choice => choice.value === `January`), `Birthday autocomplete did not find January.`);
	assert(UPCOMING_BIRTHDAY_DAYS === 14, `Birthday board upcoming window should stay at two weeks.`);
	const birthdayPanelWithoutCard = buildBirthdayPanelComponents({ dayRoleId: null }, [
		{ daysAway: 3, card: null },
		{ daysAway: 0, card: {} },
	]).toJSON();
	const birthdayPanelWithCard = buildBirthdayPanelComponents({ dayRoleId: `456` }, [
		{ daysAway: 3, card: {} },
	]).toJSON();

	assert(
		birthdayPanelWithoutCard.components.length === 1 &&
		birthdayPanelWithoutCard.components[0].custom_id === `birthday:panel:set`,
		`Birthday board showed the signing button without an upcoming card.`,
	);
	assert(
		birthdayPanelWithCard.components.some(component =>
			component.custom_id === `birthday:panel:sign` && component.label === `Sign Upcoming Card`,
		),
		`Birthday board did not show the signing button for an upcoming card.`,
	);
	assert(
		birthdayPanelWithCard.components.some(component =>
			component.custom_id === `birthday:panel:toggleDayRole` && component.label === `Toggle Birthday Pings`,
		),
		`Birthday board did not show the configured Day of Birthday Role toggle.`,
	);
	assert(IMMEDIATE_BIRTHDAY_REMINDER_DAYS === 2, `Urgent birthday reminder window should stay at two days.`);
	const birthdayReminderNow = DateTime.fromISO(`2026-09-01T12:00:00`, { zone: `UTC` });
	const pendingBirthdayReminders = getPendingUpcomingBirthdayEntries([
		{ day: 2, guildId: `guild`, month: 9, userId: `one` },
		{ day: 3, guildId: `guild`, month: 9, userId: `two` },
		{ day: 15, guildId: `guild`, month: 9, userId: `fourteen` },
		{ day: 16, guildId: `guild`, month: 9, userId: `fifteen` },
		{ day: 5, guildId: `guild`, lastUpcomingReminderDate: `2026-09-05`, month: 9, userId: `sent` },
	], birthdayReminderNow);

	assert(
		pendingBirthdayReminders.map(entry => entry.userId).join(`,`) === `one,two,fourteen`,
		`Upcoming birthday reminders did not include the full unannounced two-week window.`,
	);
	assert(getNewBirthdayAnnouncementAction(2, 1, 12) === `upcoming`, `Two-day birthday reminder was not immediate.`);
	assert(getNewBirthdayAnnouncementAction(3, 13, 12) === null, `Non-urgent birthday reminder did not wait for the schedule.`);
	assert(getNewBirthdayAnnouncementAction(0, 13, 12) === `birthday`, `Late same-day birthday did not announce immediately.`);
	assert(getNewBirthdayAnnouncementAction(0, 11, 12) === null, `Early same-day birthday did not wait for the schedule.`);
	const deliveryCard = { guildId: `200`, userId: `birthday-user`, year: 2026 };
	const tiedDeliveryCandidates = [
		{ guildId: `100`, scheduledAt: DateTime.fromISO(`2026-09-22T12:00:00Z`) },
		{ guildId: `200`, scheduledAt: DateTime.fromISO(`2026-09-22T12:00:00Z`) },
	];

	assert(
		selectBirthdayCardDeliveryGuild(deliveryCard, tiedDeliveryCandidates) === `200`,
		`The card-owning server did not win an equal-time birthday delivery tie.`,
	);
	assert(
		selectBirthdayCardDeliveryGuild({ ...deliveryCard, guildId: `300` }, tiedDeliveryCandidates) === `100`,
		`Equal-time birthday delivery did not fall back to the stable lowest guild ID.`,
	);
	assert(
		selectBirthdayCardDeliveryGuild(deliveryCard, [
			...tiedDeliveryCandidates,
			{ guildId: `400`, scheduledAt: DateTime.fromISO(`2026-09-22T11:00:00Z`) },
		]) === `400`,
		`Birthday card delivery did not select the earliest absolute posting time.`,
	);
	const pendingDeliveryCandidates = pendingBirthdayCardDeliveryCandidates([
		{ guildId: `100`, lastBirthdayAnnouncementDate: `2026-09-22`, scheduledAt: DateTime.fromISO(`2026-09-22T10:00:00Z`) },
		{ guildId: `200`, lastBirthdayAnnouncementDate: null, scheduledAt: DateTime.fromISO(`2026-09-22T11:00:00Z`) },
		{ guildId: `300`, lastBirthdayAnnouncementDate: null, scheduledAt: DateTime.fromISO(`2026-09-22T12:00:00Z`) },
	], DateTime.fromISO(`2026-09-22T10:30:00Z`));

	assert(
		selectBirthdayCardDeliveryGuild(deliveryCard, pendingDeliveryCandidates) === `200`,
		`Birthday card notification could be assigned to a server that already posted.`,
	);
	assert(
		pendingBirthdayCardDeliveryCandidates([
			{ guildId: `100`, lastBirthdayAnnouncementDate: null, scheduledAt: DateTime.fromISO(`2026-09-22T10:00:00Z`) },
		], DateTime.fromISO(`2026-09-22T10:30:00Z`), `100`).length === 1,
		`A newly stored same-day birthday was excluded after its server posting hour.`,
	);
	const lateCardDate = DateTime.fromISO(`2026-09-22T18:00:00Z`);
	const lateCard = { year: 2026, deliveryGuildId: null, notificationDeliveredAt: null };
	const postedBirthday = { month: 9, day: 22, lastBirthdayAnnouncementDate: `2026-09-22` };

	assert(shouldSendLateBirthdayCard(lateCard, postedBirthday, lateCardDate), `A card set after today's birthday post was not eligible for delivery.`);
	assert(!shouldSendLateBirthdayCard({ ...lateCard, notificationDeliveredAt: new Date() }, postedBirthday, lateCardDate),
		`An already delivered birthday card could be notified again.`);
	assert(!shouldSendLateBirthdayCard(lateCard, { ...postedBirthday, day: 23 }, lateCardDate),
		`A card was eligible for late delivery before the member's birthday.`);
	const notificationCards = new Map([
		[`winner`, { deliveryGuildId: `100`, notificationDeliveredAt: null }],
		[`later`, { deliveryGuildId: `200`, notificationDeliveredAt: null }],
		[`delivered`, { deliveryGuildId: `100`, notificationDeliveredAt: new Date() }],
	]);

	assert(
		getBirthdayNotificationUserIds([
			{ userId: `winner` },
			{ userId: `later` },
			{ userId: `delivered` },
			{ userId: `no-card` },
		], notificationCards, `100`).join(`,`) === `winner,no-card`,
		`Birthday notification filtering did not limit global-card pings to the selected server.`,
	);
	assert(
		getBirthdayBoardRefreshAction({ boardOnlyWhenUpcoming: false }, [], null) === `replace`,
		`Daily Birthday Board mode did not preserve daily replacement behavior.`,
	);
	assert(
		getBirthdayBoardRefreshAction({ boardOnlyWhenUpcoming: true }, [], null) === `remove`,
		`Upcoming-only Birthday Board mode did not stay quiet without upcoming birthdays.`,
	);
	assert(
		getBirthdayBoardRefreshAction({ boardOnlyWhenUpcoming: true }, [{}], { edit: () => true }) === `edit`,
		`Card updates did not edit the existing upcoming-only Birthday Board.`,
	);
	assert(
		getBirthdayBoardRefreshAction({ boardOnlyWhenUpcoming: true }, [{}], { edit: () => true }, { scheduled: true }) === `replace`,
		`Upcoming-only Birthday Board mode did not post a fresh daily board.`,
	);
	assert(
		getBirthdayBoardRefreshAction({ boardOnlyWhenUpcoming: true }, [], null, { hadBirthdayYesterday: true, scheduled: true }) === `replace`,
		`Upcoming-only Birthday Board mode did not post on the day after a birthday.`,
	);
	const birthdayCommandSource = fs.readFileSync(resolveProject(`commands`, `globalCommands`, `utility`, `birthday.js`), `utf8`);

	assert(
		birthdayCommandSource.includes(`You will now receive birthday pings when it's someone's birthday.`) &&
		birthdayCommandSource.includes(`You will no longer receive pings on birthdays.`),
		`Birthday ping role feedback does not match the intended member-facing wording.`,
	);
	const createCardButton = buildCreateCardButton().toJSON().components[0];

	assert(
		createCardButton.label === `Create a Card` &&
		createCardButton.url === `https://recocards.com/create-card/HAPPY_BIRTHDAY`,
		`Upcoming birthday reminder is missing the direct RecoCards creation link.`,
	);
	const birthdayBoardEntry = {
		card: { boardUrl: `https://recocards.com/board/smoke` },
		date: { toFormat: () => `Aug 25` },
		daysAway: 4,
		mention: `<@123>`,
	};

	assert(
		formatBoardEntry(birthdayBoardEntry) === `**Aug 25 (in 4 days)** - <@123> (has card)`,
		`Birthday board entry did not show its saved-card status.`,
	);
	assert(
		formatBoardEntry({ ...birthdayBoardEntry, card: null }) === `**Aug 25 (in 4 days)** - <@123> (no card set)`,
		`Birthday board entry did not show its missing-card status.`,
	);
	assert(
		formatBoardEntry({ ...birthdayBoardEntry, daysAway: 0 }) === `**Today** - <@123>`,
		`Today's birthday board entry unexpectedly showed a card status.`,
	);
	assert(
		normalizeBirthdayCardUrl(`https://recocards.com/board/happy-birthday-smoke-123`) ===
		`https://recocards.com/board/happy-birthday-smoke-123`,
		`Birthday card URL validation rejected a RecoCards board link.`,
	);
	assert(
		deriveBirthdayDeliveryUrl(`https://recocards.com/board/happy-birthday-smoke-123`) ===
		`https://recocards.com/view/b/happy-birthday-smoke-123`,
		`Birthday delivery URL derivation did not convert a RecoCards board link.`,
	);
	assert(normalizeBirthdayCardUrl(`https://example.com/board/nope`) === null, `Birthday card URL validation accepted an untrusted host.`);
	assert(deriveBirthdayDeliveryUrl(`https://example.com/board/nope`) === null, `Birthday delivery URL derivation accepted an untrusted host.`);
	assert(timezoneAutocompletes(`new_york`).some(choice => choice.value === `America/New_York`), `Timezone autocomplete did not find America/New_York.`);
	assert(normalizeColorInput(`#abc`)?.color === 0xaabbcc, `Short hex color normalization failed.`);
	assert(getTimezoneRegionId(`America/New_York`) === `us`, `Timezone region detection failed.`);
	assert(getTimezoneChoicesForRegion(`us`).length <= 25, `Timezone region choices exceed Discord limit.`);
	assert(isSecurityPolicyBlock(403, `Request blocked by security policy.`), `Kick security-policy block detection failed.`);
	assert(findKickVodUrl({
		fields: [{ name: `Kick`, value: `[Watch VoD](https://kick.com/piratesoftware/videos/smoke_vod)` }],
	}) === `https://kick.com/piratesoftware/videos/smoke_vod`, `Kick VoD URL detection failed.`);
	assert(
		normalizeEventSubWebSocketUrl(`wss://eventsub.wss.twitch.tv/ws?session_id=smoke`) ===
		`wss://eventsub.wss.twitch.tv/ws?session_id=smoke`,
		`Twitch EventSub WebSocket URL validation rejected the canonical endpoint.`,
	);
	assert(
		normalizeEventSubWebSocketUrl(`wss://127.0.0.1/ws?session_id=smoke`) === null,
		`Twitch EventSub WebSocket URL validation accepted an internal host.`,
	);
	assert(
		normalizeEventSubWebSocketUrl(`https://eventsub.wss.twitch.tv/ws?session_id=smoke`) === null,
		`Twitch EventSub WebSocket URL validation accepted a non-WebSocket scheme.`,
	);
	assert(
		getEventSubWebSocketUrlRejectionReason(`https://eventsub.wss.twitch.tv/ws?session_id=smoke`).includes(`protocol https:`),
		`Twitch EventSub WebSocket rejection reason should explain rejected protocols.`,
	);
	assert(
		getEventSubWebSocketUrlRejectionReason(`wss://127.0.0.1/ws?session_id=smoke`).includes(`host 127.0.0.1`),
		`Twitch EventSub WebSocket rejection reason should explain rejected hosts.`,
	);
	const fragmentRejectionReason = getEventSubWebSocketUrlRejectionReason(
		`wss://eventsub.wss.twitch.tv/ws?session_id=sensitive_smoke#fragment`,
	);

	assert(fragmentRejectionReason === `URL includes a fragment`, `Twitch EventSub WebSocket rejection reason should explain fragments.`);
	assert(!fragmentRejectionReason.includes(`sensitive_smoke`), `Twitch EventSub WebSocket rejection reason should not include query values.`);
	for (const [provider, streamUrl, vodUrl] of [
		[`Twitch`, `https://www.twitch.tv/piratesoftware`, `https://www.twitch.tv/videos/smoke_vod`],
		[`Kick`, `https://kick.com/piratesoftware`, `https://kick.com/piratesoftware/videos/smoke_vod`],
	]) {
		const pendingEmbed = offlineEmbed({
			existingEmbed: {
				title: `PirateSoftware is now live`,
				url: streamUrl,
				fields: [{ name: provider, value: `[Watch stream](${streamUrl})` }],
				footer: { text: `Started 10/23/2026, 4:09 AM EDT. Last edited 10/23/2026, 4:46 PM EDT.` },
			},
			provider,
			vodUrl: null,
		}).toJSON();

		assert(pendingEmbed.title === `PirateSoftware was live`, `${provider} pending VoD embed still claims the stream is live.`);
		assert(pendingEmbed.fields.find(field => field.name === provider)?.value === `Fetching VoD...`,
			`${provider} pending VoD embed did not show its retry status.`);
		assert(pendingEmbed.footer.text.startsWith(`Started 10/23/2026, 4:09 AM EDT. Stream ended `) &&
			!pendingEmbed.footer.text.includes(`Stream ended at `) &&
			!pendingEmbed.footer.text.includes(`Last edited`), `${provider} offline footer did not record the stream end.`);
		assert(!pendingEmbed.url, `${provider} pending VoD embed linked to an unavailable replay.`);
		const unavailableEmbed = offlineEmbed({
			provider,
			existingEmbed: pendingEmbed,
			vodUnavailable: true,
		}).toJSON();
		assert(unavailableEmbed.fields.find(field => field.name === provider)?.value === `No VoD available` &&
			unavailableEmbed.footer.text === pendingEmbed.footer.text && !unavailableEmbed.url,
		`${provider} expired VoD embed did not preserve the end time and remove the pending status.`);

		const completeEmbed = offlineEmbed({ provider, existingEmbed: pendingEmbed, vodUrl }).toJSON();

		assert(completeEmbed.fields.find(field => field.name === provider)?.value === `[Watch VoD](${vodUrl})`,
			`${provider} replay embed did not replace its pending status with the VoD link.`);
		assert(completeEmbed.url === vodUrl, `${provider} replay embed did not link its title to the VoD.`);
		assert(completeEmbed.footer.text === pendingEmbed.footer.text,
			`${provider} replay update changed the previously recorded end time.`);
	}
	const endedAt = new Date(`2026-10-23T12:00:00Z`);
	assert(!vodWaitExpired(endedAt, new Date(`2026-10-23T17:59:59Z`)) &&
		vodWaitExpired(endedAt, new Date(`2026-10-23T18:00:00Z`)),
	`The missing VoD status should begin six hours after the detected end.`);
	const latestPatchNotes = parseLatestPatchNotes(`# Unreleased

- Draft manager note.

# v3.3.1 - 2026-07-12

### Reliability

- Released note.
`);
	assert(latestPatchNotes?.id === `v3.3.1`, `Patch-note parser should skip Unreleased sections.`);
	assert(!latestPatchNotes.body.includes(`Draft manager note`), `Patch-note parser included Unreleased content.`);
	const patchNoteMessage = formatPatchNotesMessages(latestPatchNotes)[0] || ``;
	assert(patchNoteMessage.startsWith(`## Hachi v3.3.1 - 2026-07-12`), `Patch-note announcement should use a single Discord product release heading.`);
	assert(patchNoteMessage.includes(`### Reliability`), `Patch-note announcement should preserve release category headings.`);
	assert(!patchNoteMessage.includes(`## HachiGen`), `Hachi patch-note formatter should not invent HachiGen sections.`);
	const splitPatchNoteMessages = formatPatchNotesMessages({
		heading: `v9.9.9 - 2026-07-24`,
		body: `### Long Notes\n\n- ${`Long patch note. `.repeat(180)}`,
	});

	assert(splitPatchNoteMessages.length > 1, `Long patch-note announcements should split into multiple messages.`);
	assert(!splitPatchNoteMessages.some(message => /_Part \d+\/\d+_/u.test(message)), `Split patch-note announcements should not add Part X/Y labels.`);
	const { summarizeResults } = requireFresh(`commands`, `globalCommands`, `admin`, `announce.js`);
	const summarizedBroadcast = summarizeResults([
		...Array.from({ length: 12 }, (_, index) => ({
			guildId: `success-${index + 1}`,
			message: `Delivered.`,
			ok: true,
			skipped: false,
		})),
		{ guildId: `skipped-server`, guildName: `Skipped Guild`, message: `Already sent.`, ok: true, skipped: true },
		{ guildId: `failed-server`, guildName: `Failed Guild`, message: `Missing access.`, ok: false, skipped: false },
		{ guildId: `long-failure`, guildName: `Long Failure Guild`, message: `x`.repeat(2000), ok: false, skipped: false },
	]);
	const completeBroadcastSummary = summarizedBroadcast.join(`\n`);

	assert(summarizedBroadcast.every(message => message.length <= 1900), `Patch-note summaries should stay within Discord's safe message length.`);
	assert(completeBroadcastSummary.includes(`Sent: 12`), `Patch-note summaries should condense successful deliveries into the sent total.`);
	assert(completeBroadcastSummary.includes(`Skipped Guild (skipped-server): skipped. Already sent.`), `Patch-note summaries should name every skipped server.`);
	assert(completeBroadcastSummary.includes(`Failed Guild (failed-server): failed. Missing access.`), `Patch-note summaries should name every failed server.`);
	assert(completeBroadcastSummary.includes(`long-failure`), `Patch-note summaries should preserve long failures across messages.`);
	assert(!completeBroadcastSummary.includes(`more result`), `Patch-note summaries should not use ambiguous result overflow text.`);
	const multiReleasePatchNotes = parsePatchNoteReleases(`# Unreleased

# v3.5.0 - 2026-07-24

- Newest release.

# v3.4.0 - 2026-07-23

- Middle release.

# v3.3.3 - 2026-07-16

- Last sent release.
`);
	const pendingPatchNotes = selectPatchNotesForAnnouncement(multiReleasePatchNotes, `v3.3.3`);

	assert(
		pendingPatchNotes.map(note => note.id).join(`,`) === `v3.4.0,v3.5.0`,
		`Patch-note catch-up should send unsent releases oldest-to-newest.`,
	);
	assert(
		selectPatchNotesForAnnouncement(multiReleasePatchNotes, `v3.5.0`).length === 0,
		`Patch-note catch-up should skip when the latest release was already sent.`,
	);
	assert(
		selectPatchNotesForAnnouncement(multiReleasePatchNotes, `unknown`).map(note => note.id).join(`,`) === `v3.5.0`,
		`Patch-note catch-up should send only the latest release when the stored ID is unknown.`,
	);
	assert(
		selectPatchNotesForAnnouncement(multiReleasePatchNotes, `v3.3.3`, { force: true }).map(note => note.id).join(`,`) === `v3.5.0`,
		`Forced patch-note sends should resend only the latest release.`,
	);
	assert(typeof dateToString(new Date(`2026-07-07T12:00:00Z`)) === `string`, `dateToString did not return a string.`);
}

async function validateKickVodLookup() {
	const originalFetch = global.fetch;
	const log = require(resolveProject(`utils`, `writeLog.js`));
	const originalWarn = log.warn;
	const originalError = log.error;
	const warnings = [];
	const errors = [];
	const vodModulePath = resolveProject(`modules`, `kickVods.js`);

	try {
		log.warn = message => warnings.push(message);
		log.error = (message, err) => errors.push({ message, err });
		const { getLatest } = requireFresh(`modules`, `kickVods.js`);
		const missingChannelBody = `No query results for model [App\\Models\\Channel].`;

		global.fetch = async () => ({
			ok: false,
			status: 404,
			text: async () => missingChannelBody,
		});
		assert((await getLatest(`missing_kick_channel`))?.retryable,
			`A missing Kick endpoint should defer the VoD cutoff.`);
		assert((await getLatest(`missing_kick_channel`))?.retryable,
			`A repeated missing Kick endpoint should remain retryable.`);
		global.fetch = async () => ({
			ok: false,
			status: 404,
			text: async () => JSON.stringify({ message: missingChannelBody }),
		});
		assert((await getLatest(`missing_kick_channel`))?.retryable,
			`A JSON-formatted Kick 404 should defer the VoD cutoff.`);
		assert(warnings.length === 1 && errors.length === 0, `A missing Kick channel should warn once without an error stack.`);

		let requestedUrl = null;
		global.fetch = async url => {
			requestedUrl = url;
			return {
				ok: true,
				json: async () => ({
					slug: `current_kick_channel`,
					previous_livestreams: [{
						session_title: `Test stream`,
						start_time: `2026-10-23 08:09:00`,
						video: { uuid: `test-vod` },
					}],
				}),
			};
		};
		const vod = await getLatest(`current_kick_channel`);
		assert(requestedUrl === `https://kick.com/api/v1/channels/current_kick_channel`, `Kick VoD lookup used the wrong channel endpoint.`);
		assert(vod?.url === `https://kick.com/current_kick_channel/videos/test-vod`, `Kick VoD lookup did not return the replay link.`);
		assert(vod?.title === `Test stream`, `Kick VoD lookup lost the replay title.`);
		assert(vod?.startTime === `2026-10-23 08:09:00`, `Kick VoD lookup lost the past stream start time.`);
		global.fetch = async () => ({
			ok: true,
			json: async () => ({
				slug: `current_kick_channel`,
				previous_livestreams: [
					{ session_title: `Just ended`, video: null },
					{ session_title: `Older stream`, video: { uuid: `older-vod` } },
				],
			}),
		});
		assert(await getLatest(`current_kick_channel`) === null,
			`Kick should wait for the newest stream's replay instead of linking an older VoD.`);

		global.fetch = async () => ({
			ok: true,
			json: async () => ({
				slug: `current_kick_channel`,
				previous_livestreams: [
					{ start_time: `2026-10-23 08:09:40`, video: { uuid: `newer-replay` } },
					{ start_time: `2026-10-23 08:09:10`, video: { uuid: `original-replay` } },
				],
			}),
		});
		const sameMinuteLabel = `10/23/2026, 4:09 AM EDT`;
		const exactReplay = await getLatest(
			`current_kick_channel`, sameMinuteLabel, new Date(`2026-10-23T08:09:10Z`));
		assert(exactReplay?.url === `https://kick.com/current_kick_channel/videos/original-replay`,
			`An exact Kick start time should select its replay among same-minute streams.`);
		assert(await getLatest(`current_kick_channel`, sameMinuteLabel) === null,
			`An ambiguous legacy Kick start minute should not link an arbitrary replay.`);
	} finally {
		// This test owns the fetch stub until its awaited lookups finish.
		// eslint-disable-next-line require-atomic-updates
		global.fetch = originalFetch;
		log.warn = originalWarn;
		log.error = originalError;
		delete require.cache[require.resolve(vodModulePath)];
	}
}

async function validateKickMissingSlugResponse() {
	const originalFetch = global.fetch;
	const log = require(resolveProject(`utils`, `writeLog.js`));
	const originalError = log.error;
	const errors = [];
	const streamUtilsPath = resolveProject(`modules`, `streamUtils.js`);
	const kickStreamsPath = resolveProject(`modules`, `kickStreams.js`);

	try {
		log.error = (message, err) => errors.push({ message, err });
		delete require.cache[require.resolve(streamUtilsPath)];
		const { getStreams } = requireFresh(`modules`, `kickStreams.js`);
		global.fetch = async () => ({
			ok: false,
			status: 404,
			text: async () => `No query results for model [App\\Models\\Channel].`,
		});

		for (let attempt = 0; attempt < 2; attempt++) {
			const result = (await getStreams([`missing_kick_channel`], `client`, `token`)).missing_kick_channel;
			assert(result?.data === null && result.error === false,
				`Kick HTTP 404 should be an unresolved channel, not a failed poll.`);
		}
		assert(errors.length === 0, `Repeated Kick HTTP 404 responses should not produce error logs.`);
	} finally {
		// Keep the fetch stub scoped to this awaited provider lookup.
		global.fetch = originalFetch;
		log.error = originalError;
		delete require.cache[require.resolve(kickStreamsPath)];
		delete require.cache[require.resolve(streamUtilsPath)];
	}
}

async function validateTwitchStreamBatchLookup() {
	const originalFetch = global.fetch;
	const log = require(resolveProject(`utils`, `writeLog.js`));
	const originalError = log.error;
	const errors = [];
	const twitchStreamsPath = resolveProject(`modules`, `twitchStreams.js`);
	const names = Array.from({ length: 101 }, (_, index) => `stream_${index}`);
	const urls = [];
	let activeRequests = 0;
	let maxActiveRequests = 0;

	try {
		log.error = (message, err) => errors.push({ message, err });
		const { getStreams } = requireFresh(`modules`, `twitchStreams.js`);
		global.fetch = async url => {
			activeRequests += 1;
			maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
			urls.push(new URL(url));
			try {
				await Promise.resolve();
				let data = [{ user_login: `stream_100`, id: `live-100` }];
				if (urls.length === 1) {
					data = [
						{ user_login: `stream_0`, id: `live-0` },
						{ user_login: `STREAM_97`, id: `live-97` },
					];
				}

				return {
					ok: true,
					json: async () => ({ data }),
				};
			} finally {
				activeRequests -= 1;
			}
		};
		const streams = await getStreams(names, `client`, `token`);
		assert(urls.length === 2 && maxActiveRequests === 1,
			`Twitch stream polling should issue sequential requests for groups of at most 100 logins.`);
		assert(urls[0].searchParams.getAll(`user_login`).length === 100 &&
			urls[1].searchParams.getAll(`user_login`).join(`,`) === `stream_100` &&
			urls.every(url => url.searchParams.get(`first`) === `100`),
		`Twitch stream polling should request every login and enough results for a full batch.`);
		assert(streams.stream_0.data?.id === `live-0` && streams.stream_97.data?.id === `live-97` &&
			streams.stream_100.data?.id === `live-100`,
		`Twitch stream results should map returned streams by login, regardless of response order or case.`);
		assert(streams.stream_1.data === null && streams.stream_1.error === false,
			`An omitted Twitch login should be treated as offline.`);
		assert(errors.length === 0, `Successful Twitch batches should not log errors.`);

		urls.length = 0;
		global.fetch = async url => {
			urls.push(new URL(url));
			if (urls.length === 1) {
				throw new Error(`socket disconnected`);
			}

			return {
				ok: true,
				json: async () => ({ data: [{ user_login: `stream_100`, id: `live-100` }] }),
			};
		};
		const partial = await getStreams(names, `client`, `token`);
		assert(errors.length === 1 && urls.length === 2,
			`A failed Twitch batch should log once and allow later batches to run.`);
		assert(partial.stream_0.error && partial.stream_99.error && partial.stream_0.data === null,
			`Every login in a failed Twitch batch should be marked as unavailable.`);
		assert(!partial.stream_100.error && partial.stream_100.data?.id === `live-100`,
			`A later successful Twitch batch should retain its stream data.`);
	} finally {
		// Keep the fetch stub scoped to these awaited provider lookups.
		// eslint-disable-next-line require-atomic-updates
		global.fetch = originalFetch;
		log.error = originalError;
		delete require.cache[require.resolve(twitchStreamsPath)];
	}
}

async function validateStreamMessageFetch() {
	const { fetchMessage } = requireFresh(`modules`, `streamUtils.js`);
	const discordChannel = {
		messages: {
			cache: new Map(),
			fetch: async () => {
				const error = new Error(`Unknown Message`);
				error.code = 10008;
				throw error;
			},
		},
	};

	assert(await fetchMessage(discordChannel, `deleted-message`) === null,
		`A deleted stream announcement should be treated as missing.`);
	discordChannel.messages.fetch = async () => {
		throw new Error(`Temporary Discord failure`);
	};
	let transientErrorPropagated = false;
	try {
		await fetchMessage(discordChannel, `retry-message`);
	} catch (error) {
		transientErrorPropagated = error.message === `Temporary Discord failure`;
	}
	assert(transientErrorPropagated, `A transient Discord fetch failure should preserve the stream's retry state.`);
}

function createPendingVodStore() {
	const rows = new Map();
	let nextId = 1;
	const findCreateFind = async ({ where, defaults }) => {
		const existing = rows.get(where.messageId);
		if (existing) {
			return [existing, false];
		}
		const row = { id: nextId++, ...defaults, ...where };
		row.destroy = async () => rows.delete(row.messageId);
		rows.set(row.messageId, row);
		return [row, true];
	};

	return {
		rows,
		findCreateFind,
		findAll: async ({ where }) => [...rows.values()].filter(row =>
			Object.entries(where || {}).every(([key, value]) => row[key] === value)),
		destroy: async ({ where }) => {
			let removed = 0;
			for (const [messageId, row] of rows) {
				if (Object.entries(where || {}).every(([key, value]) => row[key] === value)) {
					rows.delete(messageId);
					removed++;
				}
			}
			return removed;
		},
	};
}

function createKickSessionStore() {
	const rows = new Map();
	return {
		rows,
		findAll: async () => [...rows.values()].map(row => ({ ...row })),
		upsert: async row => {
			rows.set(row.channelId, { ...row });
		},
		destroy: async ({ where }) => Number(rows.delete(where.channelId)),
	};
}

async function validateTwitchPendingVodUpdate() {
	const twitchStreams = require(resolveProject(`modules`, `twitchStreams.js`));
	const twitchVods = require(resolveProject(`modules`, `twitchVods.js`));
	const twitchChannel = require(resolveProject(`modules`, `twitchChannel.js`));
	const twitchIdentity = require(resolveProject(`modules`, `twitchIdentity.js`));
	const streamNameMonitor = require(resolveProject(`modules`, `streamNameMonitor.js`));
	const streamUtils = require(resolveProject(`modules`, `streamUtils.js`));
	const authTokens = require(resolveProject(`auth`, `authTokens.js`));
	const log = require(resolveProject(`utils`, `writeLog.js`));
	const { Channels, PendingStreamVods } = require(resolveProject(`database`, `dbObjects.js`));
	const original = {
		getStreams: twitchStreams.getStreams,
		getForStream: twitchVods.getForStream,
		getChannel: twitchChannel.getChannel,
		getTwitchUsers: twitchIdentity.getTwitchUsers,
		getIdentityMap: streamNameMonitor.getIdentityMap,
		recordStreamName: streamNameMonitor.recordStreamName,
		loadState: streamUtils.loadState,
		targetChannel: streamUtils.targetChannel,
		syncMessage: streamUtils.syncMessage,
		getAuthTokens: authTokens.getAuthTokens,
		update: Channels.update,
		pendingFindCreateFind: PendingStreamVods.findCreateFind,
		pendingFindAll: PendingStreamVods.findAll,
		pendingDestroy: PendingStreamVods.destroy,
		error: log.error,
	};
	const channel = {
		id: 1,
		channelName: `piratesoftware`,
		twitchMessageId: `twitch-message-id`,
		twitchStreamId: `stream-1`,
		twitchNotif: true,
	};
	const server = { guildId: `twitch-guild-id` };
	const edits = [];
	const updates = [];
	const vodLookups = [];
	const liveSyncs = [];
	const errors = [];
	const message = {
		content: `PirateSoftware just went live`,
		embeds: [{
			title: `PirateSoftware is now live`,
			url: `https://www.twitch.tv/piratesoftware`,
			fields: [{ name: `Twitch`, value: `[Watch stream](https://www.twitch.tv/piratesoftware)` }],
			footer: { text: `Started 10/23/2026, 4:09 AM EDT. Last edited 10/23/2026, 4:46 PM EDT.` },
		}],
		edit: async payload => {
			edits.push(payload);
			message.content = payload.content;
			message.embeds = payload.embeds.map(embed => embed.toJSON?.() || embed);
		},
	};
	const discordChannel = { messages: { cache: new Map([[channel.twitchMessageId, message]]) } };
	const pendingStore = createPendingVodStore();
	let vodResult = null;
	let streamData = null;
	let newMessageCount = 0;
	let channelSearches = 0;

	try {
		twitchStreams.getStreams = async () => ({ piratesoftware: { data: streamData, error: false } });
		twitchVods.getForStream = async (userId, streamId) => {
			vodLookups.push({ userId, streamId });
			return vodResult;
		};
		twitchChannel.getChannel = async () => {
			channelSearches += 1;
			return {
				id: `user-1`,
				broadcaster_login: `piratesoftware`,
				display_name: `PirateSoftware`,
				title: `A new stream`,
				game_name: `Noita`,
				thumbnail_url: `https://example.com/profile.jpg`,
			};
		};
		twitchIdentity.getTwitchUsers = async () => new Map([[channel.id, {
			id: `user-1`, login: `piratesoftware`, display_name: `PirateSoftware`,
			profile_image_url: `https://example.com/profile.jpg`,
		}]]);
		streamNameMonitor.getIdentityMap = async () => new Map();
		streamNameMonitor.recordStreamName = async () => null;
		streamUtils.loadState = async () => ({
			servers: [server],
			channels: [channel],
			channelsByGuild: new Map([[server.guildId, [channel]]]),
		});
		streamUtils.targetChannel = () => ({ id: `twitch-discord-channel-id`, discordChannel });
		streamUtils.syncMessage = async options => {
			liveSyncs.push(options);
			if (!options.shouldEdit) {
				const newMessage = {
					id: `new-twitch-message-${++newMessageCount}`,
					content: options.content,
					embeds: [options.embed.toJSON()],
					edit: async payload => {
						newMessage.content = payload.content;
						newMessage.embeds = payload.embeds.map(embed => embed.toJSON?.() || embed);
					},
				};
				discordChannel.messages.cache.set(newMessage.id, newMessage);
				await options.onSend(newMessage);
			}
		};
		authTokens.getAuthTokens = () => ({ twitchAuthToken: `smoke-token` });
		Channels.update = async (state, options) => {
			updates.push([state, options]);
			Object.assign(channel, state);
		};
		PendingStreamVods.findCreateFind = pendingStore.findCreateFind;
		PendingStreamVods.findAll = pendingStore.findAll;
		PendingStreamVods.destroy = pendingStore.destroy;
		log.error = (messageText, reason) => errors.push({ messageText, reason });

		const { getTwitch } = requireFresh(`modules`, `getTwitch.js`);
		const client = {
			guilds: { cache: new Map([[server.guildId, { name: `test guild` }]]) },
			channels: { cache: new Map([[`twitch-discord-channel-id`, discordChannel]]) },
		};
		await getTwitch(client);
		assert(edits.length === 1 && message.content === `The Twitch stream has ended.` &&
			message.embeds[0].fields.find(field => field.name === `Twitch`)?.value === `Fetching VoD...`,
		`Twitch did not mark the stream ended while its VoD was unavailable.`);
		assert(channel.twitchStreamId === null && pendingStore.rows.has(`twitch-message-id`) &&
			pendingStore.rows.get(`twitch-message-id`).streamId === `stream-1`,
		`Twitch did not queue the original stream for replay retries.`);
		const pendingFooter = message.embeds[0].footer.text;
		await getTwitch(client);
		assert(vodLookups.length === 2 && edits.length === 1 && pendingStore.rows.size === 1,
			`Twitch should retry a queued VoD without repeatedly editing or queuing the message.`);

		streamData = {
			id: `stream-2`, user_id: `user-1`, user_login: `piratesoftware`, user_name: `PirateSoftware`,
			title: `A new stream`, game_name: `Noita`, viewer_count: 10, started_at: `2026-10-23T21:00:00Z`,
		};
		await getTwitch(client);
		assert(liveSyncs.at(-1)?.shouldEdit === false && channel.twitchMessageId === `new-twitch-message-1` &&
			pendingStore.rows.has(`twitch-message-id`),
		`A new Twitch stream replaced the old replay queue instead of posting a new announcement.`);
		assert(channelSearches === 0 && liveSyncs.at(-1)?.embed.toJSON().thumbnail?.url === `https://example.com/profile.jpg`,
			`A resolved live broadcaster triggered a redundant Twitch channel search or lost its profile image.`);
		const newLiveMessage = discordChannel.messages.cache.get(channel.twitchMessageId);

		vodResult = { url: `https://www.twitch.tv/videos/smoke-vod`, thumbnail_url: null };
		await getTwitch(client);
		assert(edits.length === 2 &&
			message.embeds[0].fields.find(field => field.name === `Twitch`)?.value ===
			`[Watch VoD](https://www.twitch.tv/videos/smoke-vod)`,
		`Twitch did not replace the pending status after finding a VoD.`);
		assert(message.embeds[0].footer.text === pendingFooter,
			`Twitch changed its recorded end time when the VoD became available.`);
		assert(pendingStore.rows.size === 0 && channel.twitchStreamId === `stream-2` &&
			newLiveMessage.content.includes(`just went live`),
		`Completing an older Twitch replay changed the new live announcement or left the queue uncleared.`);

		// The next stream can start between polls; the prior live message must
		// become a separate pending replay before its replacement is posted.
		vodResult = null;
		streamData = {
			id: `stream-3`, user_id: `user-1`, user_login: `piratesoftware`, user_name: `PirateSoftware`,
			title: `Another new stream`, game_name: `Noita`, viewer_count: 11, started_at: `2026-10-23T22:00:00Z`,
		};
		await getTwitch(client);
		assert(newLiveMessage.content === `The Twitch stream has ended.` &&
			pendingStore.rows.has(`new-twitch-message-1`) &&
			pendingStore.rows.get(`new-twitch-message-1`).streamId === `stream-2` &&
			channel.twitchMessageId === `new-twitch-message-2`,
		`Twitch did not queue a prior stream that ended between polls.`);
		const expiredTwitchRow = pendingStore.rows.get(`new-twitch-message-1`);
		expiredTwitchRow.endedAt = new Date(Date.now() - 6 * 60 * 60 * 1000 - 1000);
		const endedFooter = newLiveMessage.embeds[0].footer.text;
		vodResult = { retryable: true, url: null };
		await getTwitch(client);
		assert(pendingStore.rows.has(`new-twitch-message-1`) &&
			newLiveMessage.embeds[0].fields.find(field => field.name === `Twitch`)?.value === `Fetching VoD...`,
		`A Twitch provider error should defer the expired replay cutoff.`);
		vodResult = null;
		await getTwitch(client);
		assert(newLiveMessage.embeds[0].fields.find(field => field.name === `Twitch`)?.value ===
			`No VoD available` && newLiveMessage.embeds[0].footer.text === endedFooter &&
			!pendingStore.rows.has(`new-twitch-message-1`) && channel.twitchStreamId === `stream-3`,
		`Twitch did not finish an expired replay without changing the current live stream.`);

		// A temporary Users lookup failure still has the existing Search Channels
		// fallback for the profile image and a matching broadcaster ID.
		twitchIdentity.getTwitchUsers = async () => new Map();
		const { getTwitch: getTwitchWithoutUsers } = requireFresh(`modules`, `getTwitch.js`);
		await getTwitchWithoutUsers(client);
		assert(channelSearches === 1,
			`The Twitch channel fallback was not used when the batched Users lookup was unavailable.`);
		streamData = { ...streamData, viewer_count: null };
		await getTwitchWithoutUsers(client);
		assert(errors.some(item => item.messageText.includes(`Failed to process Twitch channel`) &&
			item.messageText.includes(`row 1`) && item.messageText.includes(server.guildId)),
		`A rejected Twitch channel job did not identify the affected row and guild.`);
	} finally {
		twitchStreams.getStreams = original.getStreams;
		twitchVods.getForStream = original.getForStream;
		twitchChannel.getChannel = original.getChannel;
		twitchIdentity.getTwitchUsers = original.getTwitchUsers;
		streamNameMonitor.getIdentityMap = original.getIdentityMap;
		streamNameMonitor.recordStreamName = original.recordStreamName;
		streamUtils.loadState = original.loadState;
		streamUtils.targetChannel = original.targetChannel;
		streamUtils.syncMessage = original.syncMessage;
		authTokens.getAuthTokens = original.getAuthTokens;
		Channels.update = original.update;
		PendingStreamVods.findCreateFind = original.pendingFindCreateFind;
		PendingStreamVods.findAll = original.pendingFindAll;
		PendingStreamVods.destroy = original.pendingDestroy;
		log.error = original.error;
		delete require.cache[require.resolve(resolveProject(`modules`, `getTwitch.js`))];
	}
}

async function validateKickChannelRouting() {
	const kickStreams = require(resolveProject(`modules`, `kickStreams.js`));
	const kickUser = require(resolveProject(`modules`, `kickUser.js`));
	const kickVods = require(resolveProject(`modules`, `kickVods.js`));
	const kickIdentity = require(resolveProject(`modules`, `kickIdentity.js`));
	const streamNameMonitor = require(resolveProject(`modules`, `streamNameMonitor.js`));
	const streamUtils = require(resolveProject(`modules`, `streamUtils.js`));
	const authTokens = require(resolveProject(`auth`, `authTokens.js`));
	const { Channels, KickLiveSessions, PendingStreamVods } = require(resolveProject(`database`, `dbObjects.js`));
	const log = require(resolveProject(`utils`, `writeLog.js`));
	const original = {
		fetch: global.fetch,
		getStreams: kickStreams.getStreams,
		getUsersByIds: kickUser.getUsersByIds,
		getLatest: kickVods.getLatest,
		getChannelsByBroadcasterIds: kickIdentity.getChannelsByBroadcasterIds,
		getIdentityMap: streamNameMonitor.getIdentityMap,
		recordStreamName: streamNameMonitor.recordStreamName,
		loadState: streamUtils.loadState,
		targetChannel: streamUtils.targetChannel,
		fetchMessage: streamUtils.fetchMessage,
		offlineEmbed: streamUtils.offlineEmbed,
		syncMessage: streamUtils.syncMessage,
		getAuthTokens: authTokens.getAuthTokens,
		update: Channels.update,
		pendingFindCreateFind: PendingStreamVods.findCreateFind,
		pendingFindAll: PendingStreamVods.findAll,
		pendingDestroy: PendingStreamVods.destroy,
		kickSessionFindAll: KickLiveSessions.findAll,
		kickSessionUpsert: KickLiveSessions.upsert,
		kickSessionDestroy: KickLiveSessions.destroy,
		warn: log.warn,
	};
	const channel = {
		id: 1,
		guildId: `guild-id`,
		channelName: `old_kick_name`,
		kickMessageId: `message-id`,
		kickIsLive: true,
		kickNotif: true,
	};
	const twitchOnlyChannel = { ...channel, id: 2, channelName: `twitch_only_name`, kickNotif: false };
	const server = { guildId: `guild-id` };
	const edits = [];
	const warnings = [];
	const message = {
		id: `message-id`,
		content: `Old Kick just went live`,
		embeds: [{
			title: `Old Kick is now live`,
			url: `https://kick.com/old_kick_name`,
			fields: [{ name: `Kick`, value: `[Watch stream](https://kick.com/old_kick_name)` }],
			footer: { text: `Started 10/23/2026, 4:09 AM EDT. Last edited 10/23/2026, 4:46 PM EDT.` },
		}],
		edit: async payload => {
			edits.push(payload);
			message.content = payload.content;
			message.embeds = payload.embeds.map(embed => embed.toJSON?.() || embed);
		},
	};
	const messageMap = new Map([[message.id, message]]);
	const discordChannel = { messages: { cache: messageMap } };
	const vodLookups = [];
	const vodLookupArguments = [];
	const polledNames = [];
	const updates = [];
	const pendingStore = createPendingVodStore();
	const kickSessionStore = createKickSessionStore();
	const streamResponseStub = async names => {
		polledNames.push(names);
		return { [channel.channelName]: { data: channelData, error: false } };
	};
	let channelData = { slug: `current_kick_name`, stream: { is_live: false } };
	let savedIdentities = new Map();
	let channelsById = new Map();
	let userLookups = 0;
	let vodResult = null;
	let liveSync = null;
	let newMessageCount = 0;

	try {
		kickStreams.getStreams = streamResponseStub;
		kickVods.getLatest = async (slug, startLabel, providerStartTime) => {
			vodLookups.push(slug);
			vodLookupArguments.push({ slug, startLabel, providerStartTime });
			if (vodResult?.startTime) {
				const vodStart = new Date(`${vodResult.startTime.replace(` `, `T`)}Z`);
				if (providerStartTime ?
					vodStart.getTime() !== new Date(providerStartTime).getTime() :
					streamUtils.formatStreamTime(vodStart) !== startLabel) {
					return null;
				}
			}
			return vodResult;
		};
		kickIdentity.getChannelsByBroadcasterIds = async () => channelsById;
		streamNameMonitor.getIdentityMap = async () => savedIdentities;
		streamNameMonitor.recordStreamName = async () => null;
		kickUser.getUsersByIds = async () => {
			userLookups++;
			return new Map();
		};
		streamUtils.loadState = async () => ({
			servers: [server],
			channels: [channel, twitchOnlyChannel],
			channelsByGuild: new Map([[server.guildId, [channel, twitchOnlyChannel]]]),
		});
		streamUtils.targetChannel = () => ({ id: `discord-channel-id`, discordChannel });
		streamUtils.fetchMessage = async (_target, messageId) => messageMap.get(messageId) || null;
		streamUtils.syncMessage = async options => {
			liveSync = options;
			if (!options.shouldEdit) {
				const newMessage = {
					id: `new-kick-message-${++newMessageCount}`,
					content: options.content,
					embeds: [options.embed.toJSON()],
					edit: async payload => {
						newMessage.content = payload.content;
						newMessage.embeds = payload.embeds.map(embed => embed.toJSON?.() || embed);
					},
				};
				messageMap.set(newMessage.id, newMessage);
				await options.onSend(newMessage);
				return newMessage;
			}
			return messageMap.get(options.messageId);
		};
		authTokens.getAuthTokens = () => ({ kickAuthToken: `test-token` });
		Channels.update = async (state, options) => {
			updates.push([state, options]);
			Object.assign(channel, state);
		};
		PendingStreamVods.findCreateFind = pendingStore.findCreateFind;
		PendingStreamVods.findAll = pendingStore.findAll;
		PendingStreamVods.destroy = pendingStore.destroy;
		KickLiveSessions.findAll = kickSessionStore.findAll;
		KickLiveSessions.upsert = kickSessionStore.upsert;
		KickLiveSessions.destroy = kickSessionStore.destroy;
		log.warn = messageText => warnings.push(messageText);

		const { getKick } = requireFresh(`modules`, `getKick.js`);
		const client = {
			guilds: { cache: new Map([[server.guildId, { name: `test guild` }]]) },
			channels: { cache: new Map([[`discord-channel-id`, discordChannel]]) },
		};
		await getKick(client);
		assert(polledNames[0].join(`,`) === `old_kick_name`, `Kick polled a channel with notifications disabled.`);
		assert(vodLookups.join(`,`) === `current_kick_name`, `Kick VoD lookup did not use Kick's resolved slug.`);
		assert(edits.length === 1 && message.content === `The Kick stream has ended.` &&
			message.embeds[0].fields.find(field => field.name === `Kick`)?.value === `Fetching VoD...`,
		`Kick did not mark the stream ended while the VoD was unavailable.`);
		assert(channel.kickIsLive === false && pendingStore.rows.has(message.id) &&
			pendingStore.rows.get(message.id).startLabel === `10/23/2026, 4:09 AM EDT`,
		`Kick did not queue the original announcement after marking it ended.`);
		const pendingFooter = message.embeds[0].footer.text;
		await getKick(client);
		assert(vodLookups.length === 2 && edits.length === 1 && pendingStore.rows.size === 1,
			`Kick should retry a queued VoD without repeatedly editing or queuing the message.`);
		vodResult = {
			url: `https://kick.com/current_kick_name/videos/older-vod`,
			startTime: `2026-10-22 08:09:00`,
		};
		await getKick(client);
		assert(edits.length === 1 && pendingStore.rows.size === 1,
			`Kick linked an older replay while the just-ended stream was still processing.`);
		vodResult = {
			url: `https://kick.com/current_kick_name/videos/test-vod`,
			startTime: `2026-10-23 08:09:00`,
		};
		await getKick(client);
		assert(edits.length === 2 &&
			message.embeds[0].fields.find(field => field.name === `Kick`)?.value ===
			`[Watch VoD](https://kick.com/current_kick_name/videos/test-vod)`,
		`Kick did not replace the pending status after finding a VoD.`);
		assert(message.embeds[0].footer.text === pendingFooter,
			`Kick changed its recorded end time when the VoD became available.`);
		assert(pendingStore.rows.size === 0 && channel.kickIsLive === false,
			`Kick did not remove the completed replay queue entry.`);
		message.embeds[0].fields.find(field => field.name === `Kick`).value = `Fetching VoD...`;
		message.embeds[0].url = null;
		vodResult = null;
		await pendingStore.findCreateFind({
			where: { messageId: message.id },
			defaults: {
				channelId: channel.id,
				provider: `Kick`,
				discordChannelId: `discord-channel-id`,
				providerName: `current_kick_name`,
				startLabel: `10/23/2026, 4:09 AM EDT`,
				endedAt: new Date(Date.now() - 6 * 60 * 60 * 1000 - 1000),
			},
		});
		vodResult = { retryable: true, url: null };
		await getKick(client);
		assert(pendingStore.rows.has(message.id) &&
			message.embeds[0].fields.find(field => field.name === `Kick`)?.value === `Fetching VoD...`,
		`A Kick provider error should defer the expired replay cutoff.`);
		vodResult = null;
		await getKick(client);
		assert(message.embeds[0].fields.find(field => field.name === `Kick`)?.value ===
			`No VoD available` && message.embeds[0].footer.text === pendingFooter &&
			pendingStore.rows.size === 0,
		`Kick did not finish an expired replay while preserving its end time.`);

		// Exercise the provider's actual missing-slug response through the
		// notification loop, which must leave VoD state untouched.
		kickStreams.getStreams = original.getStreams;
		global.fetch = async () => ({
			ok: false,
			status: 404,
			text: async () => `No query results for model [App\\Models\\Channel].`,
		});
		Object.assign(message, {
			content: `Old Kick just went live`,
			embeds: [{
				title: `Old Kick is now live`,
				url: `https://kick.com/old_kick_name`,
				fields: [{ name: `Kick`, value: `[Watch stream](https://kick.com/old_kick_name)` }],
			}],
		});
		Object.assign(channel, { kickIsLive: true, kickMessageId: message.id });
		vodLookups.splice(0);
		updates.splice(0);
		await getKick(client);
		assert(vodLookups.length === 0, `An unrecognized Kick channel triggered a VoD lookup.`);
		assert(updates.length === 0, `An unrecognized Kick channel cleared live state without a VoD.`);

		Object.assign(message, { embeds: [{ url: `https://kick.com/old_kick_name/videos/existing-vod`, fields: [] }] });
		await getKick(client);
		assert(updates.some(([state]) => state.kickIsLive === false), `An existing Kick VoD did not clear stale live state.`);
		assert(warnings.length === 1, `An unrecognized Kick channel should warn once.`);
		kickStreams.getStreams = streamResponseStub;

		// A bound ID controls both live and replay routing after a slug changes.
		// A recycled old slug must never be treated as the configured account.
		savedIdentities = new Map([[channel.id, { providerUserId: `42` }]]);
		channelsById = new Map([[`42`, {
			broadcaster_user_id: 42,
			slug: `current_kick_name`,
			stream: { is_live: false },
		}]]);
		channelData = { broadcaster_user_id: 99, slug: `old_kick_name`, stream: { is_live: true } };
		Object.assign(message, {
			content: `Old Kick just went live`,
			embeds: [{
				title: `Old Kick is now live`,
				url: `https://kick.com/old_kick_name`,
				fields: [{ name: `Kick`, value: `[Watch stream](https://kick.com/old_kick_name)` }],
				footer: { text: `Started 10/23/2026, 4:09 AM EDT. Last edited 10/23/2026, 4:46 PM EDT.` },
			}],
		});
		Object.assign(channel, { kickIsLive: true, kickMessageId: message.id });
		vodLookups.splice(0);
		await getKick(client);
		assert(polledNames.at(-1).length === 0, `A bound Kick channel should be polled by ID instead of its stale slug.`);
		assert(vodLookups.join(`,`) === `current_kick_name`, `A bound Kick channel should use its ID-resolved slug for VoD.`);
		assert(userLookups === 0, `A recycled Kick slug triggered a different account's live notification.`);

		// A new live session can begin between polls. Queue the previous message
		// before sending a distinct announcement for the new session.
		Object.assign(message, {
			content: `Old Kick just went live`,
			embeds: [{
				title: `Old Kick is now live`,
				url: `https://kick.com/old_kick_name`,
				fields: [{ name: `Kick`, value: `[Watch stream](https://kick.com/old_kick_name)` }],
				footer: { text: `Started 10/23/2026, 4:09 AM EDT. Last edited 10/23/2026, 4:46 PM EDT.` },
			}],
		});
		Object.assign(channel, { kickIsLive: true, kickMessageId: message.id });
		vodResult = null;
		channelsById = new Map([[`42`, {
			broadcaster_user_id: 42,
			slug: `current_kick_name`,
			stream_title: `New Kick stream`,
			category: { name: `Noita` },
			stream: {
				is_live: true,
				viewer_count: 10,
				thumbnail: `https://example.com/kick-thumbnail.jpg`,
				start_time: `2026-10-23T20:00:10Z`,
			},
		}]]);
		kickUser.getUsersByIds = async () => {
			userLookups++;
			return new Map([[`42`, { name: `Current Kick`, profile_picture: `https://example.com/profile.jpg` }]]);
		};
		await getKick(client);
		assert(liveSync?.shouldEdit === false &&
			channel.kickMessageId === `new-kick-message-1` &&
			message.content === `The Kick stream has ended.` && pendingStore.rows.has(message.id),
		`A new Kick stream reused an ended announcement instead of sending a new one.`);
		const newLiveMessage = messageMap.get(channel.kickMessageId);
		assert(kickSessionStore.rows.get(channel.id)?.messageId === newLiveMessage.id &&
			new Date(kickSessionStore.rows.get(channel.id).startTime).getTime() ===
			Date.parse(`2026-10-23T20:00:10Z`),
		`Kick did not persist the exact start time beside the active announcement.`);
		vodResult = {
			url: `https://kick.com/current_kick_name/videos/test-vod`,
			startTime: `2026-10-23 08:09:00`,
		};
		await getKick(client);
		assert(pendingStore.rows.size === 0 &&
			message.embeds[0].fields.find(field => field.name === `Kick`)?.value ===
			`[Watch VoD](https://kick.com/current_kick_name/videos/test-vod)` &&
			newLiveMessage.content.includes(`just went live`),
		`Kick did not finish an older replay while preserving the new live announcement.`);
		vodResult = null;
		// Both starts display as 4:00 PM EDT, so the exact persisted time must
		// distinguish this restart from a routine live-message refresh.
		channelsById.get(`42`).stream.start_time = `2026-10-23T20:00:40Z`;
		await getKick(client);
		assert(newLiveMessage.content === `The Kick stream has ended.` &&
			pendingStore.rows.has(newLiveMessage.id) &&
			channel.kickMessageId === `new-kick-message-2` &&
			new Date(pendingStore.rows.get(newLiveMessage.id).providerStartTime).getTime() ===
			Date.parse(`2026-10-23T20:00:10Z`) &&
			vodLookupArguments.at(-1)?.providerStartTime,
		`Kick did not retain the prior replay when a stream restarted between polls.`);
		pendingStore.rows.get(newLiveMessage.id).endedAt = new Date(Date.now() - 6 * 60 * 60 * 1000 - 1000);
		await getKick(client);
		assert(newLiveMessage.embeds[0].fields.find(field => field.name === `Kick`)?.value ===
			`No VoD available` && !pendingStore.rows.has(newLiveMessage.id) && channel.kickIsLive,
		`The expired Kick replay changed the current live stream or stayed pending.`);

		channelsById.clear();
		vodLookups.splice(0);
		const userLookupsBeforeFailedId = userLookups;
		await getKick(client);
		assert(vodLookups.length === 0 && userLookups === userLookupsBeforeFailedId,
			`A bound Kick channel should skip a mismatched slug when its ID lookup fails.`);
	} finally {
		// Restore the provider fetch stub even if a routing assertion fails.
		// eslint-disable-next-line require-atomic-updates
		global.fetch = original.fetch;
		kickStreams.getStreams = original.getStreams;
		kickUser.getUsersByIds = original.getUsersByIds;
		kickVods.getLatest = original.getLatest;
		kickIdentity.getChannelsByBroadcasterIds = original.getChannelsByBroadcasterIds;
		streamNameMonitor.getIdentityMap = original.getIdentityMap;
		streamNameMonitor.recordStreamName = original.recordStreamName;
		Object.assign(streamUtils, {
			loadState: original.loadState,
			targetChannel: original.targetChannel,
			fetchMessage: original.fetchMessage,
			offlineEmbed: original.offlineEmbed,
			syncMessage: original.syncMessage,
		});
		authTokens.getAuthTokens = original.getAuthTokens;
		Channels.update = original.update;
		PendingStreamVods.findCreateFind = original.pendingFindCreateFind;
		PendingStreamVods.findAll = original.pendingFindAll;
		PendingStreamVods.destroy = original.pendingDestroy;
		KickLiveSessions.findAll = original.kickSessionFindAll;
		KickLiveSessions.upsert = original.kickSessionUpsert;
		KickLiveSessions.destroy = original.kickSessionDestroy;
		log.warn = original.warn;
		delete require.cache[require.resolve(resolveProject(`modules`, `getKick.js`))];
	}
}

async function validateStreamNameMonitoring() {
	const { StreamChannelIdentities } = require(resolveProject(`database`, `dbObjects.js`));
	const log = require(resolveProject(`utils`, `writeLog.js`));
	const original = {
		identityFindAll: StreamChannelIdentities.findAll,
		identityFindCreateFind: StreamChannelIdentities.findCreateFind,
		info: log.info,
	};
	const channels = [
		{ id: 101, guildId: `rename-guild`, channelName: `shared_name`, twitchNotif: true, kickNotif: true },
		{ id: 102, guildId: `other-guild`, channelName: `other_name`, twitchNotif: true, kickNotif: false },
	];
	const identities = [];
	const renameEvents = [];
	const monitorPath = resolveProject(`modules`, `streamNameMonitor.js`);
	let nextIdentityId = 1;

	try {
		log.info = (message, options) => renameEvents.push({ message: String(message), options });
		StreamChannelIdentities.findCreateFind = async ({ where, defaults }) => {
			let identity = identities.find(item => item.channelId === where.channelId && item.provider === where.provider);
			if (identity) {
				return [identity, false];
			}

			identity = {
				id: nextIdentityId++,
				...where,
				...defaults,
				async update(changes) {
					Object.assign(this, changes);
					return this;
				},
			};
			identities.push(identity);
			return [identity, true];
		};
		StreamChannelIdentities.findAll = async ({ where }) => {
			const ids = Reflect.ownKeys(where.channelId).map(key => where.channelId[key]).find(Array.isArray) || [];
			return identities.filter(identity => ids.includes(identity.channelId) &&
				(where.provider === undefined || identity.provider === where.provider))
				.map(identity => ({ ...identity }));
		};
		const monitor = requireFresh(`modules`, `streamNameMonitor.js`);

		await monitor.recordStreamName(channels[0], `twitch`, `twitch-id-101`, `shared_name`);
		await monitor.recordStreamName(channels[0], `kick`, `202`, `shared_name`);
		await monitor.recordStreamName(channels[0], `twitch`, `twitch-id-101`, `SHARED_NAME`);
		assert(renameEvents.length === 0, `Initial ID capture and case-only names should not emit a rename audit event.`);
		await monitor.recordStreamName(channels[0], `twitch`, `twitch-id-101`, `new_twitch_name`);
		await monitor.recordStreamName(channels[0], `kick`, `202`, `new_kick_name`);
		await monitor.recordStreamName(channels[0], `twitch`, `twitch-id-101`, `new_twitch_name`);
		await monitor.recordStreamName(channels[0], `kick`, `202`, `new_kick_name`);
		await monitor.recordStreamName(channels[1], `twitch`, `twitch-id-102`, `other_current_name`);
		await monitor.recordStreamName(channels[0], `twitch`, `different-account`, `hijacked_name`);
		assert(renameEvents.length === 2,
			`Only actual Twitch and Kick name changes should emit rename audit events.`);
		assert(renameEvents[0].message.includes(`shared_name -> new_twitch_name`) &&
			!Number.isNaN(Date.parse(renameEvents[0].options?.meta?.detectedAt)) &&
			renameEvents[0].message.includes(renameEvents[0].options.meta.detectedAt) &&
			renameEvents[0].options?.meta?.provider === `twitch` &&
			renameEvents[0].options.meta.providerUserId === `twitch-id-101` &&
			renameEvents[0].options.meta.savedEntry === `shared_name` &&
			renameEvents[0].options.meta.guildId === `rename-guild` &&
			renameEvents[0].options.meta.previousName === `shared_name` &&
			renameEvents[0].options.meta.currentName === `new_twitch_name`,
		`A Twitch rename audit event should include its provider, ID, saved alias, guild, and old/new names.`);
		assert(renameEvents[1].message.includes(`shared_name -> new_kick_name`) &&
			!Number.isNaN(Date.parse(renameEvents[1].options?.meta?.detectedAt)) &&
			renameEvents[1].message.includes(renameEvents[1].options.meta.detectedAt) &&
			renameEvents[1].options?.meta?.provider === `kick` &&
			renameEvents[1].options.meta.providerUserId === `202` &&
			renameEvents[1].options.meta.savedEntry === `shared_name` &&
			renameEvents[1].options.meta.guildId === `rename-guild` &&
			renameEvents[1].options.meta.previousName === `shared_name` &&
			renameEvents[1].options.meta.currentName === `new_kick_name`,
		`A Kick rename audit event should include its provider, ID, saved alias, guild, and old/new names.`);
		assert(identities.length === 3, `Name monitoring should keep independent identities for each provider on one saved row.`);
		assert(identities[0].currentName === `new_twitch_name` && identities[0].providerUserId === `twitch-id-101`,
			`A reused login should not replace a saved Twitch provider ID.`);
		assert(identities[1].currentName === `new_kick_name` && identities[1].providerUserId === `202`,
			`A Kick rename should update only Kick's current name and preserve its provider ID.`);
		assert(channels[0].channelName === `shared_name`, `Provider renames should preserve the saved shared alias.`);
		const twitchMap = await monitor.getIdentityMap(channels, `twitch`);
		assert(twitchMap.size === 2 && twitchMap.get(101).providerUserId === `twitch-id-101`,
			`Twitch identities were not loaded by stable provider ID.`);
		const kickMap = await monitor.getIdentityMap(channels, `kick`);
		assert(kickMap.size === 1 && kickMap.get(101).currentName === `new_kick_name` &&
			twitchMap.get(101).currentName === `new_twitch_name`,
		`One saved row should retain different current Twitch and Kick names.`);
	} finally {
		StreamChannelIdentities.findAll = original.identityFindAll;
		StreamChannelIdentities.findCreateFind = original.identityFindCreateFind;
		log.info = original.info;
		delete require.cache[require.resolve(monitorPath)];
	}
}

async function validateConcurrentStreamIdentityWrites() {
	const Sequelize = require(`sequelize`);
	const dialectModule = requireFresh(`database`, `sqlcipherSqlite3.js`);
	const { databaseFileStatus } = requireFresh(`database`, `dbEncryption.js`);
	const dbObjects = require(resolveProject(`database`, `dbObjects.js`));
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `hachi-stream-identities-`));
	const dbPath = path.join(tempDir, `identities.sqlite`);
	const monitorPath = resolveProject(`modules`, `streamNameMonitor.js`);
	const originalModel = dbObjects.StreamChannelIdentities;
	const previousKey = process.env.HACHI_DB_KEY;
	const previousKeyFile = process.env.HACHI_DB_KEY_FILE;
	let sequelize = null;

	try {
		process.env.HACHI_DB_KEY = `smoke-stream-identities-${Date.now()}`;
		delete process.env.HACHI_DB_KEY_FILE;
		sequelize = new Sequelize(`database`, ``, ``, {
			dialect: `sqlite`,
			dialectModule,
			storage: dbPath,
			logging: false,
		});
		const TestIdentities = require(resolveProject(`database`, `models`, `streamChannelIdentities.js`))(
			sequelize,
			Sequelize.DataTypes,
		);
		await sequelize.sync();
		dbObjects.StreamChannelIdentities = TestIdentities;
		const { recordStreamName } = requireFresh(`modules`, `streamNameMonitor.js`);
		const channels = Array.from({ length: 8 }, (_, index) => ({
			id: index + 1,
			guildId: `identity-write-test`,
			channelName: `streamer_${index + 1}`,
		}));

		// The Twitch poll records many previously unseen IDs at once. Use the
		// encrypted runtime adapter so transaction lock errors cannot hide behind mocks.
		const writes = await Promise.allSettled(channels.map(channel => recordStreamName(
			channel,
			`twitch`,
			`user-${channel.id}`,
			channel.channelName,
		)));
		const failedWrites = writes.filter(result => result.status === `rejected`);
		assert(failedWrites.length === 0,
			`Concurrent Twitch identity capture failed: ${failedWrites.map(result => result.reason?.message).join(`; `)}`);

		const identities = await TestIdentities.findAll({ raw: true });
		assert(identities.length === channels.length,
			`Concurrent Twitch identity capture did not persist every channel.`);
		for (const channel of channels) {
			assert(identities.some(identity => identity.channelId === channel.id &&
				identity.provider === `twitch` &&
				identity.providerUserId === `user-${channel.id}`),
			`Concurrent Twitch identity capture lost ${channel.channelName}.`);
		}
		assert(databaseFileStatus(dbPath).encryptedLikely,
			`Concurrent identity test database was not encrypted.`);
	} finally {
		dbObjects.StreamChannelIdentities = originalModel;
		delete require.cache[require.resolve(monitorPath)];
		if (sequelize) {
			await sequelize.close().catch(() => null);
		}
		restoreEnvValue(`HACHI_DB_KEY`, previousKey);
		restoreEnvValue(`HACHI_DB_KEY_FILE`, previousKeyFile);
		fs.rmSync(tempDir, { force: true, recursive: true });
	}
}

function validateStreamListProviderNames() {
	const { buildChannelList } = requireFresh(`commands`, `globalCommands`, `utility`, `stream.js`);
	const channels = [{
		id: 101,
		channelName: `shared_name`,
		isSelf: false,
		twitchNotif: true,
		kickNotif: true,
	}];
	const twitchIdentities = new Map([[101, { currentName: `new_twitch_name` }]]);
	const kickIdentities = new Map([[101, { currentName: `new_kick_name` }]]);
	const lines = buildChannelList(channels, twitchIdentities, kickIdentities);

	assert(lines.length === 1 && lines[0].includes(`shared_name`),
		`/stream list should keep one configured row with its saved alias.`);
	assert(lines[0].includes(`Twitch`) && lines[0].includes(`new_twitch_name`) &&
		lines[0].includes(`Kick`) && lines[0].includes(`new_kick_name`),
	`/stream list should show each platform's independently updated name.`);
}

async function validateProviderIdentityLookups() {
	const originalFetch = global.fetch;
	try {
		const { getTwitchUsers } = requireFresh(`modules`, `twitchIdentity.js`);
		const { getChannelsByBroadcasterIds } = requireFresh(`modules`, `kickIdentity.js`);
		const requestedUrls = [];
		global.fetch = async url => {
			const parsed = new URL(url);
			requestedUrls.push(parsed);
			if (parsed.hostname === `api.twitch.tv`) {
				return { ok: true, json: async () => ({ data: [
					{ id: `42`, login: `new_twitch_name` },
					{ id: `55`, login: `fresh_name` },
					{ id: `999`, login: `unrelated_name` },
				] }) };
			}
			return { ok: true, json: async () => ({ data: [
				{ broadcaster_user_id: 72, slug: `new_kick_name` },
				{ broadcaster_user_id: 999, slug: `unrelated_kick_name` },
			] }) };
		};

		const twitchUsers = await getTwitchUsers([
			{ id: 1, channelName: `old_twitch_name` },
			{ id: 2, channelName: `fresh_name` },
			{ id: 3, channelName: `missing_name` },
		], new Map([[1, { providerUserId: `42` }]]), `client`, `token`);
		const twitchRequest = requestedUrls.find(url => url.hostname === `api.twitch.tv`);
		assert(twitchRequest.searchParams.getAll(`id`).includes(`42`) &&
			!twitchRequest.searchParams.getAll(`login`).includes(`old_twitch_name`),
		`Twitch should resolve previously saved accounts by ID after their login changes.`);
		assert(twitchUsers.get(1)?.login === `new_twitch_name` && twitchUsers.get(2)?.id === `55` && !twitchUsers.has(3),
			`Twitch identity lookup matched an unrequested account or lost a resolved account.`);

		const kickChannels = await getChannelsByBroadcasterIds([`72`, `72`, `73`], `client`, `token`);
		const kickRequest = requestedUrls.find(url => url.hostname === `api.kick.com`);
		assert(kickRequest.searchParams.getAll(`broadcaster_user_id`).join(`,`) === `72,73`,
			`Kick should deduplicate and look up saved broadcaster IDs.`);
		assert(kickChannels.get(`72`)?.slug === `new_kick_name` && !kickChannels.has(`999`) && !kickChannels.has(`73`),
			`Kick identity lookup associated an unrelated channel with a saved ID.`);
	} finally {
		// This test owns the fetch stub until both awaited provider lookups finish.
		// eslint-disable-next-line require-atomic-updates
		global.fetch = originalFetch;
	}
}

async function validateKickSlugBatching() {
	const originalFetch = global.fetch;
	const { getStreams } = requireFresh(`modules`, `kickStreams.js`);
	const requestedSlugs = [];
	try {
		global.fetch = async url => {
			const slugs = new URL(url).searchParams.getAll(`slug`);
			requestedSlugs.push(slugs);
			return { ok: true, json: async () => ({ data: [
				{ slug: `beta`, stream: { is_live: true } },
				{ slug: `Alpha`, stream: { is_live: false } },
				{ slug: `unrelated`, stream: { is_live: true } },
			] }) };
		};
		const streams = await getStreams([`Alpha`, `beta`, `Alpha`, `missing`], `client`, `token`);
		assert(requestedSlugs.length === 1 && requestedSlugs[0].join(`,`) === `alpha,beta,missing`,
			`Kick slug lookup did not combine unique channel names into one request.`);
		assert(streams.Alpha.data?.slug === `Alpha` && streams.beta.data?.slug === `beta` &&
			streams.missing.data === null && streams.missing.error === false && !streams.unrelated,
		`Kick slug lookup associated an unrelated channel or treated a missing slug as an API error.`);

		requestedSlugs.length = 0;
		global.fetch = async url => {
			const slugs = new URL(url).searchParams.getAll(`slug`);
			requestedSlugs.push(slugs);
			return { ok: true, json: async () => ({ data: slugs.map(slug => ({ slug })) }) };
		};
		const manySlugs = Array.from({ length: 51 }, (_, index) => `channel_${index}`);
		const manyStreams = await getStreams(manySlugs, `client`, `token`);
		assert(requestedSlugs.length === 2 && requestedSlugs[0].length === 50 &&
			requestedSlugs[1].length === 1 && Object.keys(manyStreams).length === 51,
		`Kick slug batches exceeded the provider's 50-name limit or lost a result.`);

		requestedSlugs.length = 0;
		global.fetch = async url => {
			const slugs = new URL(url).searchParams.getAll(`slug`);
			requestedSlugs.push(slugs);
			if (slugs.length > 1) {
				return { ok: false, status: 400 };
			}
			return slugs[0] === `missing` ?
				{ ok: false, status: 404 } :
				{ ok: true, json: async () => ({ data: [{ slug: slugs[0] }] }) };
		};
		const isolatedStreams = await getStreams([`valid`, `missing`], `client`, `token`);
		assert(requestedSlugs.length === 3 && isolatedStreams.valid.data?.slug === `valid` &&
			isolatedStreams.missing.data === null && !isolatedStreams.missing.error,
		`A bad Kick slug batch did not preserve valid channels through individual fallback.`);

		requestedSlugs.length = 0;
		global.fetch = async url => {
			requestedSlugs.push(new URL(url).searchParams.getAll(`slug`));
			return { ok: false, status: 429 };
		};
		const limitedStreams = await getStreams([`one`, `two`], `client`, `token`);
		assert(requestedSlugs.length === 1 && limitedStreams.one.error && limitedStreams.two.error,
			`Kick rate limiting triggered an individual-request surge or looked like offline channels.`);
	} finally {
		// eslint-disable-next-line require-atomic-updates
		global.fetch = originalFetch;
	}
}

async function validateKickUserBatching() {
	const originalFetch = global.fetch;
	const { getUsersByIds } = requireFresh(`modules`, `kickUser.js`);
	const requestedIds = [];
	try {
		global.fetch = async url => {
			const ids = new URL(url).searchParams.getAll(`id`);
			requestedIds.push(ids);
			return { ok: true, json: async () => ({ data: [
				{ user_id: 43, name: `Second` },
				{ user_id: 42, name: `First` },
				{ user_id: 999, name: `Unrelated` },
			] }) };
		};
		const users = await getUsersByIds([42, `42`, 43, 44], `client`, `token`);
		assert(requestedIds.length === 1 && requestedIds[0].join(`,`) === `42,43,44`,
			`Kick user lookup did not deduplicate broadcaster IDs.`);
		assert(users.get(`42`)?.name === `First` && users.get(`43`)?.name === `Second` &&
			!users.has(`44`) && !users.has(`999`),
		`Kick user lookup associated an unrequested profile with a broadcaster.`);

		requestedIds.length = 0;
		global.fetch = async url => {
			const ids = new URL(url).searchParams.getAll(`id`);
			requestedIds.push(ids);
			return { ok: true, json: async () => ({ data: ids.map(id => ({ user_id: Number(id), name: id })) }) };
		};
		const manyIds = Array.from({ length: 51 }, (_, index) => index + 1);
		const manyUsers = await getUsersByIds(manyIds, `client`, `token`);
		assert(requestedIds.length === 2 && requestedIds[0].length === 50 &&
			requestedIds[1].length === 1 && manyUsers.size === 51,
		`Kick user-profile batches exceeded their bound or lost a profile.`);

		requestedIds.length = 0;
		global.fetch = async url => {
			const ids = new URL(url).searchParams.getAll(`id`);
			requestedIds.push(ids);
			if (ids.length > 1) {
				return { ok: false, status: 400, statusText: `Bad Request` };
			}
			return ids[0] === `44` ?
				{ ok: false, status: 404, statusText: `Not Found` } :
				{ ok: true, json: async () => ({ data: [{ user_id: Number(ids[0]), name: `Valid` }] }) };
		};
		const isolatedUsers = await getUsersByIds([42, 44], `client`, `token`);
		assert(requestedIds.length === 3 && isolatedUsers.get(`42`)?.name === `Valid` && !isolatedUsers.has(`44`),
			`A bad Kick user batch did not preserve valid profiles through individual fallback.`);

		requestedIds.length = 0;
		global.fetch = async url => {
			requestedIds.push(new URL(url).searchParams.getAll(`id`));
			return { ok: false, status: 429, statusText: `Too Many Requests` };
		};
		const limitedUsers = await getUsersByIds([42, 43], `client`, `token`);
		assert(requestedIds.length === 1 && limitedUsers.size === 0,
			`Kick user rate limiting triggered an individual-request surge.`);
	} finally {
		// eslint-disable-next-line require-atomic-updates
		global.fetch = originalFetch;
	}
}

async function validateKickSharedProfilesAcrossGuilds() {
	const kickStreams = require(resolveProject(`modules`, `kickStreams.js`));
	const kickUser = require(resolveProject(`modules`, `kickUser.js`));
	const kickIdentity = require(resolveProject(`modules`, `kickIdentity.js`));
	const streamNameMonitor = require(resolveProject(`modules`, `streamNameMonitor.js`));
	const streamUtils = require(resolveProject(`modules`, `streamUtils.js`));
	const authTokens = require(resolveProject(`auth`, `authTokens.js`));
	const log = require(resolveProject(`utils`, `writeLog.js`));
	const { KickLiveSessions, PendingStreamVods } = require(resolveProject(`database`, `dbObjects.js`));
	const original = {
		getStreams: kickStreams.getStreams,
		getUsersByIds: kickUser.getUsersByIds,
		getChannelsByBroadcasterIds: kickIdentity.getChannelsByBroadcasterIds,
		getIdentityMap: streamNameMonitor.getIdentityMap,
		recordStreamName: streamNameMonitor.recordStreamName,
		loadState: streamUtils.loadState,
		targetChannel: streamUtils.targetChannel,
		syncMessage: streamUtils.syncMessage,
		getAuthTokens: authTokens.getAuthTokens,
		kickSessionFindAll: KickLiveSessions.findAll,
		pendingFindAll: PendingStreamVods.findAll,
		error: log.error,
	};
	const channels = [
		{ id: 201, guildId: `guild-one`, channelName: `old_slug`, kickNotif: true },
		{ id: 202, guildId: `guild-two`, channelName: `old_slug`, kickNotif: true },
	];
	const profileBatches = [];
	const announcements = [];
	const errors = [];
	let providerChannel = {
		broadcaster_user_id: 42,
		slug: `current_slug`,
		stream_title: `Current stream`,
		category: { name: `Games` },
		stream: {
			is_live: true,
			viewer_count: 2,
			thumbnail: `https://example.com/stream.jpg`,
			start_time: `2026-10-27T18:00:00Z`,
		},
	};
	try {
		kickStreams.getStreams = async () => ({});
		kickIdentity.getChannelsByBroadcasterIds = async () => new Map([[`42`, providerChannel]]);
		kickUser.getUsersByIds = async ids => {
			profileBatches.push(ids);
			return new Map([[`42`, {
				name: `Current Kick`,
				profile_picture: `https://example.com/profile.jpg`,
			}]]);
		};
		streamNameMonitor.getIdentityMap = async () => new Map(channels.map(chan =>
			[chan.id, { providerUserId: `42` }]));
		streamNameMonitor.recordStreamName = async () => null;
		streamUtils.loadState = async () => ({
			servers: [{ guildId: `guild-one` }, { guildId: `guild-two` }],
			channels,
			channelsByGuild: new Map([
				[`guild-one`, [channels[0]]],
				[`guild-two`, [channels[1]]],
			]),
		});
		streamUtils.targetChannel = () => ({ id: `announcement-channel`, discordChannel: {} });
		streamUtils.syncMessage = async options => {
			announcements.push(options);
			return null;
		};
		authTokens.getAuthTokens = () => ({ kickAuthToken: `token` });
		KickLiveSessions.findAll = async () => [];
		PendingStreamVods.findAll = async () => [];
		log.error = (message, reason) => errors.push({ message, reason });
		const { getKick } = requireFresh(`modules`, `getKick.js`);
		await getKick({ guilds: { cache: new Map([
			[`guild-one`, { name: `Guild One` }],
			[`guild-two`, { name: `Guild Two` }],
		]) } });
		assert(profileBatches.length === 1 && profileBatches[0].join(`,`) === `42` &&
			announcements.length === 2 && announcements.every(item => item.content.includes(`Current Kick`)),
		`Kick fetched duplicate profiles or failed to announce the shared broadcaster in both guilds.`);
		kickUser.getUsersByIds = async () => new Map();
		await getKick({ guilds: { cache: new Map() } });
		assert(announcements.length === 4 && announcements.slice(2).every(item =>
			item.content.includes(`current_slug just went live`) && !item.embed.toJSON().thumbnail),
		`Kick did not announce verified live channels when their profiles were missing.`);
		kickUser.getUsersByIds = async () => {
			throw new Error(`Profile request unavailable`);
		};
		await getKick({ guilds: { cache: new Map() } });
		assert(announcements.length === 6 && announcements.slice(4).every(item =>
			item.content.includes(`current_slug just went live`)) &&
			errors.some(item => item.message.includes(`Failed to fetch Kick user profiles`)),
		`Kick suppressed live alerts after a failed profile batch.`);
		providerChannel = { ...providerChannel, category: null };
		await getKick({ guilds: { cache: new Map() } });
		assert(errors.filter(item => item.message.includes(`Failed to process Kick channel`)).length === 2 &&
			errors.some(item => item.message.includes(`row 201`) && item.message.includes(`guild-one`)) &&
			errors.some(item => item.message.includes(`row 202`) && item.message.includes(`guild-two`)),
		`A rejected Kick channel job did not identify the affected row and guild.`);
	} finally {
		kickStreams.getStreams = original.getStreams;
		kickUser.getUsersByIds = original.getUsersByIds;
		kickIdentity.getChannelsByBroadcasterIds = original.getChannelsByBroadcasterIds;
		streamNameMonitor.getIdentityMap = original.getIdentityMap;
		streamNameMonitor.recordStreamName = original.recordStreamName;
		streamUtils.loadState = original.loadState;
		streamUtils.targetChannel = original.targetChannel;
		streamUtils.syncMessage = original.syncMessage;
		authTokens.getAuthTokens = original.getAuthTokens;
		KickLiveSessions.findAll = original.kickSessionFindAll;
		PendingStreamVods.findAll = original.pendingFindAll;
		log.error = original.error;
		delete require.cache[require.resolve(resolveProject(`modules`, `getKick.js`))];
	}
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

function validateModmailContracts() {
	const command = requireFresh(`commands`, `globalCommands`, `admin`, `modmail.js`);
	const { buildEntryPanel, getRoleIds, ticketName } = requireFresh(`utils`, `modmail.js`);
	const commandJson = command.data.toJSON();
	const panel = buildEntryPanel();
	const embed = panel.embeds[0].toJSON();
	const button = panel.components[0].components[0].toJSON();
	const roles = getRoleIds({
		allowedRoleIdsJson: JSON.stringify([`allowed`, `shared`]),
		pingRoleIdsJson: JSON.stringify([`ping`, `shared`]),
	});

	assert(commandJson.name === `modmail`, `Modmail command name is invalid.`);
	assert(commandJson.options.some(option => option.name === `setup`), `Modmail setup subcommand is missing.`);
	assert(commandJson.options.some(option => option.name === `status`), `Modmail status subcommand is missing.`);
	assert(embed.title === `Modmail`, `Modmail entry panel title changed unexpectedly.`);
	assert(embed.description === `To create a ticket, press 📩`, `Modmail entry panel description changed unexpectedly.`);
	assert(embed.footer?.text === `A moderator will respond when available.`, `Modmail entry panel footer changed unexpectedly.`);
	assert(button.custom_id === `modmail:create`, `Modmail create-ticket button is not persistently routable.`);
	assert(ticketName(1) === `ticket-0001`, `Modmail ticket numbering format is invalid.`);
	assert(roles.effectiveRoleIds.join(`,`) === `allowed,shared,ping`, `Ping roles were not merged into effective Modmail access.`);
}

async function validateModmailCleanupRetry() {
	const { ModmailTickets } = requireFresh(`database`, `dbObjects.js`);
	const { cleanupClosedTickets } = requireFresh(`utils`, `modmail.js`);
	const previousFindAll = ModmailTickets.findAll;
	let deletionAttempts = 0;
	const ticket = {
		id: 7,
		guildId: `guild`,
		channelId: `ticket-channel`,
		status: `closed`,
		update: async values => Object.assign(ticket, values),
	};
	const channel = {
		delete: async () => {
			deletionAttempts += 1;
			if (deletionAttempts === 1) {
				throw Object.assign(new Error(`temporary permission failure`), { code: 50013 });
			}
		},
	};
	const guild = { channels: { fetch: async () => channel } };
	const client = { guilds: { cache: new Map([[`guild`, guild]]) } };

	try {
		ModmailTickets.findAll = async () => [ticket];
		assert(await cleanupClosedTickets(client) === 0 && ticket.status === `closed` && ticket.channelId === `ticket-channel`,
			`A failed Discord channel deletion retired the Modmail ticket.`);
		assert(await cleanupClosedTickets(client) === 1 && ticket.status === `deleted` && ticket.channelId === null,
			`A later successful deletion did not retire the retained Modmail ticket.`);
	} finally {
		ModmailTickets.findAll = previousFindAll;
	}
}

async function validateModmailEntryChannelCache() {
	const { ModmailConfigs } = requireFresh(`database`, `dbObjects.js`);
	const { enforceEntryChannel, invalidateEntryChannelCache } = requireFresh(`utils`, `modmail.js`);
	const previousFindByPk = ModmailConfigs.findByPk;
	const previousFindOne = ModmailConfigs.findOne;
	const guildId = `modmail-cache-smoke-guild`;
	let entryChannelId = `entry-one`;
	let entryChannelReads = 0;
	let panelChecks = 0;
	let deletedMessages = 0;
	const message = channelId => ({
		id: `member-message`,
		guild: { id: guildId },
		channel: { id: channelId },
		author: { id: `member` },
		client: { user: { id: `bot` } },
		delete: async () => { deletedMessages += 1; },
	});

	try {
		ModmailConfigs.findByPk = async () => {
			entryChannelReads += 1;
			return { entryChannelId };
		};
		ModmailConfigs.findOne = async ({ where }) => {
			panelChecks += 1;
			return where.entryChannelId === entryChannelId ? { panelMessageId: `panel` } : null;
		};

		assert(!await enforceEntryChannel(message(`general-one`)) &&
			!await enforceEntryChannel(message(`general-two`)) &&
			entryChannelReads === 1 && panelChecks === 0,
		`Ordinary guild messages should share the cached Modmail entry-channel lookup.`);

		entryChannelId = `entry-two`;
		invalidateEntryChannelCache(guildId);
		assert(await enforceEntryChannel(message(`entry-two`)) &&
			entryChannelReads === 2 && panelChecks === 1 && deletedMessages === 1,
		`A changed Modmail entry channel was not refreshed or enforced.`);

		// A change by another process can leave a positive cache entry until its
		// TTL expires. The current database row must still authorize deletion.
		entryChannelId = `entry-three`;
		assert(!await enforceEntryChannel(message(`entry-two`)) &&
			entryChannelReads === 2 && panelChecks === 2 && deletedMessages === 1,
		`A stale Modmail entry-channel cache entry deleted an unrelated message.`);
	} finally {
		ModmailConfigs.findByPk = previousFindByPk;
		ModmailConfigs.findOne = previousFindOne;
	}
}

async function validatePatchNotePartialDelivery() {
	const dbObjects = requireFresh(`database`, `dbObjects.js`);
	const announcements = requireFresh(`utils`, `announcements.js`);
	const patchNotesPath = resolveProject(`docs`, `patch-notes.md`);
	const document = `# v9.9.9 - Smoke release\n\n${`First detail. `.repeat(180)}\n\n${`Second detail. `.repeat(180)}\n`;
	const expectedChunks = announcements.formatPatchNotesMessages(announcements.parseLatestPatchNotes(document));
	assert(expectedChunks.length > 1, `The partial-delivery fixture needs multiple messages.`);

	const previousReadFileSync = fs.readFileSync;
	const previousFindOne = dbObjects.Servers.findOne;
	const previousUpdate = dbObjects.Servers.update;
	const previousFindByPk = dbObjects.AnnouncementDeliveryProgress.findByPk;
	const previousUpsert = dbObjects.AnnouncementDeliveryProgress.upsert;
	const previousDestroy = dbObjects.AnnouncementDeliveryProgress.destroy;
	const previousTransaction = dbObjects.sequelize.transaction;
	const settings = { guildId: `guild`, hachiAnnouncementChannelId: `updates`, hachiAnnouncementLastId: null };
	let checkpoint = null;
	let sendAttempts = 0;
	let secondSendIsAccepted = false;
	let recoveredMessageHasNonce = true;
	const deliveredPayloads = [];
	const fetchedMessages = new Map();
	const channel = {
		id: `updates`,
		client: { user: { id: `bot` } },
		isTextBased: () => true,
		permissionsFor: () => ({ has: () => true }),
		messages: { fetch: async () => fetchedMessages },
		send: async payload => {
			sendAttempts += 1;
			if (sendAttempts === 2) {
				if (secondSendIsAccepted) {
					deliveredPayloads.push(payload);
					fetchedMessages.set(`message-2`, {
						id: `message-2`,
						nonce: recoveredMessageHasNonce ? payload.nonce : null,
						content: payload.content,
						createdTimestamp: Date.now(),
						author: { id: `bot` },
					});
				}
				throw new Error(`simulated Discord send failure`);
			}
			deliveredPayloads.push(payload);
			return { id: `message-${deliveredPayloads.length}` };
		},
	};
	const guild = {
		id: `guild`,
		name: `Smoke Guild`,
		members: { me: { id: `bot` } },
		channels: { fetch: async () => channel },
	};
	const client = { guilds: { cache: new Map([[`guild`, guild]]) } };

	try {
		Reflect.set(fs, `readFileSync`, (filePath, ...args) => {
			if (typeof filePath === `string` && path.resolve(filePath) === patchNotesPath) {
				return document;
			}
			return previousReadFileSync(filePath, ...args);
		});
		dbObjects.Servers.findOne = async () => settings;
		dbObjects.Servers.update = async values => {
			Object.assign(settings, values);
			return [1];
		};
		dbObjects.AnnouncementDeliveryProgress.findByPk = async () => checkpoint && { progressJson: checkpoint };
		dbObjects.AnnouncementDeliveryProgress.upsert = async values => {
			checkpoint = values.progressJson;
		};
		dbObjects.AnnouncementDeliveryProgress.destroy = async () => {
			checkpoint = null;
		};
		dbObjects.sequelize.transaction = async callback => callback({});

		const failedAttempt = await announcements.sendLatestPatchNotesToGuild(client, `guild`);
		assert(!failedAttempt.ok && failedAttempt.sent === 1 && checkpoint &&
		JSON.parse(checkpoint).nextChunkIndex === 1 && settings.hachiAnnouncementLastId === null,
		`Partial patch-note delivery did not retain its first confirmed message.`);

		const retry = await announcements.sendLatestPatchNotesToGuild(client, `guild`);
		assert(retry.ok && retry.sent === expectedChunks.length - 1 &&
			deliveredPayloads.length === expectedChunks.length &&
			deliveredPayloads.map(payload => payload.content).join(`\n`) === expectedChunks.join(`\n`) &&
		settings.hachiAnnouncementLastId === `v9.9.9` && checkpoint === null,
		`Patch-note retry resent a confirmed chunk or failed to complete the release.`);

		// Only a message authored by Hachi can prove that an uncertain send landed.
		Reflect.set(settings, `hachiAnnouncementLastId`, null);
		sendAttempts = 0;
		deliveredPayloads.splice(0);
		fetchedMessages.clear();
		await announcements.sendLatestPatchNotesToGuild(client, `guild`);
		const pendingRun = JSON.parse(checkpoint);
		const spoofedNonce = require(`node:crypto`).createHash(`sha256`)
			.update(`${pendingRun.runId}:1`).digest(`base64url`).slice(0, 25);
		fetchedMessages.set(`other-user-message`, {
			id: `other-user-message`, nonce: spoofedNonce, author: { id: `other-user` },
			content: pendingRun.messages[1], createdTimestamp: Date.now(),
		});
		const ignoredSpoof = await announcements.sendLatestPatchNotesToGuild(client, `guild`);
		assert(ignoredSpoof.ok && ignoredSpoof.sent === expectedChunks.length - 1 && checkpoint === null,
			`A different author's nonce was mistaken for Hachi's patch-note delivery.`);

		// Discord can accept a send before the API call reports failure. A matching
		// nonce in channel history proves that chunk should be checkpointed, not resent.
		Reflect.set(settings, `hachiAnnouncementLastId`, null);
		sendAttempts = 0;
		deliveredPayloads.splice(0);
		fetchedMessages.clear();
		secondSendIsAccepted = true;
		await announcements.sendLatestPatchNotesToGuild(client, `guild`);
		const recoveredRetry = await announcements.sendLatestPatchNotesToGuild(client, `guild`);
		assert(recoveredRetry.ok && recoveredRetry.sent === expectedChunks.length - 2 &&
			deliveredPayloads.length === expectedChunks.length && checkpoint === null,
		`A previously accepted patch-note chunk was sent again despite a matching nonce in history.`);

		// If Discord omits that nonce, matching content alone cannot prove which
		// send produced it; keep the checkpoint for manual review.
		Reflect.set(settings, `hachiAnnouncementLastId`, null);
		sendAttempts = 0;
		deliveredPayloads.splice(0);
		fetchedMessages.clear();
		recoveredMessageHasNonce = false;
		await announcements.sendLatestPatchNotesToGuild(client, `guild`);
		const uncertainRetry = await announcements.sendLatestPatchNotesToGuild(client, `guild`);
		assert(!uncertainRetry.ok && uncertainRetry.message.includes(`manual review`) &&
			deliveredPayloads.length === 2 && checkpoint && settings.hachiAnnouncementLastId === null,
		`A nonce-free matching history message allowed an uncertain resend.`);
	} finally {
		Reflect.set(fs, `readFileSync`, previousReadFileSync);
		dbObjects.Servers.findOne = previousFindOne;
		dbObjects.Servers.update = previousUpdate;
		dbObjects.AnnouncementDeliveryProgress.findByPk = previousFindByPk;
		dbObjects.AnnouncementDeliveryProgress.upsert = previousUpsert;
		dbObjects.AnnouncementDeliveryProgress.destroy = previousDestroy;
		dbObjects.sequelize.transaction = previousTransaction;
	}
}

async function validatePatchNoteBroadcastSnapshot() {
	const dbObjects = requireFresh(`database`, `dbObjects.js`);
	const announcements = requireFresh(`utils`, `announcements.js`);
	const patchNotesPath = resolveProject(`docs`, `patch-notes.md`);
	const previousReadFileSync = fs.readFileSync;
	const previousFindAll = dbObjects.Servers.findAll;
	const previousFindOne = dbObjects.Servers.findOne;
	const previousFindByPk = dbObjects.AnnouncementDeliveryProgress.findByPk;
	let documentVersion = `9.9.9`;
	let documentReads = 0;
	let switchAfterFirstGuild = true;
	const client = {
		guilds: {
			cache: new Map(),
			fetch: async () => null,
		},
	};

	try {
		Reflect.set(fs, `readFileSync`, (filePath, ...args) => {
			if (typeof filePath === `string` && path.resolve(filePath) === patchNotesPath) {
				documentReads += 1;
				return `# v${documentVersion} - Smoke release\n\nBroadcast detail.\n`;
			}
			return previousReadFileSync(filePath, ...args);
		});
		dbObjects.Servers.findAll = async () => [
			{ guildId: `guild-one` },
			{ guildId: `guild-two` },
		];
		dbObjects.Servers.findOne = async () => {
			if (switchAfterFirstGuild) {
				documentVersion = `9.9.10`;
				switchAfterFirstGuild = false;
			}
			return { hachiAnnouncementChannelId: `updates`, hachiAnnouncementLastId: `v9.9.9` };
		};
		dbObjects.AnnouncementDeliveryProgress.findByPk = async () => null;

		const firstBroadcast = await announcements.broadcastLatestPatchNotes(client);
		assert(documentReads === 1 && firstBroadcast.length === 2 &&
			firstBroadcast.every(result => result.patchNoteId === `v9.9.9`),
		`A patch-note broadcast used different release documents for its guilds.`);

		const secondBroadcast = await announcements.broadcastLatestPatchNotes(client);
		assert(documentReads === 2 && secondBroadcast.length === 2 &&
			secondBroadcast.every(result => result.patchNoteId === `v9.9.10`),
		`The next patch-note broadcast did not load the updated release document.`);
	} finally {
		Reflect.set(fs, `readFileSync`, previousReadFileSync);
		dbObjects.Servers.findAll = previousFindAll;
		dbObjects.Servers.findOne = previousFindOne;
		dbObjects.AnnouncementDeliveryProgress.findByPk = previousFindByPk;
	}
}

async function validateLogArchiveRetention() {
	const { cleanupOldLogs } = requireFresh(`utils`, `writeLog.js`);
	const logsPath = resolveProject(`logs`);
	const oldDate = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
	const recentDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
	const archiveNames = [`${oldDate}.tar.gz`, `${recentDate}.tar.gz`, `2026-02-30.tar.gz`];
	const previousExistsSync = fs.existsSync;
	const previousReaddirSync = fs.readdirSync;
	const previousRmSync = fs.rmSync;
	const removedArchives = [];

	try {
		// Redirect only the logger's archive listing. A smoke test must not
		// alter an installation's actual logs or depend on their age.
		Reflect.set(fs, `existsSync`, filePath => filePath === logsPath || previousExistsSync(filePath));
		Reflect.set(fs, `readdirSync`, (directory, options) => directory === logsPath ?
			archiveNames.map(name => ({ name, isDirectory: () => false, isFile: () => true })) :
			previousReaddirSync(directory, options));
		Reflect.set(fs, `rmSync`, (target, options) => {
			if (path.dirname(target) === logsPath) {
				removedArchives.push(path.basename(target));
				return;
			}
			previousRmSync(target, options);
		});
		await cleanupOldLogs();
		assert(removedArchives.join(`,`) === `${oldDate}.tar.gz`,
			`Archive retention did not remove only the old, valid-date archive.`);
	} finally {
		Reflect.set(fs, `existsSync`, previousExistsSync);
		Reflect.set(fs, `readdirSync`, previousReaddirSync);
		Reflect.set(fs, `rmSync`, previousRmSync);
	}
}

async function main() {
	let dbObjects = null;

	await test(`package metadata and lockfile are consistent`, validatePackageMetadata);
	await test(`required project files exist`, validateProjectFiles);
	await test(`blank config cron fields are valid`, validateBlankConfig);
	await test(`runtime dependencies can be required`, validateRuntimeDependencies);
	await test(`commands load and serialize for Discord deployment`, collectCommands);
	await test(`/setup hub uses expected panel order`, validateSetupHubOrdering);
	await test(`/twitch panel includes privacy subtext`, validateTwitchVerificationPanelPrivacyCopy);
	await test(`Twitch role linking is VIP-only and retires legacy Moderator roles`, validateVipOnlyTwitchRoleSync);
	await test(`managed Twitch verification panels move, repair, and remove safely`, validateManagedTwitchVerificationPanelLifecycle);
	await test(`/setup Hachi Updates stores primitive channel IDs`, validateAnnouncementChannelIdNormalization);
	await test(`failed Hachi Updates deliveries warn server managers privately`, validateManagerAnnouncementWarnings);
	await test(`/raid audit filters non-risky explicit allows`, validateRaidAuditExplicitAllowFiltering);
	await test(`component handlers have routable customId prefixes`, assertComponentHandlersAreRoutable);
	await test(`Modmail panels, numbering, and role access expose valid contracts`, validateModmailContracts);
	await test(`failed Modmail channel deletion remains retryable`, validateModmailCleanupRetry);
	await test(`Modmail entry-channel cache preserves deletion safety`, validateModmailEntryChannelCache);
	await test(`partial patch-note delivery resumes without duplicating messages`, validatePatchNotePartialDelivery);
	await test(`patch-note broadcasts use one fresh release snapshot`, validatePatchNoteBroadcastSnapshot);
	await test(`events load with valid handlers`, validateEventFiles);
	await test(`help catalog builds from loaded commands`, assertHelpCatalogBuilds);
	await test(`Hachi command surfaces expose valid contracts`, validateHachiCommandSurfaces);
	await test(`database models match audited schema columns`, () => {
		dbObjects = validateDatabaseModels();
	});
	await test(`new streamer IDs reuse only safe gaps`, validateReusableChannelIds);
	await test(`Modmail index rejects new duplicates but preserves legacy tickets`, validateOneOpenModmailTicketIndex);
	await test(`SQLCipher adapter normalizes Sequelize bind values`, validateSqlcipherAdapterBindNormalization);
	await test(`encrypted Sequelize runtime opens SQLCipher databases`, validateEncryptedSequelizeRuntime);
	await test(`database encryption conversion preserves SQLite data`, validateDatabaseEncryptionConversion);
	await test(`encrypted tool database helpers remain promise-based`, validateToolDatabaseConnectionPromises);
	await test(`database migration and audit use an isolated schema`, auditIsolatedDatabase);
	await test(`secret encryption helpers round-trip env values`, validateSecretEncryptionHelpers);
	await test(`Twitch and Kick app tokens use form-encoded request bodies`, validateProviderAppTokenRequests);
	await test(`configCheck validates isolated config and rejects bad cron expressions`, validateConfigCheckInIsolatedFixture);
	await test(`log cleanup removes only old valid-date archives`, validateLogArchiveRetention);
	await test(`pure utility helpers return expected values`, validatePureHelpers);
	await test(`Kick VoD lookup handles missing channels without error floods`, validateKickVodLookup);
	await test(`Kick HTTP 404 slugs stay unresolved without repeated errors`, validateKickMissingSlugResponse);
	await test(`Twitch stream lookups batch logins and contain batch failures`, validateTwitchStreamBatchLookup);
	await test(`stream announcement fetches distinguish deletion from transient errors`, validateStreamMessageFetch);
	await test(`Twitch announcements end before replay availability and preserve end times`, validateTwitchPendingVodUpdate);
	await test(`Kick VoD lookup uses resolved slugs and preserves missing-channel state`, validateKickChannelRouting);
	await test(`stream renames preserve one alias and independent provider names`, validateStreamNameMonitoring);
	await test(`concurrent Twitch identity capture persists every channel`, validateConcurrentStreamIdentityWrites);
	await test(`/stream list shows independent Twitch and Kick names on one row`, validateStreamListProviderNames);
	await test(`Kick and Twitch resolve renamed accounts by stable provider ID`, validateProviderIdentityLookups);
	await test(`Kick channel slugs batch without cross-matching or retry storms`, validateKickSlugBatching);
	await test(`Kick user profiles batch by exact ID and isolate bad requests`, validateKickUserBatching);
	await test(`Kick shares live user profiles across servers`, validateKickSharedProfilesAcrossGuilds);
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
