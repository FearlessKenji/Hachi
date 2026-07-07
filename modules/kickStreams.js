const { fetchBatch } = require(`./streamUtils.js`);

async function getStreams(channelNames, clientID, authKey) {
	return fetchBatch({
		names: channelNames,
		provider: `Kick`,
		urlFor: name => `https://api.kick.com/public/v1/channels?slug=${name}`,
		headers: {
			'Client-ID': clientID,
			'Authorization': `Bearer ${authKey}`,
		},
		pickData: data => data.data?.[0],
	});
}

module.exports = { getStreams };
