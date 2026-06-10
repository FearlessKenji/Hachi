const { Servers, Channels } = require(`../database/dbObjects.js`);
const userData = require(`./getKickUserData.js`);
const kickData = require(`./getKickDataBatch.js`);
const kickVideos = require(`./getKickVideos.js`);
const authTokens = require(`../auth/authTokens.js`);
const { EmbedBuilder } = require(`discord.js`);
const { warn, error } = require(`../utils/writeLog.js`);
const kickClientId = process.env.kickClientId;

function buildOfflineEmbed(existingEmbed, vod) {
	const embed = existingEmbed ?
		EmbedBuilder.from(existingEmbed) :
		new EmbedBuilder();

	// Keep the original live embed intact, but replace the Kick link with the VoD.
	const existingFields = existingEmbed?.fields?.length ?
		existingEmbed.fields :
		[
			{
				name: `Kick`,
				value: `[Watch VoD](${vod.url})`,
			},
		];
	const fields = existingFields.map(field => {
		if (field.name === `Kick`) {
			return {
				name: `Kick`,
				value: `[Watch VoD](${vod.url})`,
				inline: field.inline,
			};
		}

		return field;
	});

	const title = existingEmbed?.title ?
		existingEmbed.title.replace(`is now live`, `was live`) :
		`Kick stream was live`;
	const footerText = existingEmbed?.footer?.text ?
		existingEmbed.footer.text.replace(`Last edited`, `Stream ended`) :
		`Stream ended ${new Date().toLocaleString()}.`;

	embed
		.setTitle(title)
		.setURL(vod.url)
		.setFields(fields)
		.setFooter({ text: footerText });

	if (vod.thumbnail) {
		embed.setImage(vod.thumbnail);
	}

	return embed;
}

async function updateOfflineKickMessage(chan, server, guild, client) {
	if (!chan.kickMessageId || !chan.kickIsLive || !chan.kickNotif) {
		return;
	}

	const discordChannelId = chan.isSelf ?
		server.selfKickChannelId :
		server.affiliateChannelId;
	const discordChannel = client.channels.cache.get(discordChannelId);

	if (!discordChannel) {
		warn(`Kick VoD update cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}). Channel not found.`);
		return;
	}

	const vod = await kickVideos.getLatestVod(chan.channelName);

	if (!vod?.url) {
		return;
	}

	// If the VOD exists, edit the original live message once and mark Kick as offline.
	const existingMessage =
		discordChannel.messages.cache.get(chan.kickMessageId) ||
		await discordChannel.messages.fetch(chan.kickMessageId).catch(() => null);

	if (!existingMessage) {
		await Channels.update({ kickIsLive: false }, { where: { id: chan.id } });
		return;
	}

	const embed = buildOfflineEmbed(existingMessage.embeds[0], vod);
	await existingMessage.edit({
		content: `The Kick stream has ended.`,
		embeds: [embed],
	});
	await Channels.update({ kickIsLive: false }, { where: { id: chan.id } });
}

/**
 * Main Kick monitoring loop
 * - Loads servers + channels
 * - Normalizes channel names once
 * - Groups channels by guild for fast lookup
 * - Fetches Kick data once globally
 * - Processes Discord updates per server
 */
async function getKick(client) {
	const auth = authTokens.getAuthTokens();
	const kickAuthToken = auth.kickAuthToken;

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
	const streamsData = await kickData.getKickDataBatch(
		channelNames,
		kickClientId,
		kickAuthToken,
	);

	for (const server of servers) {
		const guild = client.guilds.cache.get(server.guildId);
		// debug(`Checking channels for ${guild?.name ?? 'Unknown guild'} (ID: ${server.guildId})`);

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
			if (!chan.kickNotif) {
				return;
			}

			if (!streamInfo?.stream?.is_live) {
				if (chan.kickIsLive) {
					await updateOfflineKickMessage(chan, server, guild, client);
				}

				return;
			}

			// Determine which Discord channel to post in
			const discordChannelId = chan.isSelf ?
				server.selfKickChannelId :
				server.affiliateChannelId;

			const discordChannel = client.channels.cache.get(discordChannelId);

			if (!discordChannel) {
				warn(`Kick updates cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}). Channel not found.`);
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
				kickClientId,
				kickAuthToken,
			);

			if (!kickUser) {
				return;
			}

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
				.setImage(`${streamInfo.stream.thumbnail}?cacheBypass=${Date.now()}`);

			const content = `${roleMention}${kickUser.name} just went live on Kick streaming ${streamInfo.category.name}!`;

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
				error(`Failed to send/edit kick message for ${chan.channelName}:`, err);
			}
		});

		// Process all channels for this server concurrently
		await Promise.allSettled(channelPromises);
	}
}

module.exports = { getKick };
