// Fetch Kick user profiles for live announcements. Channel responses do not
// include the display name and profile picture shown in Discord embeds.
const { URL } = require(`node:url`);
const { error } = require(`../utils/writeLog.js`);
const { fetchProviderApi } = require(`./providerFetch.js`);
const { normalizeBroadcasterId } = require(`./kickIdentity.js`);

// Kick accepts repeated user IDs. Keep requests short even though its public
// schema does not specify a maximum for this endpoint.
const MAX_USERS_PER_REQUEST = 50;
const FALLBACK_CONCURRENCY = 10;

async function fetchUsers(userIds, clientID, authKey) {
	const url = new URL(`https://api.kick.com/public/v1/users`);
	for (const userId of userIds) {
		url.searchParams.append(`id`, userId);
	}

	const response = await fetchProviderApi(url.toString(), {
		headers: {
			'Client-ID': clientID,
			'Authorization': `Bearer ${authKey}`,
		},
	});
	if (!response.ok) {
		const requestError = new Error(`HTTP ${response.status}: ${response.statusText}`);
		requestError.status = response.status;
		throw requestError;
	}

	const body = await response.json();
	if (!Array.isArray(body?.data)) {
		throw new Error(`Kick returned invalid user data.`);
	}

	const requestedIds = new Set(userIds);
	const usersById = new Map();
	for (const user of body.data) {
		const userId = normalizeBroadcasterId(user?.user_id);
		// Only an exact requested ID may supply a live announcement's identity.
		if (userId && requestedIds.has(userId) && typeof user.name === `string` && user.name) {
			usersById.set(userId, user);
		}
	}
	return usersById;
}

async function getUsersByIds(userIds, clientID, authKey) {
	const uniqueIds = [...new Set(userIds.map(normalizeBroadcasterId).filter(Boolean))];
	const usersById = new Map();

	for (let offset = 0; offset < uniqueIds.length; offset += MAX_USERS_PER_REQUEST) {
		const batch = uniqueIds.slice(offset, offset + MAX_USERS_PER_REQUEST);
		try {
			for (const [userId, user] of await fetchUsers(batch, clientID, authKey)) {
				usersById.set(userId, user);
			}
		} catch (err) {
			if (batch.length === 1 || (err.status !== 400 && err.status !== 404)) {
				// Auth, rate-limit, and provider failures should retry on the next
				// poll, not fan out into many likely failing requests.
				error(`Failed to fetch Kick user profiles for ${batch.length} account(s):`, err);
				continue;
			}

			// A bad or missing ID can reject a mixed batch. Isolate its members
			// with bounded concurrency so valid live alerts can still be sent.
			for (let index = 0; index < batch.length; index += FALLBACK_CONCURRENCY) {
				const fallbackIds = batch.slice(index, index + FALLBACK_CONCURRENCY);
				const results = await Promise.all(fallbackIds.map(async userId => {
					try {
						return await fetchUsers([userId], clientID, authKey);
					} catch (fallbackError) {
						error(`Failed to fetch Kick user profile for ID ${userId}:`, fallbackError);
						return new Map();
					}
				}));
				for (const result of results) {
					for (const [userId, user] of result) {
						usersById.set(userId, user);
					}
				}
			}
		}
	}

	return usersById;
}

module.exports = { getUsersByIds };
