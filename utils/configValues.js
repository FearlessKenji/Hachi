// Shared helpers for reading flexible config/config.json ID fields.
//
// Older installs store one owner and one guild as botOwner/guildId strings.
// Newer installs can store botOwners/guildIds arrays. Keeping the normalization
// here lets runtime code, deployment scripts, and smoke tests agree on both
// shapes without scattering backward-compatibility checks through the project.

function splitIdText(value) {
	return String(value || ``)
		.split(/[\s,]+/u)
		.map(part => part.trim())
		.filter(part => part && !part.includes(`(REQUIRED)`));
}

function normalizeIdList(value) {
	if (Array.isArray(value)) {
		return value
			.flatMap(item => normalizeIdList(item))
			.filter(Boolean);
	}

	return splitIdText(value);
}

function uniqueIdList(values) {
	return [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
}

function getConfiguredOwnerIds(config = {}) {
	return uniqueIdList(normalizeIdList(config.botOwners ?? config.ownerIds ?? config.botOwner ?? config.ownerId));
}

function getConfiguredGuildIds(config = {}) {
	return uniqueIdList(normalizeIdList(config.guildIds ?? config.guildIDs ?? config.guildId ?? config.guildID));
}

function getPrimaryGuildId(config = {}) {
	return getConfiguredGuildIds(config)[0] || ``;
}

function isConfiguredOwner(config = {}, userId) {
	const ownerIds = getConfiguredOwnerIds(config);

	return Boolean(userId && ownerIds.includes(String(userId)));
}

module.exports = {
	getConfiguredGuildIds,
	getConfiguredOwnerIds,
	getPrimaryGuildId,
	isConfiguredOwner,
	normalizeIdList,
};
