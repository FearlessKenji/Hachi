// Synchronize guild block domains into one Hachi-owned Discord AutoMod rule.
const {
	AutoModerationActionType,
	AutoModerationRuleEventType,
	AutoModerationRuleTriggerType,
} = require(`discord.js`);
const { LinkConfigs } = require(`../database/dbObjects.js`);

const RULE_NAME = `Hachi Blocked Links`;
const BLOCK_MESSAGE = `Your message contained a link that is not allowed on this server.`;
const MAX_BLOCKED_DOMAINS = 100;
const MAX_BLOCKED_DOMAIN_LENGTH = 58;
const AFFILIATE_DOMAIN_GROUPS = [
	[`facebook.com`, `facecot.com`],
	[`instagram.com`, `kkinstagram.com`],
	[`tiktok.com`, `kktiktok.com`],
];

function domainKeyword(domain) {
	// AutoMod wildcards intentionally block every occurrence, including masked
	// links, emails, and deceptive longer hostnames containing the domain.
	return `*${domain}*`;
}

function expandAffiliateDomains(domain, fixRules = []) {
	const baseDomain = domain.replace(/^www\./u, ``);
	const groups = [
		...AFFILIATE_DOMAIN_GROUPS,
		...fixRules.map(rule => [rule.sourceDomain, rule.targetDomain].map(value => value.replace(/^www\./u, ``))),
	];
	const affiliates = new Set([baseDomain]);
	let changed = true;

	// Mappings can form chains, so expand until every connected domain is known.
	while (changed) {
		changed = false;
		for (const group of groups) {
			if (!group.some(candidate => affiliates.has(candidate))) {
				continue;
			}
			for (const candidate of group) {
				if (!affiliates.has(candidate)) {
					affiliates.add(candidate);
					changed = true;
				}
			}
		}
	}

	return [...affiliates].sort();
}

async function getConfig(guildId) {
	const [config] = await LinkConfigs.findOrCreate({ where: { guildId } });
	return config;
}

async function fetchManagedRule(guild, config) {
	if (!config.autoModRuleId) {
		return null;
	}
	try {
		return await guild.autoModerationRules.fetch(config.autoModRuleId);
	} catch {
		return null;
	}
}

async function syncBlockRule(guild, domains, enabled) {
	if (domains.length > MAX_BLOCKED_DOMAINS) {
		throw new Error(`Discord AutoMod supports at most ${MAX_BLOCKED_DOMAINS} blocked domains in this configuration.`);
	}
	if (domains.some(domain => domain.length > MAX_BLOCKED_DOMAIN_LENGTH)) {
		throw new Error(`Discord AutoMod wildcard domains must be ${MAX_BLOCKED_DOMAIN_LENGTH} characters or fewer.`);
	}

	const config = await getConfig(guild.id);
	let rule = await fetchManagedRule(guild, config);

	if (!domains.length) {
		if (rule) {
			await rule.delete(`Hachi link blocklist is empty`);
		}
		await config.update({ autoModRuleId: null, blockingEnabled: false });
		return null;
	}

	const payload = {
		actions: [{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: BLOCK_MESSAGE } }],
		enabled,
		eventType: AutoModerationRuleEventType.MessageSend,
		name: RULE_NAME,
		reason: `Synchronize Hachi's blocked-link domains`,
		triggerMetadata: { keywordFilter: domains.map(domainKeyword) },
		triggerType: AutoModerationRuleTriggerType.Keyword,
	};

	if (rule) {
		rule = await rule.edit(payload);
	} else {
		rule = await guild.autoModerationRules.create(payload);
		await config.update({ autoModRuleId: rule.id });
	}

	await config.update({ blockingEnabled: enabled });
	return rule;
}

module.exports = {
	AFFILIATE_DOMAIN_GROUPS,
	BLOCK_MESSAGE,
	MAX_BLOCKED_DOMAINS,
	MAX_BLOCKED_DOMAIN_LENGTH,
	RULE_NAME,
	domainKeyword,
	expandAffiliateDomains,
	syncBlockRule,
};
