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

module.exports = {
	getAuthTokens,
	updateAuthTokens,
};