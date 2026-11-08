// Bound provider HTTP calls so a stalled API cannot hold a polling job forever.
const PROVIDER_HTTP_TIMEOUT_MS = 20_000;

async function fetchProviderApi(url, options = {}) {
	const { appTokenProvider, ...requestOptions } = options;
	const timeoutSignal = globalThis.AbortSignal.timeout(PROVIDER_HTTP_TIMEOUT_MS);
	const signal = requestOptions.signal ?
		globalThis.AbortSignal.any([requestOptions.signal, timeoutSignal]) :
		timeoutSignal;

	const response = await fetch(url, { ...requestOptions, signal });
	if (response.status === 401 && appTokenProvider) {
		// Only calls explicitly using an app token participate. Twitch broadcaster
		// OAuth and device authorization have their own recovery paths.
		const authorization = requestOptions.headers?.Authorization;
		const rejectedToken = typeof authorization === `string` && authorization.startsWith(`Bearer `) ?
			authorization.slice(`Bearer `.length) :
			null;
		const { handleUnauthorizedToken } = require(`../auth/refreshAuthTokens.js`);
		handleUnauthorizedToken(appTokenProvider, rejectedToken);
	}
	return response;
}

module.exports = { fetchProviderApi };
