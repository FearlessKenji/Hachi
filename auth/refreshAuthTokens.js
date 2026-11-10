// Scheduled provider-token refresh with bounded retries.
//
// Each provider has its own retry state. A failed request gets at most five
// follow-up attempts in a rolling hour; the hourly auth cron can begin a new
// cycle after the rate window permits another request.
const { fetchAuthToken } = require(`./fetchAuthToken.js`);
const { reserveAuthAttempt } = require(`./authAttemptBudget.js`);
const { invalidateAuthToken, updateAuthTokens } = require(`./authTokens.js`);
const { error, info, warn } = require(`../utils/writeLog.js`);

const MAX_ATTEMPTS_PER_HOUR = 6;
const RETRY_DELAYS_MS = [1, 2, 4, 8, 16].map(minutes => minutes * 60 * 1000);
const TOKEN_KEY_BY_PROVIDER = {
	Twitch: `twitchAuthToken`,
	Kick: `kickAuthToken`,
};
const providerStates = new Map();
let stopping = false;

function getProviderState(provider) {
	if (!providerStates.has(provider)) {
		providerStates.set(provider, {
			awaitingRecovery: false,
			inFlight: null,
			retryCount: 0,
			retryTimer: null,
		});
	}

	return providerStates.get(provider);
}

function scheduleAttempt(options, state, delayMs, isRetry) {
	if (stopping || state.retryTimer) {
		return;
	}

	state.retryTimer = setTimeout(() => {
		state.retryTimer = null;
		void refreshAuth(options, { isRetry }).catch(err => {
			error(`${options.provider} OAuth retry failed unexpectedly.`, err);
		});
	}, delayMs);

	// Retry timers should not keep an otherwise stopped bot process alive.
	state.retryTimer.unref();
}

async function refreshAuth(options, { isRetry = false } = {}) {
	if (stopping) {
		return false;
	}
	const { provider, tokenUrl, clientID, clientSecret, tokenKey } = options;
	const state = getProviderState(provider);

	if (state.inFlight) {
		return state.inFlight;
	}

	// The hourly cron must not create a second retry chain while one is pending.
	if (state.retryTimer) {
		return false;
	}

	if (!isRetry) {
		state.retryCount = 0;
	}

	const attempt = (async () => {
		try {
			// Reserve before transmitting credentials. A restart cannot bypass
			// the rolling-hour budget stored in SQLite.
			const reservation = await reserveAuthAttempt(provider);
			if (!reservation.allowed) {
				state.awaitingRecovery = true;
				warn(`${provider} OAuth request deferred until its hourly retry limit resets.`);
				scheduleAttempt(options, state, reservation.waitMs, isRetry);
				return false;
			}

			const authToken = await fetchAuthToken({ provider, tokenUrl, clientID, clientSecret });

			if (authToken) {
				updateAuthTokens({ [tokenKey]: authToken });
				// Routine hourly refreshes stay quiet; only resolve a previously
				// reported outage or rejected app token in the operator log.
				if (state.awaitingRecovery) {
					info(`${provider} OAuth app token recovered.`);
					state.awaitingRecovery = false;
				}
				state.retryCount = 0;
				return true;
			}
		} catch (err) {
			error(`${provider} OAuth request could not be completed.`, err);
		}
		state.awaitingRecovery = true;

		if (state.retryCount < RETRY_DELAYS_MS.length) {
			const retryDelayMs = RETRY_DELAYS_MS[state.retryCount];
			state.retryCount += 1;
			warn(`${provider} OAuth token unavailable; retry ${state.retryCount} of ${RETRY_DELAYS_MS.length} in ${retryDelayMs / 60000} minute(s).`);
			scheduleAttempt(options, state, retryDelayMs, true);
		} else {
			error(`${provider} OAuth token unavailable after ${MAX_ATTEMPTS_PER_HOUR} attempts; waiting for the next hourly refresh.`);
		}

		return false;
	})();
	state.inFlight = attempt.finally(() => {
		state.inFlight = null;
	});

	return state.inFlight;
}

function updateTwitch() {
	return refreshAuth({
		provider: `Twitch`,
		tokenUrl: `https://id.twitch.tv/oauth2/token`,
		clientID: process.env.twitchClientId,
		clientSecret: process.env.twitchSecret,
		tokenKey: `twitchAuthToken`,
	});
}

function updateKick() {
	return refreshAuth({
		provider: `Kick`,
		tokenUrl: `https://id.kick.com/oauth/token`,
		clientID: process.env.kickClientId,
		clientSecret: process.env.kickSecret,
		tokenKey: `kickAuthToken`,
	});
}

function handleUnauthorizedToken(provider, rejectedToken) {
	if (stopping) {
		return false;
	}
	const tokenKey = TOKEN_KEY_BY_PROVIDER[provider];
	if (!tokenKey || !invalidateAuthToken(tokenKey, rejectedToken)) {
		return false;
	}

	// One rejected app token can fail many batched requests. Clearing only the
	// still-current token and using the shared retry controller prevents a storm.
	warn(`${provider} app token was rejected; refresh will follow the retry budget.`);
	getProviderState(provider).awaitingRecovery = true;
	const refresh = provider === `Twitch` ? updateTwitch : updateKick;
	void refresh().catch(err => error(`${provider} OAuth recovery failed unexpectedly.`, err));
	return true;
}

function stopAuthRefreshRetries() {
	stopping = true;
	const pendingRequests = [];
	for (const state of providerStates.values()) {
		if (state.retryTimer) {
			clearTimeout(state.retryTimer);
			state.retryTimer = null;
		}
		if (state.inFlight) {
			pendingRequests.push(state.inFlight);
		}
	}
	// A retry already in flight may still be reserving a request in SQLite.
	return Promise.allSettled(pendingRequests);
}

module.exports = {
	handleUnauthorizedToken,
	refreshAuth,
	stopAuthRefreshRetries,
	updateKick,
	updateTwitch,
};
