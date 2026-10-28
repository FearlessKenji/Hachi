// Resolve Kick channels by saved slug for entries that do not yet have a
// stable broadcaster ID. The channel response includes current live state.
const { URL } = require(`node:url`);
const { error } = require(`../utils/writeLog.js`);
const { fetchProviderApi } = require(`./providerFetch.js`);

const MAX_SLUGS_PER_REQUEST = 50;
const SINGLE_LOOKUP_FALLBACK_CONCURRENCY = 10;

function emptyResult(slug, failed = false) {
	return { slug, data: null, error: failed };
}

function matchingChannels(channels, slugs) {
	const requestedSlugs = new Set(slugs);
	const channelsBySlug = new Map();
	for (const channel of channels) {
		const slug = typeof channel?.slug === `string` ? channel.slug.toLowerCase() : null;
		if (slug && requestedSlugs.has(slug)) {
			// A response can contain unrelated channels. Never attach one to a
			// saved name unless Kick returned the exact requested slug.
			channelsBySlug.set(slug, channel);
		}
	}
	return new Map(slugs.map(slug => [slug, {
		slug,
		data: channelsBySlug.get(slug) ?? null,
		error: false,
	}]));
}

async function fetchSlugsIndividually(slugs, headers) {
	const results = new Map();
	// A bad slug can make a bulk request fail. Fall back only for invalid or
	// malformed batches, with the same bounded concurrency as the old path.
	for (let offset = 0; offset < slugs.length; offset += SINGLE_LOOKUP_FALLBACK_CONCURRENCY) {
		const wave = slugs.slice(offset, offset + SINGLE_LOOKUP_FALLBACK_CONCURRENCY);
		const waveResults = await Promise.all(wave.map(slug => fetchSlugGroup([slug], headers)));
		for (const groupResults of waveResults) {
			for (const [slug, result] of groupResults) {
				results.set(slug, result);
			}
		}
	}
	return results;
}

async function fetchSlugGroup(slugs, headers) {
	const url = new URL(`https://api.kick.com/public/v1/channels`);
	for (const slug of slugs) {
		url.searchParams.append(`slug`, slug);
	}

	let response;
	try {
		response = await fetchProviderApi(url.toString(), { headers });
	} catch (err) {
		error(`Failed to fetch Kick channels for ${slugs.length} slug(s):`, err);
		return new Map(slugs.map(slug => [slug, emptyResult(slug, true)]));
	}

	if (!response.ok) {
		if (slugs.length > 1 && (response.status === 400 || response.status === 404)) {
			return fetchSlugsIndividually(slugs, headers);
		}
		if (slugs.length === 1 && response.status === 404) {
			// Kick reports a missing saved slug as 404, not an API failure.
			return new Map([[slugs[0], emptyResult(slugs[0])]]);
		}
		error(`Kick channel lookup returned HTTP ${response.status} for ${slugs.length} slug(s).`);
		return new Map(slugs.map(slug => [slug, emptyResult(slug, true)]));
	}

	try {
		const body = await response.json();
		if (!Array.isArray(body?.data)) {
			throw new Error(`Kick channels response did not contain a data list.`);
		}
		return matchingChannels(body.data, slugs);
	} catch (err) {
		if (slugs.length > 1) {
			return fetchSlugsIndividually(slugs, headers);
		}
		error(`Failed to parse Kick channel data for ${slugs[0]}:`, err);
		return new Map([[slugs[0], emptyResult(slugs[0], true)]]);
	}
}

async function getStreams(channelNames, clientID, authKey) {
	const uniqueNames = [...new Set(channelNames)];
	const slugs = [...new Set(uniqueNames.map(name => name.toLowerCase()))];
	const headers = {
		'Client-ID': clientID,
		'Authorization': `Bearer ${authKey}`,
	};
	const resultsBySlug = new Map();

	for (let offset = 0; offset < slugs.length; offset += MAX_SLUGS_PER_REQUEST) {
		const batch = slugs.slice(offset, offset + MAX_SLUGS_PER_REQUEST);
		const batchResults = await fetchSlugGroup(batch, headers);
		for (const [slug, result] of batchResults) {
			resultsBySlug.set(slug, result);
		}
	}

	// Keep the old per-name contract for getKick.js, including case variants.
	return Object.fromEntries(uniqueNames.map(name => {
		const result = resultsBySlug.get(name.toLowerCase());
		return [name, { name, data: result?.data ?? null, error: result?.error ?? true }];
	}));
}

module.exports = { getStreams };
