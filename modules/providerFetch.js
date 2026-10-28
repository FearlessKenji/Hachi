// Bound provider HTTP calls so a stalled API cannot hold a polling job forever.
const PROVIDER_HTTP_TIMEOUT_MS = 20_000;

function fetchProviderApi(url, options = {}) {
	const timeoutSignal = globalThis.AbortSignal.timeout(PROVIDER_HTTP_TIMEOUT_MS);
	const signal = options.signal ?
		globalThis.AbortSignal.any([options.signal, timeoutSignal]) :
		timeoutSignal;

	return fetch(url, { ...options, signal });
}

module.exports = { fetchProviderApi };
