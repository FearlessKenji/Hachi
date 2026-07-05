const { PermissionFlagsBits } = require(`discord.js`);

const DEFAULT_CATEGORY = {
	description: `Commands available in this server.`,
	id: `other`,
	name: `Other Commands`,
	sortOrder: 900,
};

const CATEGORY_DEFAULTS = {
	general: {
		description: `Everyday user commands.`,
		name: `General Tools`,
		sortOrder: 10,
	},
	streams: {
		description: `Twitch and Kick notification setup.`,
		name: `Streams And Notifications`,
		sortOrder: 20,
	},
	security: {
		description: `Application command monitoring tools.`,
		name: `Security Reporting`,
		sortOrder: 30,
	},
	raid: {
		description: `Anti-raid configuration and incident review.`,
		name: `Raid Protection`,
		sortOrder: 40,
	},
	management: {
		description: `Server configuration and role panels.`,
		name: `Server Management`,
		sortOrder: 50,
	},
	diagnostics: {
		description: `Health and utility checks.`,
		name: `Diagnostics`,
		sortOrder: 60,
	},
	owner: {
		description: `Owner-only runtime controls.`,
		name: `Owner Tools`,
		sortOrder: 95,
	},
};

function inlineCode(value) {
	return `\`${String(value).replace(/`/gu, `'`)}\``;
}

function line(command, description) {
	return `${inlineCode(command)} - ${description}`;
}

function normalizePermissions(permissions = []) {
	return permissions
		.filter(permission => permission !== null && permission !== undefined)
		.map(permission => BigInt(permission));
}

function getCommandPermissions(command) {
	if (command.help?.permissions) {
		return normalizePermissions(command.help.permissions);
	}

	const json = command.data?.toJSON?.();

	if (!json?.default_member_permissions || String(json.default_member_permissions) === `0`) {
		return [];
	}

	return normalizePermissions([json.default_member_permissions]);
}

function getDefaultCategoryId(command) {
	if (command.commandScope === `guild`) {
		return `diagnostics`;
	}

	const filePath = command.filePath || ``;

	if (filePath.includes(`admin`)) {
		return `management`;
	}

	if (filePath.includes(`setup`)) {
		return `management`;
	}

	return `general`;
}

function commandLabel(command) {
	const json = command.data?.toJSON?.();
	const prefix = json?.type && json.type !== 1 ? `` : `/`;

	return `${prefix}${command.data.name}`;
}

function fallbackEntry(command) {
	return {
		command: commandLabel(command),
		description: command.data.description || `Use this command.`,
		permissions: getCommandPermissions(command),
	};
}

function normalizeEntry(entry, command) {
	if (Array.isArray(entry)) {
		return {
			command: entry[0],
			description: entry[1],
			permissions: getCommandPermissions(command),
		};
	}

	return {
		category: entry.category || null,
		command: entry.command || commandLabel(command),
		description: entry.description || command.data.description || `Use this command.`,
		permissions: normalizePermissions(entry.permissions || command.help?.permissions || getCommandPermissions(command)),
	};
}

function normalizeCommandHelp(command) {
	const help = command.help || {};
	const categoryId = help.category || getDefaultCategoryId(command);
	const entries = help.entries?.length ?
		help.entries.map(entry => normalizeEntry(entry, command)) :
		[fallbackEntry(command)];

	return entries.map(entry => ({
		...entry,
		categoryId: entry.category || categoryId,
	}));
}

function canUsePermissions(memberPermissions, permissions) {
	const normalized = normalizePermissions(permissions);

	if (!normalized.length) {
		return true;
	}

	if (memberPermissions?.has(PermissionFlagsBits.Administrator)) {
		return true;
	}

	return normalized.some(permission => memberPermissions?.has(permission));
}

function categoryDetails(categoryId) {
	const defaults = CATEGORY_DEFAULTS[categoryId] || DEFAULT_CATEGORY;

	return {
		...defaults,
		id: categoryId,
	};
}

function buildHelpCatalog(commands) {
	const categories = new Map();

	for (const command of commands.values()) {
		if (command.help?.hidden) {
			continue;
		}

		for (const entry of normalizeCommandHelp(command)) {
			const details = categoryDetails(entry.categoryId);
			const category = categories.get(details.id) || {
				...details,
				entries: [],
				permissions: [],
			};

			category.entries.push(entry);
			category.permissions.push(...entry.permissions);
			categories.set(details.id, category);
		}
	}

	return [...categories.values()]
		.map(category => ({
			...category,
			entries: category.entries.sort((left, right) => left.command.localeCompare(right.command)),
			permissions: [...new Set(category.permissions.map(permission => permission.toString()))].map(permission => BigInt(permission)),
		}))
		.sort((left, right) => {
			if (left.sortOrder !== right.sortOrder) {
				return left.sortOrder - right.sortOrder;
			}

			return left.name.localeCompare(right.name);
		});
}

function filterCatalogForMember(catalog, memberPermissions) {
	return catalog
		.map(category => ({
			...category,
			entries: category.entries.filter(entry => canUsePermissions(memberPermissions, entry.permissions)),
		}))
		.filter(category => category.entries.length);
}

function getCatalogByIds(catalog, categoryIds) {
	const selected = new Set(categoryIds);

	return catalog.filter(category => selected.has(category.id));
}

function formatCategoryValue(category) {
	return category.entries
		.map(entry => line(entry.command, entry.description))
		.join(`\n`);
}

function canPostPublicHelp(memberPermissions) {
	return canUsePermissions(memberPermissions, [
		PermissionFlagsBits.Administrator,
		PermissionFlagsBits.ManageGuild,
		PermissionFlagsBits.ManageMessages,
		PermissionFlagsBits.ModerateMembers,
	]);
}

module.exports = {
	buildHelpCatalog,
	canPostPublicHelp,
	filterCatalogForMember,
	formatCategoryValue,
	getCatalogByIds,
};
