// Kick VoD lookup helper.
//
// After a Kick stream ends, Hachi asks Kick for the most recent video so it can
// update the prior live notification with a replay link when one is available.
const { error, warn } = require(`../utils/writeLog.js`);
const missingChannelWarnings = new Set();

function isSecurityPolicyBlock(status, text) {
	return status === 403 && /security policy/iu.test(String(text || ``));
}

async function getLatest(channelName) {
	try {
		const res = await fetch(
			`https://kick.com/api/v1/channels/${channelName}`,
			{
				headers: {
					'Accept': `application/json`,
					'User-Agent': `Hachi`,
				},
			});

		if (!res.ok) {
			const text = await res.text();

			if (isSecurityPolicyBlock(res.status, text)) {
				warn(`Kick VoD lookup was blocked by Kick's security policy for ${channelName}.`);
				return {
					blocked: true,
					retryable: false,
					url: null,
				};
			}
			if (res.status === 404) {
				if (!missingChannelWarnings.has(channelName)) {
					warn(`Kick's VoD endpoint returned HTTP 404 for ${channelName}; the replay lookup will be retried.`);
					missingChannelWarnings.add(channelName);
				}
				return null;
			}

			throw new Error(`HTTP ${res.status} - ${text}`);
		}

		missingChannelWarnings.delete(channelName);
		const data = await res.json();
		const livestream = data.previous_livestreams?.find(stream => stream.video?.uuid);

		if (!livestream) {
			return null;
		}

		return {
			title: livestream.session_title,
			url: `https://kick.com/${data.slug || channelName}/videos/${livestream.video.uuid}`,
			thumbnail: livestream.thumbnail?.src ||
				(typeof livestream.thumbnail === `string` ? livestream.thumbnail : null) ||
				livestream.video.thumbnail?.src ||
				(typeof livestream.video.thumbnail === `string` ? livestream.video.thumbnail : null),
		};
	} catch (err) {
		error(`Failed to fetch Kick VoD for ${channelName}:`, err);
		return null;
	}
}

module.exports = {
	getLatest,
	isSecurityPolicyBlock,
};
