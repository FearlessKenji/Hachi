// Twitch stream API client.
//
// The caller passes a list of channel names; this module batches requests to
// Twitch Helix and returns normalized stream records keyed by channel name.
const { fetchBatch } = require(`./streamUtils.js`);

async function getStreams(channelNames, clientID, authKey) {
	return fetchBatch({
		names: channelNames,
		provider: `Twitch`,
		urlFor: name => `https://api.twitch.tv/helix/streams?user_login=${name}`,
		headers: {
			'Client-ID': clientID,
			'Authorization': `Bearer ${authKey}`,
		},
		pickData: data => data.data[0],
	});
}

module.exports = { getStreams };
