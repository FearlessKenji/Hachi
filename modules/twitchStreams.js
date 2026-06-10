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
