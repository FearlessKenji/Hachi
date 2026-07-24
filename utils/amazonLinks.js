// Amazon product-link canonicalization for the on-demand context menu.
//
// Only recognized product paths are shortened. Search, wish-list, storefront,
// account, and shortened redirect URLs are left untouched to avoid changing
// their destination or requiring Hachi to follow an external redirect.
const { URL } = require(`node:url`);

const MAX_AMAZON_LINKS = 5;
const URL_PATTERN = /https?:\/\/[^\s<>]+/giu;
const TRAILING_PUNCTUATION = /[.,!?;:|\]]+$/u;
const AMAZON_DOMAINS = new Set([
	`amazon.ae`,
	`amazon.ca`,
	`amazon.co.jp`,
	`amazon.co.uk`,
	`amazon.co.za`,
	`amazon.com`,
	`amazon.com.au`,
	`amazon.com.be`,
	`amazon.com.br`,
	`amazon.com.mx`,
	`amazon.com.tr`,
	`amazon.de`,
	`amazon.eg`,
	`amazon.es`,
	`amazon.fr`,
	`amazon.ie`,
	`amazon.in`,
	`amazon.it`,
	`amazon.nl`,
	`amazon.pl`,
	`amazon.sa`,
	`amazon.se`,
	`amazon.sg`,
]);
const AMAZON_HOST_PREFIXES = new Set([`m`, `smile`, `www`]);
const PRODUCT_PATH_PATTERNS = [
	/(?:^|\/)dp\/([a-z0-9]{10})(?:\/|$)/iu,
	/^\/gp\/product\/([a-z0-9]{10})(?:\/|$)/iu,
	/^\/gp\/aw\/d\/([a-z0-9]{10})(?:\/|$)/iu,
	/^\/exec\/obidos\/ASIN\/([a-z0-9]{10})(?:\/|$)/iu,
	/^\/o\/ASIN\/([a-z0-9]{10})(?:\/|$)/iu,
];

function trimUrlCandidate(candidate) {
	let value = candidate.replace(TRAILING_PUNCTUATION, ``);

	while (value.endsWith(`)`)) {
		const opens = (value.match(/\(/gu) || []).length;
		const closes = (value.match(/\)/gu) || []).length;

		if (closes <= opens) {
			break;
		}

		value = value.slice(0, -1);
	}

	return value;
}

function getAmazonDomain(hostname) {
	const normalized = hostname.toLowerCase();

	if (AMAZON_DOMAINS.has(normalized)) {
		return normalized;
	}

	const [prefix, ...domainParts] = normalized.split(`.`);
	const domain = domainParts.join(`.`);

	return AMAZON_HOST_PREFIXES.has(prefix) && AMAZON_DOMAINS.has(domain) ?
		domain :
		null;
}

function getProductAsin(pathname) {
	for (const pattern of PRODUCT_PATH_PATTERNS) {
		const match = pathname.match(pattern);

		if (match) {
			return match[1].toUpperCase();
		}
	}

	return null;
}

function shortenAmazonUrl(value) {
	let url;

	try {
		url = new URL(value);
	} catch {
		return null;
	}

	if (url.protocol !== `https:` && url.protocol !== `http:`) {
		return null;
	}

	const domain = getAmazonDomain(url.hostname);
	const asin = getProductAsin(url.pathname);

	if (!domain || !asin) {
		return null;
	}

	return {
		asin,
		url: `https://www.${domain}/dp/${asin}`,
	};
}

function extractShortAmazonLinks(content, { limit = MAX_AMAZON_LINKS } = {}) {
	if (!content || limit <= 0) {
		return [];
	}

	const links = [];
	const seen = new Set();

	for (const match of content.matchAll(URL_PATTERN)) {
		const shortened = shortenAmazonUrl(trimUrlCandidate(match[0]));

		if (!shortened || seen.has(shortened.url)) {
			continue;
		}

		seen.add(shortened.url);
		links.push(shortened);

		if (links.length >= limit) {
			break;
		}
	}

	return links;
}

function formatShortAmazonLinks(links) {
	if (links.length === 1) {
		return `[Short Amazon link](${links[0].url})`;
	}

	return links
		.map((link, index) => `[Short Amazon link ${index + 1}](${link.url})`)
		.join(`\n`);
}

function buildShortAmazonLinks(content, options) {
	const links = extractShortAmazonLinks(content, options);

	return {
		content: links.length ? formatShortAmazonLinks(links) : ``,
		links,
	};
}

module.exports = {
	AMAZON_DOMAINS,
	MAX_AMAZON_LINKS,
	buildShortAmazonLinks,
	extractShortAmazonLinks,
	formatShortAmazonLinks,
	shortenAmazonUrl,
};
