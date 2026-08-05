// Validation and rewriting for guild-configured embed-provider host mappings.
const { URL } = require(`node:url`);
const { isIP } = require(`node:net`);

const MAX_FIXED_LINKS = 5;
const URL_PATTERN = /https?:\/\/[^\s<>]+/giu;
const TRAILING_PUNCTUATION = /[.,!?;:|\]]+$/u;
const RECOMMENDED_FIX_RULES = [
	{ sourceDomain: `instagram.com`, targetDomain: `www.kkinstagram.com` },
	{ sourceDomain: `tiktok.com`, targetDomain: `kktiktok.com` },
];

function normalizeDomain(value) {
	const input = String(value || ``).trim().toLowerCase().replace(/\.$/u, ``);

	if (!input || input.includes(`/`) || input.includes(`@`) || input.includes(`:`)) {
		return null;
	}

	try {
		const url = new URL(`https://${input}`);
		return url.hostname === input && url.hostname.includes(`.`) && !isIP(url.hostname) ? url.hostname : null;
	} catch {
		return null;
	}
}

function trimUrlCandidate(candidate) {
	let value = candidate.replace(TRAILING_PUNCTUATION, ``);
	while (value.endsWith(`)`) && (value.match(/\)/gu) || []).length > (value.match(/\(/gu) || []).length) {
		value = value.slice(0, -1);
	}
	return value;
}

function findRule(hostname, rules) {
	const host = hostname.toLowerCase();
	return rules.find(rule => host === rule.sourceDomain || host.endsWith(`.${rule.sourceDomain}`)) || null;
}

function fixSocialUrl(value, rules = []) {
	let url;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (![`http:`, `https:`].includes(url.protocol)) {
		return null;
	}

	const rule = findRule(url.hostname, rules);
	if (!rule) {
		return null;
	}

	url.protocol = `https:`;
	url.username = ``;
	url.password = ``;
	url.port = ``;
	url.hostname = rule.targetDomain;
	url.search = ``;
	url.hash = ``;

	return { platform: rule.sourceDomain, url: url.toString() };
}

function extractFixedSocialLinks(content, rules, { limit = MAX_FIXED_LINKS } = {}) {
	if (!content || !rules?.length || limit <= 0) {
		return [];
	}
	const results = [];
	const seen = new Set();

	for (const match of content.matchAll(URL_PATTERN)) {
		const fixed = fixSocialUrl(trimUrlCandidate(match[0]), rules);
		if (!fixed || seen.has(fixed.url)) {
			continue;
		}
		seen.add(fixed.url);
		results.push(fixed);
		if (results.length >= limit) {
			break;
		}
	}
	return results;
}

function formatFixedSocialLinks(links) {
	return links.map(link => link.url).join(`\n`);
}

function buildFixedSocialLinks(content, rules, options) {
	const links = extractFixedSocialLinks(content, rules, options);
	return { content: formatFixedSocialLinks(links), links };
}

module.exports = {
	MAX_FIXED_LINKS,
	RECOMMENDED_FIX_RULES,
	buildFixedSocialLinks,
	extractFixedSocialLinks,
	fixSocialUrl,
	formatFixedSocialLinks,
	normalizeDomain,
};
