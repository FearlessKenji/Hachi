// Twitch stream API client. Keep each requested login in the result, including
// offline channels, so callers can distinguish an offline stream from an API error.
const { error } = require(`../utils/writeLog.js`);
const { URLSearchParams } = require(`node:url`);
const { fetchProviderApi } = require(`./providerFetch.js`);

const TWITCH_STREAM_BATCH_SIZE = 100;

function httpError(status, body) {
	const detail = String(body || ``).replace(/\s+/gu, ` `).trim().slice(0, 240);
	return new Error(`HTTP ${status}${detail ? ` - ${detail}` : ``}`);
}

async function getStreams(channelNames, clientID, authKey) {
	const names = [...new Set(channelNames)];
	const results = Object.fromEntries(names.map(name => [name, { name, data: null, error: false }]));

	for (let offset = 0; offset < names.length; offset += TWITCH_STREAM_BATCH_SIZE) {
		const batch = names.slice(offset, offset + TWITCH_STREAM_BATCH_SIZE);
		const query = new URLSearchParams({ first: String(TWITCH_STREAM_BATCH_SIZE) });
		for (const name of batch) {
			query.append(`user_login`, name);
		}

		try {
			const response = await fetchProviderApi(`https://api.twitch.tv/helix/streams?${query}`, {
				headers: {
					'Client-ID': clientID,
					'Authorization': `Bearer ${authKey}`,
				},
			});
			if (!response.ok) {
				throw httpError(response.status, await response.text());
			}

			const body = await response.json();
			if (!Array.isArray(body?.data)) {
				throw new Error(`Twitch streams response did not contain a data list.`);
			}

			const streamsByLogin = new Map(body.data.map(stream => [
				String(stream.user_login).toLowerCase(),
				stream,
			]));
			for (const name of batch) {
				results[name].data = streamsByLogin.get(name.toLowerCase()) ?? null;
			}
		} catch (err) {
			error(`Failed to fetch Twitch stream data for a batch of ${batch.length} channel(s):`, err);
			for (const name of batch) {
				results[name].error = true;
			}
		}
	}

	return results;
}

module.exports = { getStreams };
