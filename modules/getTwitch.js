const { Servers, Channels } = require(`../database/dbObjects.js`);
const { EmbedBuilder } = require(`discord.js`);
const { writeLog } = require(`../utils/writeLog.js`);
const channelData = require(`./twitchChannelData.js`);
const twitchData = require(`./getTwitchDataBatch.js`);
const twitchVideos = require(`./getTwitchVideos.js`);
const authTokens = require(`../auth/authTokens.js`);
const twitchClientId = process.env.twitchClientId

function buildOfflineEmbed(existingEmbed, vod) {
	const embed = EmbedBuilder.from(existingEmbed);

	// Keep the original live embed intact, but replace the Twitch link with the VoD.
	const fields = existingEmbed.fields.map(field => {
		if (field.name === `Twitch`) {
			return {
				name: `Twitch`,
				value: `[Watch VoD](${vod.url})`,
				inline: field.inline,
			};
		}

		return field;
	});

	const title = existingEmbed.title.replace(`is now live`, `was live`);
	const footerText = existingEmbed.footer.text.replace(`Last edited`, `Stream ended`);
	const imageUrl = vod.thumbnail_url ? vod.thumbnail_url.replace(`%{width}`, `640`).replace(`%{height}`, `360`) : null;

	embed
		.setTitle(title)
		.setURL(vod.url)
		.setFields(fields)
		.setFooter({ text: footerText });

	if (imageUrl) {
		embed.setImage(imageUrl);
	}

	return embed;
}

async function updateOfflineTwitchMessage(chan, server, guild, client) {
	const twitchAuthToken = authTokens.getAuthTokens().twitchAuthToken
	
	if (!chan.twitchMessageId || !chan.twitchStreamId || !chan.twitchNotif) {
		return;
	}

	const discordChannelId = chan.isSelf ?
		server.selfTwitchChannelId :
		server.affiliateChannelId;
	const discordChannel = client.channels.cache.get(discordChannelId);

	if (!discordChannel) {
		console.error(writeLog(`Twitch VOD update cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}).`));
		return;
	}

	const twitchChannel = await channelData.getData(
		chan.channelName,
		twitchClientId,
		twitchAuthToken);

	if (!twitchChannel) {
		return;
	}

	const vod = await twitchVideos.getVodForStream(
		twitchChannel.id,
		chan.twitchStreamId,
		twitchClientId,
		twitchAuthToken
	);

	if (!vod?.url) {
		return;
	}

	// If the VOD exists, edit the original live message once and clear the live stream marker.
	const existingMessage =
		discordChannel.messages.cache.get(chan.twitchMessageId) ||
		await discordChannel.messages.fetch(chan.twitchMessageId).catch(() => null);

	if (!existingMessage) {
		await Channels.update({ twitchStreamId: null }, { where: { id: chan.id } });
		return;
	}

	const embed = buildOfflineEmbed(existingMessage.embeds[0], vod);
	await existingMessage.edit({
		content: `The Twitch stream has ended.`,
		embeds: [embed],
	});
	await Channels.update({ twitchStreamId: null }, { where: { id: chan.id } });
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
	const { twitchAuthToken } = authTokens.getAuthTokens();
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
	const streamsData = await twitchData.getTwitchDataBatch(
		channelNames, 
		twitchClientId, 
		twitchAuthToken
	);

	for (const server of servers) {
		const guild = client.guilds.cache.get(server.guildId);
		// console.log(writeLog(`Checking channels for ${guild?.name ?? 'Unknown guild'} (ID: ${server.guildId})`));

		// O(1) lookup instead of filtering entire dataset per server
		const serverChannels = channelsByGuild.get(server.guildId) || [];

		// Process each channel in the server
		const channelPromises = serverChannels.map(async (chan) => {
			const streamRecord = streamsData[chan.channelName];
			const streamInfo = streamRecord?.data;

			if (!streamRecord || streamRecord.error) {
				return;
			}

			// Skip if offline or notifications disabled
			if (!streamInfo || !chan.twitchNotif) {
				if (!streamInfo) {
					await updateOfflineTwitchMessage(chan, server, guild, client);
				}

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
				twitchClientId,
				twitchAuthToken);

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
				.setImage(`https://static-cdn.jtvnw.net/previews-ttv/live_user_${twitchChannel.broadcaster_login}-640x360.jpg?cacheBypass=${Date.now()}`);

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
