// In-memory cache for provider app auth tokens.
//
// Cron jobs refresh these tokens periodically, and stream-check modules read
// them when calling Twitch/Kick APIs. They are runtime access tokens, not the
// encrypted developer secrets stored in .env.
let authTokens = {
	twitchAuthToken: null,
	kickAuthToken: null,
	updatedAt: null,
};

function getAuthTokens() {
	return { ...authTokens };
}

function updateAuthTokens(tokens) {
	authTokens = {
		...authTokens,
		...tokens,
		updatedAt: new Date().toISOString(),
	};
}

function invalidateAuthToken(tokenKey, rejectedToken) {
	// An older in-flight API response must not discard a token that was already
	// refreshed by another request.
	if (!rejectedToken || authTokens[tokenKey] !== rejectedToken) {
		return false;
	}
	authTokens = { ...authTokens, [tokenKey]: null };
	return true;
}

module.exports = {
	getAuthTokens,
	invalidateAuthToken,
	updateAuthTokens,
};
