const { Servers, Channels } = require(`../database/dbObjects.js`);
const { getChannelData } = require(`./getChannelData.js`);
const { getDataBatch } = require(`./getDataBatch.js`);
const { EmbedBuilder } = require(`discord.js`);
const { writeLog } = require(`./writeLog.js`);
const fs = require(`node:fs`);

/**
 * Main Twitch/Kick monitoring loop
 * - Loads servers + channels
 * - Normalizes channel names once
 * - Groups channels by guild for fast lookup
 * - Fetches Twitch/Kick data once globally
 * - Processes Discord updates per server
 */
async function getStreamInfo(mode, client) {
	// Mode: True = Twitch, False = Kick
	let config;
	try {
		config = JSON.parse(fs.readFileSync(`./config.json`, `utf-8`));
	}
	catch (err) {
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
	const streamsData = await getDataBatch(
		mode,
		channelNames,
		mode
			? config.twitchClientId
			: config.kickClientId,
		mode
			? config.twitchAuthToken
			: config.kickAuthToken,
	);

	for (const server of servers) {
		const guild = client.guilds.cache.get(server.guildId);

		// O(1) lookup instead of filtering entire dataset per server
		const serverChannels = channelsByGuild.get(server.guildId) || [];

		// Process each channel in the server
		const channelPromises = serverChannels.map(async (chan) => {
			const streamInfo = streamsData[chan.channelName];

			// Skip if offline or notifications disabled
			if (mode) {
				if (!streamInfo || !chan.twitchNotif) {
					return;
				}
			}
			else if ((!streamInfo?.stream?.is_live && chan.kickIsLive) || !chan.kickNotif) {
				await Channels.update(
					{
						kickIsLive: streamInfo?.stream?.is_live,
					},
					{
						where: {
							id: chan.id,
						},
					},
				);
				return;
			}
			// Determine which Discord channel to post in
			const discordChannelId = chan.isSelf
				? mode
					? server.selfTwitchChannelId
					: server.selfKickChannelId
				: server.affiliateChannelId;

			const discordChannel = client.channels.cache.get(discordChannelId);

			if (!discordChannel) {
				console.error(writeLog(`${mode ? `Twitch` : `Kick`} updates cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}).`));
				return;
			}

			// Mention the appropriate role if available
			const roleMention = chan.isSelf
				? mode
					? server.selfTwitchRoleId
						? `<@&${server.selfTwitchRoleId}> `
						: ``
					: server.selfKickRoleId
						? `<@&${server.selfKickRoleId}> `
						: ``
				: server.affiliateRoleId
					? `<@&${server.affiliateRoleId}> `
					: ``;

			const userID = streamInfo?.broadcaster_user_id;
			const streamChannel = await getChannelData(
				mode,
				mode
					? chan.channelName
					: userID,
				mode
					? config.twitchClientId
					: config.kickClientId,
				mode
					? config.twitchAuthToken
					: config.kickAuthToken,
			);

			if (!streamChannel) {
				return;
			}

			const startTime = new Date(mode ? streamInfo.started_at : streamInfo.stream.start_time).toLocaleString();
			const editTime = new Date().toLocaleString();

			// Build embed fields
			const fields = [
				{
					name: `Playing`,
					value: mode
						? streamChannel.game_name
						: streamInfo.category.name,
					inline: true,
				},
				{
					name: `Viewers`,
					value: mode
						? streamInfo.viewer_count.toString()
						: streamInfo.stream.viewer_count.toString(),
					inline: true,
				},
				{
					name: mode
						? `Twitch`
						: `Kick`,
					value: mode
						? `[Watch stream](https://www.twitch.tv/${streamChannel.broadcaster_login})`
						: `[Watch stream](https://www.kick.com/${streamInfo.slug})`,
				},
			];

			if (chan.discordUrl) {
				fields.push({
					name: `Discord`,
					value: `[Join here](${chan.discordUrl})`,
					inline: true,
				});
			}
			const sendEmbed = new EmbedBuilder()
				.setTitle(`${mode
					? streamChannel.display_name
					: streamChannel.name} is now live`)
				.setDescription(mode
					? streamChannel.title
					: streamInfo.stream_title)
				.setURL(mode
					? `https://www.twitch.tv/${streamChannel.broadcaster_login}`
					: `https://www.kick.com/${streamInfo.slug}`)
				.setColor(mode
					? 0x9146FF
					: 0x00E701)
				.setFields(fields)
				.setFooter({ text: `Started ${startTime}. Last edited ${editTime}.` })
				.setThumbnail(mode
					? streamChannel.thumbnail_url
					: streamChannel.profile_picture)
				.setImage(mode
					? `https://static-cdn.jtvnw.net/previews-ttv/live_user_${streamChannel.broadcaster_login}-640x360.jpg?cacheBypass=${Math.random()}`
					: `${streamInfo.stream.thumbnail}?cacheBypass=${Math.random()}`);

			const content = `${roleMention}${mode ? streamChannel.display_name : streamChannel.name} just went live on Twitch streaming ${mode ? streamChannel.game_name : streamInfo.category.name}!`;

			// Send or edit Discord message
			try {
				let existingMessage = null;
				if (mode
					? chan.twitchMessageId
					: chan.kickMessageId) {

					// Find existing live message
					existingMessage =
                        discordChannel.messages.cache.get(mode
                        	? chan.twitchMessageId
                        	: chan.kickMessageId) ||
                        await discordChannel.messages.fetch(mode
                        	? chan.twitchMessageId
                        	: chan.kickMessageId).catch(() => null);
				}

				if (mode
					? existingMessage && chan.twitchStreamId === streamInfo.id
					: existingMessage && chan.kickIsLive && streamInfo?.stream?.is_live) {
					// Edit existing live message
					await existingMessage.edit({ content, embeds: [sendEmbed] });
					return;
				}

				// Send new live message
				const message = await discordChannel.send({ content, embeds: [sendEmbed] });
				// Update DB with new messageId

				await Channels.update(mode
					? {
						twitchMessageId: message.id,
						twitchStreamId: streamInfo.id,
					}
					: {
						kickMessageId: message.id,
						kickIsLive: streamInfo?.stream?.is_live,
					},
				{
					where: {
						id: chan.id,
					},
				});
			}

			catch (err) {
				console.error(writeLog(`Failed to send/edit ${mode ? `Twitch` : `Kick`} message for ${chan.channelName}:`, err));
			}
		});

		// Process all channels for this server concurrently
		await Promise.allSettled(channelPromises);
	}
}

module.exports = { getStreamInfo };