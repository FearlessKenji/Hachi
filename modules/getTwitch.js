const { Servers, Channels } = require(`../database/dbObjects.js`);
const { EmbedBuilder } = require(`discord.js`);
const { writeLog } = require(`./writeLog.js`);
const channelData = require(`./twitchChannelData.js`);
const fs = require(`node:fs`);

/**
 * Fetch Twitch stream info for multiple channels in parallel.
 * Only fetches once per unique Twitch username.
 */
async function getTwitchDataBatch(channelNames, clientID, authKey) {
	const uniqueNames = [...new Set(channelNames)];
	const results = await Promise.all(
		uniqueNames.map(async (name) => {
			try {
				const res = await fetch(
					`https://api.twitch.tv/helix/streams?user_login=${name}`,
					{
						headers: {
							'Client-ID': clientID,
							'Authorization': `Bearer ${authKey}`,
						},
					});

				if (!res.ok) {
					const text = await res.text();
					throw new Error(`HTTP ${res.status} - ${text}`);
				}

				const data = await res.json();
				return { name, data: data.data[0] ?? null }; // null if offline
			} catch (err) {
				console.error(writeLog(`Failed to fetch Twitch data for ${name}:`, err));
				return { name, data: null };
			}
		}),
	);

	// Convert array of tuples into lookup object for O(1) access
	return Object.fromEntries(results.map(r => [r.name, r.data]));
}

/**
 * Main Twitch monitoring loop
 * - Loads servers + channels
 * - Normalizes channel names once
 * - Groups channels by guild for fast lookup
 * - Fetches Twitch data once globally
 * - Processes Discord updates per server
 */
async function checkTwitch(client) {
	// Load config
	let config;
	try {
		config = JSON.parse(fs.readFileSync(`./config.json`, `utf-8`));
	} catch (err) {
		console.error(writeLog(`Failed to read config.json:`, err));
		return;
	}

	// Fetch all db data
	const [servers, channels] = await Promise.all([
		Servers.findAll({ raw: true }),
		Channels.findAll({ raw: true }),
	]);

	// Remove invalid or malformed channel names
	const validChannels = channels.filter(
		c => c.channelName && /^[a-z0-9_]+$/.test(c.channelName),
	);

	// Group channels by guildId for fast lookup (removes per-server filtering)
	const channelsByGuild = new Map();

	for (const chan of validChannels) {
		if (!channelsByGuild.has(chan.guildId)) {
			channelsByGuild.set(chan.guildId, []);
		}

		channelsByGuild.get(chan.guildId).push(chan);
	}

	// Build list of all usernames for Twitch batch request
	const channelNames = validChannels.map(c => c.channelName);
	const streamsData = await getTwitchDataBatch(channelNames, config.twitchClientId, config.twitchAuthToken);

	for (const server of servers) {
		const guild = client.guilds.cache.get(server.guildId);
		// console.log(writeLog(`Checking channels for ${guild?.name ?? 'Unknown guild'} (ID: ${server.guildId})`));

		// O(1) lookup instead of filtering entire dataset per server
		const serverChannels = channelsByGuild.get(server.guildId) || [];

		// Process each channel in the server
		const channelPromises = serverChannels.map(async (chan) => {
			const streamInfo = streamsData[chan.channelName];

			// Skip if offline or notifications disabled
			if (!streamInfo || !chan.twitchNotif) {
				return;
			}

			// Determine which Discord channel to post in
			const discordChannelId = chan.isSelf ?
				server.selfTwitchChannelId :
				server.affiliateChannelId;

			const discordChannel = client.channels.cache.get(discordChannelId);

			if (!discordChannel) {
				console.error(writeLog(`Twitch updates cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}).`));
				return;
			}

			// Mention the appropriate role if available
			const roleMention = chan.isSelf ?
				server.selfTwitchRoleId ?
					`<@&${server.selfTwitchRoleId}> ` :
					`` :
				server.affiliateRoleId ?
					`<@&${server.affiliateRoleId}> ` :
					``;

			const twitchChannel = await channelData.getData(
				chan.channelName,
				config.twitchClientId,
				config.twitchAuthToken);

			if (!twitchChannel) {
				return;
			}
			const startTime = new Date(streamInfo.started_at).toLocaleString();
			const editTime = new Date().toLocaleString();

			// Build embed fields
			const fields = [
				{
					name: `Playing`,
					value: twitchChannel.game_name,
					inline: true,
				},
				{
					name: `Viewers`,
					value: streamInfo.viewer_count.toString(),
					inline: true,
				},
				{
					name: `Twitch`,
					value: `[Watch stream](https://www.twitch.tv/${twitchChannel.broadcaster_login})`,
				},
			];

			if (chan.discordUrl) {
				fields.push({
					name: `Discord Server`,
					value: `[Join here](${chan.discordUrl})`,
				});
			}

			const sendEmbed = new EmbedBuilder()
				.setTitle(`${twitchChannel.display_name} is now live`)
				.setDescription(twitchChannel.title)
				.setURL(`https://www.twitch.tv/${twitchChannel.broadcaster_login}`)
				.setColor(0x9146FF)
				.setFields(fields)
				.setFooter({ text: `Started ${startTime}. Last edited ${editTime}.` })
				.setThumbnail(twitchChannel.thumbnail_url)
				.setImage(`https://static-cdn.jtvnw.net/previews-ttv/live_user_${twitchChannel.broadcaster_login}-640x360.jpg?cacheBypass=${Math.random()}`);

			const content = chan.isSelf ?
				`${roleMention}I just went live on Twitch! I'm streaming ${twitchChannel.game_name}!` :
				`${roleMention}An affiliate has gone live on Twitch! They're streaming ${twitchChannel.game_name}!`;

			// Send or edit Discord message
			try {
				let existingMessage = null;
				if (chan.twitchMessageId) {
					// Edit existing live message
					existingMessage =
						discordChannel.messages.cache.get(chan.twitchMessageId) ||
						await discordChannel.messages.fetch(chan.twitchMessageId).catch(() => null);
				}
				if (existingMessage && chan.twitchStreamId === streamInfo.id) {
					await existingMessage.edit({ content, embeds: [sendEmbed] });
					return;
				}
				// Send new live message
				const message = await discordChannel.send({ content, embeds: [sendEmbed] });
				// Update DB with new messageId
				await Channels.update({ twitchMessageId: message.id, twitchStreamId: streamInfo.id }, { where: { id: chan.id } });
			} catch (err) {
				console.error(writeLog(`Failed to send/edit Twitch message for ${chan.channelName}:`, err));
			}
		});

		// Process all channels for this server concurrently
		await Promise.allSettled(channelPromises);
	}
}

module.exports = { checkTwitch };