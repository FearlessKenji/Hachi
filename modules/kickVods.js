// Kick VoD lookup helper.
//
// Match Kick's past streams to the announcement's saved start time before
// supplying a replay link. The newest listed video may belong to another stream.
const { error, warn } = require(`../utils/writeLog.js`);
const { formatStreamTime } = require(`./streamUtils.js`);
const missingChannelWarnings = new Set();
const securityPolicyWarnings = new Set();

function isSecurityPolicyBlock(status, text) {
	return status === 403 && /security policy/iu.test(String(text || ``));
}

function parseKickStartTime(value) {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value;
	}
	if (typeof value !== `string` || !value.trim()) {
		return null;
	}
	// Kick's replay endpoint can omit the zone on a SQL-style UTC timestamp.
	const rawTime = value.trim().replace(` `, `T`);
	const zonedTime = /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(rawTime) ? rawTime : `${rawTime}Z`;
	const date = new Date(zonedTime);
	return Number.isNaN(date.getTime()) ? null : date;
}

function matchesStartLabel(livestream, startLabel) {
	for (const value of [livestream?.start_time, livestream?.created_at]) {
		const date = parseKickStartTime(value);
		// Old announcements retain only a displayed minute. Never link a replay
		// when more than one past stream fits that approximate window.
		if (date && [-60_000, 0, 60_000].some(offset =>
			formatStreamTime(new Date(date.getTime() + offset)) === startLabel)) {
			return true;
		}
	}

	return false;
}

async function getLatest(channelName, startLabel = null, providerStartTime = null) {
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
				if (!securityPolicyWarnings.has(channelName)) {
					warn(`Kick VoD lookup was blocked by Kick's security policy for ${channelName}.`);
					securityPolicyWarnings.add(channelName);
				}
				return {
					blocked: true,
					retryable: true,
					url: null,
				};
			}
			if (res.status === 404) {
				if (!missingChannelWarnings.has(channelName)) {
					warn(`Kick's VoD endpoint returned HTTP 404 for ${channelName}; the replay lookup will be retried.`);
					missingChannelWarnings.add(channelName);
				}
				return { retryable: true, url: null };
			}

			throw new Error(`HTTP ${res.status} - ${text}`);
		}

		missingChannelWarnings.delete(channelName);
		securityPolicyWarnings.delete(channelName);
		const data = await res.json();
		const pastStreams = Array.isArray(data.previous_livestreams) ? data.previous_livestreams : [];
		const exactStart = parseKickStartTime(providerStartTime);
		let matchingStreams;
		if (exactStart) {
			// Compare to the second to separate rapid restarts hidden by the
			// Discord footer minute.
			matchingStreams = pastStreams.filter(stream => {
				const pastStart = parseKickStartTime(stream.start_time || stream.created_at);
				return pastStart && Math.floor(pastStart.getTime() / 1000) ===
					Math.floor(exactStart.getTime() / 1000);
			});
		} else if (startLabel) {
			matchingStreams = pastStreams.filter(stream => matchesStartLabel(stream, startLabel));
		} else {
			matchingStreams = pastStreams.slice(0, 1);
		}
		// An ambiguous legacy minute is safer left pending than linked to the
		// wrong session. The first item without a saved start is a best effort.
		const livestream = matchingStreams.length === 1 ? matchingStreams[0] : null;

		if (!livestream?.video?.uuid) {
			return null;
		}

		return {
			title: livestream.session_title,
			startTime: livestream.start_time || livestream.created_at || null,
			url: `https://kick.com/${data.slug || channelName}/videos/${livestream.video.uuid}`,
			thumbnail: livestream.thumbnail?.src ||
				(typeof livestream.thumbnail === `string` ? livestream.thumbnail : null) ||
				livestream.video.thumbnail?.src ||
				(typeof livestream.video.thumbnail === `string` ? livestream.video.thumbnail : null),
		};
	} catch (err) {
		error(`Failed to fetch Kick VoD for ${channelName}:`, err);
		return { retryable: true, url: null };
	}
}

module.exports = {
	getLatest,
	isSecurityPolicyBlock,
	parseKickStartTime,
};
