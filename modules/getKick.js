const { Servers, Channels } = require(`../database/dbObjects.js`);
const userData = require(`./getKickUserData.js`);
const { EmbedBuilder } = require(`discord.js`);
const { writeLog } = require(`./writeLog.js`);
const fs = require(`node:fs`);

/**
 * Fetch Kick stream info for multiple channels in parallel.
 * Only fetches once per unique Kick username.
 */
async function getKickDataBatch(channelNames, clientID, authKey) {
	const uniqueNames = [...new Set(channelNames)];
	const results = await Promise.all(
		uniqueNames.map(async (name) => {
			try {
				const res = await fetch(
					`https://api.kick.com/public/v1/channels?slug=${name}`,
					{
						headers: {
							'Client-ID': clientID,
							'Authorization': `Bearer ${authKey}`,
						},
					},
				);

				if (!res.ok) {
					const text = await res.text();
					throw new Error(`HTTP ${res.status} - ${text}`);
				}

				const data = await res.json();

				return { name, data: data.data?.[0] ?? null };
			} catch (err) {
				console.error(writeLog(`Failed to fetch Kick data for ${name}:`, err));
				return { name, data: null };
			}
		}),
	);

	// IMPORTANT: normalize into lookup object for O(1)
	return Object.fromEntries(results.map(r => [r.name, r.data]));
}

/**
 * Main Kick monitoring loop
 * - Loads servers + channels
 * - Normalizes channel names once
 * - Groups channels by guild for fast lookup
 * - Fetches Kick data once globally
 * - Processes Discord updates per server
 */
async function checkKick(client) {
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

	// Build list of all usernames for Kick batch request
	const channelNames = validChannels.map(c => c.channelName);
	const streamsData = await getKickDataBatch(channelNames, config.kickClientId, config.kickAuthToken);

	for (const server of servers) {
		const guild = client.guilds.cache.get(server.guildId);
		// console.log(writeLog(`Checking channels for ${guild?.name ?? 'Unknown guild'} (ID: ${server.guildId})`));

		// O(1) lookup instead of filtering entire dataset per server
		const serverChannels = channelsByGuild.get(server.guildId) || [];

		// Process each channel in the server
		const channelPromises = serverChannels.map(async (chan) => {
			const streamInfo = streamsData[chan.channelName];

			// Skip if offline or notifications disabled
			if ((!streamInfo?.stream?.is_live && chan.kickIsLive) || !chan.kickNotif) {
				await Channels.update({ kickIsLive: streamInfo?.stream?.is_live }, { where: { id: chan.id } });
				return;
			}

			// Determine which Discord channel to post in
			const discordChannelId = chan.isSelf ?
				server.selfKickChannelId :
				server.affiliateChannelId;

			const discordChannel = client.channels.cache.get(discordChannelId);

			if (!discordChannel) {
				console.error(writeLog(`Kick updates cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}).`));
				return;
			}

			// Mention the appropriate role if available
			const roleMention = chan.isSelf ?
				server.selfKickRoleId ?
					`<@&${server.selfKickRoleId}> ` :
					`` :
				server.affiliateRoleId ?
					`<@&${server.affiliateRoleId}> ` :
					``;

			const userID = streamInfo.broadcaster_user_id;
			const kickUser = await userData.getData(
				userID,
				chan.channelName,
				config.kickClientId,
				config.kickAuthToken);

			const startTime = new Date(streamInfo.stream.start_time).toLocaleString();
			const editTime = new Date().toLocaleString();

			// Build embed fields
			const fields = [
				{
					name: `Playing`,
					value: streamInfo.category.name,
					inline: true,
				},
				{
					name: `Viewers`,
					value: streamInfo.stream.viewer_count.toString(),
					inline: true,
				},
				{
					name: `Kick`,
					value: `[Watch stream](https://www.kick.com/${streamInfo.slug})`,
				},
			];
			if (chan.discordUrl) {
				fields.push({
					name: `Discord Server`,
					value: `[Join here](${chan.discordUrl})`,
					inline: true,
				});
			}

			const sendEmbed = new EmbedBuilder()
				.setTitle(`${kickUser.name} is now live`)
				.setDescription(streamInfo.stream_title)
				.setURL(`https://www.kick.com/${streamInfo.slug}`)
				.setColor(0x00E701)
				.setFields(fields)
				.setFooter({ text: `Started ${startTime}. Last edited ${editTime}.` })
				.setThumbnail(kickUser.profile_picture)
				.setImage(`${streamInfo.stream.thumbnail}?cacheBypass=${Math.random()}`);

			const content = chan.isSelf ?
				`${roleMention}I just went live on Kick! I'm streaming ${streamInfo.category.name}!` :
				`${roleMention}An affiliate has gone live on Kick! They're streaming ${streamInfo.category.name}!`;

			// Send or edit Discord message
			try {
				let existingMessage = null;
				if (chan.kickMessageId) {
					// Edit existing live message
					existingMessage =
						discordChannel.messages.cache.get(chan.kickMessageId) ||
						await discordChannel.messages.fetch(chan.kickMessageId).catch(() => null);
				}
				if (existingMessage && chan.kickIsLive && streamInfo?.stream?.is_live) {
					// Edit existing live message
					await existingMessage.edit({ content, embeds: [sendEmbed] });
					return;
				}
				// Send new live message
				const message = await discordChannel.send({ content, embeds: [sendEmbed] });
				// Update DB with new messageId
				await Channels.update({ kickMessageId: message.id, kickIsLive: streamInfo?.stream?.is_live }, { where: { id: chan.id } });
			} catch (err) {
				console.error(writeLog(`Failed to send/edit kick message for ${chan.channelName}:`, err));
			}
		});

		// Process all channels for this server concurrently
		await Promise.allSettled(channelPromises);
	}
}

module.exports = { checkKick };