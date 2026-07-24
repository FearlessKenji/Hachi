// Social-link normalization and embed-provider routing.
//
// Provider rules live together so automatic replies and the profile-installed
// context menu cannot drift into different URL-cleaning behavior.
const { URL, URLSearchParams } = require(`node:url`);

const MAX_FIXED_LINKS = 5;
const URL_PATTERN = /https?:\/\/[^\s<>]+/giu;
const TRAILING_PUNCTUATION = /[.,!?;:|\]]+$/u;

function hostRule(platform, sourceHosts, targetHost, options = {}) {
	return {
		platform,
		sourceHosts: new Set(sourceHosts),
		targetHost,
		...options,
	};
}

const PROVIDERS = [
	hostRule(`Instagram`, [`instagram.com`, `www.instagram.com`], `www.kkinstagram.com`),
	hostRule(`TikTok`, [`tiktok.com`, `www.tiktok.com`, `m.tiktok.com`], `kktiktok.com`),
	hostRule(`X`, [`twitter.com`, `www.twitter.com`, `mobile.twitter.com`], `fxtwitter.com`),
	hostRule(`X`, [`x.com`, `www.x.com`, `mobile.x.com`], `fixupx.com`),
	hostRule(`Reddit`, [`reddit.com`, `www.reddit.com`, `old.reddit.com`], `rxddit.com`),
	hostRule(`Bluesky`, [`bsky.app`], `embedfix.com`),
	hostRule(`Threads`, [`threads.net`, `www.threads.net`, `threads.com`, `www.threads.com`], `embedfix.com`),
	hostRule(`Tumblr`, [`tumblr.com`, `www.tumblr.com`], `embedfix.com`),
	hostRule(`Pixiv`, [`pixiv.net`, `www.pixiv.net`], `embedfix.com`, {
		pathPattern: /^\/(?:[a-z]{2}\/)?artworks\/\d+(?:\/\d+)?\/?$/u,
	}),
	hostRule(`Pinterest`, [`pinterest.com`, `www.pinterest.com`], `embedfix.com`, {
		pathPattern: /^\/pin\//u,
	}),
	hostRule(`Twitch`, [`clips.twitch.tv`], `fxtwitch.seria.moe`, {
		pathPattern: /^\/[^/]+\/?$/u,
	}),
	hostRule(`Twitch`, [`twitch.tv`, `www.twitch.tv`, `m.twitch.tv`], `fxtwitch.seria.moe`, {
		// FxTwitch supports channel, clip, and VoD paths; timestamps on VoDs are
		// functional navigation data rather than tracking and must survive.
		pathPattern: /^\/(?:[^/]+\/clip\/[^/]+|[^/]+|videos\/\d+)\/?$/u,
		preserveParameters: new Set([`t`]),
	}),
];

function trimUrlCandidate(candidate) {
	let value = candidate.replace(TRAILING_PUNCTUATION, ``);

	// A closing parenthesis is punctuation only when it is not balanced inside
	// the URL, such as a URL followed by prose in parentheses.
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

function findProvider(url) {
	return PROVIDERS.find(provider =>
		provider.sourceHosts.has(url.hostname.toLowerCase()) &&
		(!provider.pathPattern || provider.pathPattern.test(url.pathname)),
	) || null;
}

function cleanSearch(url, provider) {
	if (!provider.preserveParameters?.size) {
		url.search = ``;
		return;
	}

	const preserved = new URLSearchParams();

	for (const parameter of provider.preserveParameters) {
		for (const value of url.searchParams.getAll(parameter)) {
			preserved.append(parameter, value);
		}
	}

	url.search = preserved.toString();
}

function fixSocialUrl(value) {
	let url;

	try {
		url = new URL(value);
	} catch {
		return null;
	}

	if (url.protocol !== `https:` && url.protocol !== `http:`) {
		return null;
	}

	const provider = findProvider(url);

	if (!provider) {
		return null;
	}

	url.protocol = `https:`;
	url.username = ``;
	url.password = ``;
	url.port = ``;
	url.hostname = provider.targetHost;
	url.hash = ``;
	cleanSearch(url, provider);

	return {
		platform: provider.platform,
		url: url.toString(),
	};
}

function extractFixedSocialLinks(content, { limit = MAX_FIXED_LINKS } = {}) {
	if (!content || limit <= 0) {
		return [];
	}

	const results = [];
	const seen = new Set();

	for (const match of content.matchAll(URL_PATTERN)) {
		const fixed = fixSocialUrl(trimUrlCandidate(match[0]));

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

function markdownDestination(url) {
	return url.replace(/\(/gu, `%28`).replace(/\)/gu, `%29`);
}

function formatFixedSocialLinks(links) {
	if (!links.length) {
		return ``;
	}

	if (links.length === 1) {
		return `[Embed-friendly link](${markdownDestination(links[0].url)})`;
	}

	const platformTotals = new Map();
	const platformIndexes = new Map();

	for (const link of links) {
		platformTotals.set(link.platform, (platformTotals.get(link.platform) || 0) + 1);
	}

	return links.map(link => {
		const index = (platformIndexes.get(link.platform) || 0) + 1;
		const suffix = platformTotals.get(link.platform) > 1 ? ` ${index}` : ``;

		platformIndexes.set(link.platform, index);

		return `[Embed-friendly ${link.platform} link${suffix}](${markdownDestination(link.url)})`;
	}).join(`\n`);
}

function buildFixedSocialLinks(content, options) {
	const links = extractFixedSocialLinks(content, options);

	return {
		content: formatFixedSocialLinks(links),
		links,
	};
}

module.exports = {
	MAX_FIXED_LINKS,
	PROVIDERS,
	buildFixedSocialLinks,
	extractFixedSocialLinks,
	fixSocialUrl,
	formatFixedSocialLinks,
};
