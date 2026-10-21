// Resolve current Kick channel slugs by stable broadcaster user ID.
// A saved slug can stop resolving after a rename, so name monitoring must not
// depend on the same slug lookup used for live notifications.
const { URL } = require(`node:url`);
const { error } = require(`../utils/writeLog.js`);

const maxIdsPerRequest = 50;

function normalizeBroadcasterId(value) {
	const id = String(value ?? ``);
	return /^[1-9]\d*$/u.test(id) ? id : null;
}

async function getChannelsByBroadcasterIds(userIds, clientID, authKey) {
	const ids = [...new Set(userIds.map(normalizeBroadcasterId).filter(Boolean))];
	const channelsById = new Map();

	for (let offset = 0; offset < ids.length; offset += maxIdsPerRequest) {
		const batch = ids.slice(offset, offset + maxIdsPerRequest);
		const url = new URL(`https://api.kick.com/public/v1/channels`);
		for (const id of batch) {
			url.searchParams.append(`broadcaster_user_id`, id);
		}

		try {
			const res = await fetch(url.toString(), {
				headers: {
					'Client-ID': clientID,
					'Authorization': `Bearer ${authKey}`,
				},
			});
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}

			const response = await res.json();
			if (!Array.isArray(response.data)) {
				throw new Error(`Kick channel ID lookup returned invalid data.`);
			}

			// Ignore extra or malformed records rather than associating another
			// broadcaster with a saved channel identity.
			const requestedIds = new Set(batch);
			for (const channel of response.data) {
				const id = normalizeBroadcasterId(channel?.broadcaster_user_id);
				if (id && requestedIds.has(id) && typeof channel.slug === `string` && channel.slug) {
					channelsById.set(id, channel);
				}
			}
		} catch (err) {
			error(`Failed to fetch Kick channels by broadcaster ID:`, err);
		}
	}

	return channelsById;
}

module.exports = { getChannelsByBroadcasterIds, normalizeBroadcasterId };
