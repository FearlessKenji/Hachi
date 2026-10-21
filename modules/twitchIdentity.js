// Resolve configured Twitch channels by their stable user ID when available.
// Login lookups bind older rows that have not yet recorded an ID.
const { error } = require(`../utils/writeLog.js`);
const { URL } = require(`node:url`);

const MAX_USERS_PER_REQUEST = 100;

async function getTwitchUsers(channels, identityMap, clientID, authKey) {
	const requests = new Map();
	const requestKeysByChannel = new Map();

	for (const chan of channels) {
		const userId = identityMap.get(chan.id)?.providerUserId;
		const login = chan.channelName.toLowerCase();
		const key = userId ? `id:${userId}` : `login:${login}`;

		if (!requests.has(key)) {
			requests.set(key, {
				key,
				parameter: userId ? `id` : `login`,
				value: userId || login,
			});
		}

		requestKeysByChannel.set(chan.id, key);
	}

	const usersByRequest = new Map();
	const uniqueRequests = [...requests.values()];

	for (let offset = 0; offset < uniqueRequests.length; offset += MAX_USERS_PER_REQUEST) {
		const batch = uniqueRequests.slice(offset, offset + MAX_USERS_PER_REQUEST);
		const url = new URL(`https://api.twitch.tv/helix/users`);
		for (const request of batch) {
			url.searchParams.append(request.parameter, request.value);
		}

		try {
			const response = await fetch(url, {
				headers: {
					'Client-ID': clientID,
					'Authorization': `Bearer ${authKey}`,
				},
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			const body = await response.json();
			if (!Array.isArray(body?.data)) {
				throw new Error(`Twitch returned invalid user data`);
			}

			const usersById = new Map();
			const usersByLogin = new Map();
			for (const user of body.data) {
				if (typeof user?.id !== `string` || typeof user.login !== `string` || !user.id || !user.login) {
					continue;
				}

				usersById.set(user.id, user);
				usersByLogin.set(user.login.toLowerCase(), user);
			}

			// Match the requested identifier exactly; an unrelated search result must
			// never be allowed to rebind a configured channel.
			for (const request of batch) {
				const user = request.parameter === `id` ?
					usersById.get(request.value) :
					usersByLogin.get(request.value);
				if (user) {
					usersByRequest.set(request.key, user);
				}
			}
		} catch (err) {
			error(`Failed to fetch Twitch account identities:`, err);
		}
	}

	const usersByChannel = new Map();
	for (const [channelId, requestKey] of requestKeysByChannel) {
		const user = usersByRequest.get(requestKey);
		if (user) {
			usersByChannel.set(channelId, user);
		}
	}

	return usersByChannel;
}

module.exports = { getTwitchUsers };
