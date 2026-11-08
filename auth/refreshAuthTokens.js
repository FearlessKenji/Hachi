// Scheduled provider-token refresh with bounded retries.
//
// Each provider has its own retry state. A failed request gets at most five
// follow-up attempts in a rolling hour; the hourly auth cron can begin a new
// cycle after the rate window permits another request.
const { fetchAuthToken } = require(`./fetchAuthToken.js`);
const { updateAuthTokens } = require(`./authTokens.js`);
const { error, warn } = require(`../utils/writeLog.js`);

const HOUR_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS_PER_HOUR = 6;
const RETRY_DELAYS_MS = [1, 2, 4, 8, 16].map(minutes => minutes * 60 * 1000);
const providerStates = new Map();

function getProviderState(provider) {
	if (!providerStates.has(provider)) {
		providerStates.set(provider, {
			attemptTimes: [],
			inFlight: null,
			retryCount: 0,
			retryTimer: null,
		});
	}

	return providerStates.get(provider);
}

function scheduleAttempt(options, state, delayMs, isRetry) {
	if (state.retryTimer) {
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

	const now = Date.now();
	state.attemptTimes = state.attemptTimes.filter(attemptTime => now - attemptTime < HOUR_MS);

	if (state.attemptTimes.length >= MAX_ATTEMPTS_PER_HOUR) {
		const waitMs = Math.max(1, state.attemptTimes[0] + HOUR_MS - now);
		warn(`${provider} OAuth request deferred until its hourly retry limit resets.`);
		scheduleAttempt(options, state, waitMs, isRetry);
		return false;
	}

	state.attemptTimes.push(now);
	state.inFlight = (async () => {
		try {
			const authToken = await fetchAuthToken({ provider, tokenUrl, clientID, clientSecret });

			if (authToken) {
				updateAuthTokens({ [tokenKey]: authToken });
				state.retryCount = 0;
				return true;
			}
		} catch (err) {
			error(`${provider} OAuth refresh failed unexpectedly.`, err);
		} finally {
			state.inFlight = null;
		}

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

module.exports = {
	refreshAuth,
	updateKick,
	updateTwitch,
};
