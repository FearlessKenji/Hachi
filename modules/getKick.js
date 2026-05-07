const { Servers, Channels } = require('../database/dbObjects.js');
const channelData = require('./kickChannelData.js');
const userData = require('./getKickUserData.js');
const { EmbedBuilder } = require('discord.js');
const { writeLog } = require('./writeLog.js');
const fs = require('node:fs');

/**
 * Fetch Kick stream info for multiple channels in parallel.
 * Only fetches once per unique Kick username.
 */
async function getKickDataBatch(channelNames, clientID, authKey) {
	const promises = channelNames.map(async (name) => {
		const url = `https://api.kick.com/public/v1/channels?slug=${name}`;
		const headers = { 'Client-ID': clientID, 'Authorization': `Bearer ${authKey}` };
		try {
			const res = await fetch(url, { headers });
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`HTTP ${res.status} - ${text}`);
			}

			const data = await res.json();
			return { name, data: data.data[0] ?? null }; // null if offline
		}
		catch (err) {
			console.error(writeLog(`Failed to fetch Kick data for ${name}:`, err));
			return { name, data: null };
		}
	});

	return Promise.all(promises);
}

/**
 * Main Kick check function.
 * - Loops through all servers
 * - Fetches Kick info per channel globally
 * - Updates or sends Discord messages accordingly
 */
async function checkKick(client) {
	let config;
	try {
		config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));
	}
	catch (err) {
		console.error(writeLog('Failed to read config.json:', err));
		return;
	}

	// Fetch all servers from DB
	const servers = await Servers.findAll({ raw: true });

	for (const server of servers) {
		const guild = client.guilds.cache.get(server.guildId);
		// console.log(writeLog(`Checking channels for ${guild?.name ?? 'Unknown guild'} (ID: ${server.guildId})`));

		// Fetch all channels for this server
		const channels = await Channels.findAll({ where: { guildId: server.guildId }, raw: true });
		const channelNames = channels
			.map(c => c.channelName?.toLowerCase().trim())
			.filter(name => name && /^[a-z0-9_]+$/.test(name));


		// Batch fetch Kick data globally per channel name
		const streamsData = await getKickDataBatch(channelNames, config.kickClientId, config.kickAuthToken);

		// Process each channel in the server
		const channelPromises = channels.map(async (chan) => {
			const streamInfo = streamsData.find(s => s.name === chan.channelName)?.data;

			// Determine which Discord channel to post in
			const discordChannelId = chan.isSelf ? server.selfChannelId : server.affiliateChannelId;
			const discordChannel = client.channels.cache.get(discordChannelId);
			if (!discordChannel) {
				console.error(writeLog(`Kick updates cannot be sent to ${discordChannelId} channel in server ${guild?.name} (ID: ${server.guildId}).`));
				return;
			}

			// Mention the appropriate role if available
			const roleMention = chan.isSelf
				? server.selfRoleId ? `<@&${server.selfRoleId}> ` : ''
				: server.affiliateRoleId ? `<@&${server.affiliateRoleId}> ` : '';

			if (streamInfo.stream.is_live === false && chan.kickIsLive == true) {
				await Channels.update({ kickIsLive: streamInfo.stream.is_live }, { where: { id: chan.id } });
				return; // nothing else to do for offline stream
			}

			const userID = streamInfo.broadcaster_user_id
			const kickUser = await userData.getData(userID, chan.channelName, config.kickClientId, config.kickAuthToken);
			const startTime = new Date(streamInfo.stream.start_time).toLocaleString();
			const editTime = new Date().toLocaleString();

			// Build embed fields
			const fields = [
				{ name: 'Playing', value: streamInfo.category.name, inline: true },
				{ name: 'Viewers', value: streamInfo.stream.viewer_count.toString(), inline: true },
				{ name: 'Kick', value: `[Watch stream](https://www.kick.com/${streamInfo.slug})` },
			];
			if (chan.discordUrl) fields.push({ name: 'Discord Server', value: `[Join here](${chan.discordUrl})`, inline: true });

			const sendEmbed = new EmbedBuilder()
				.setTitle(`${kickUser.name} is now live`)
				.setDescription(streamInfo.stream_title)
				.setURL(`https://www.kick.com/${streamInfo.slug}`)
				.setColor(0x00E701)
				.setFields(fields)
				.setFooter({ text: `Started ${startTime}. Last edited ${editTime}.` })
				.setThumbnail(kickUser.profile_picture)
				.setImage(`${streamInfo.stream.thumbnail}?cacheBypass=${Math.random()}`);

			const content = chan.isSelf
				? `${roleMention}I just went live on Kick! I'm streaming ${streamInfo.category.name}!`
				: `${roleMention}An affiliate has gone live on Kick! They're streaming ${streamInfo.category.name}!`;

			// Send or edit Discord message
			try {
				if (chan.kickMessageId && chan.kickIsLive == streamInfo.stream.is_live ) {
					// Edit existing live message
					const existingMessage = await discordChannel.messages.fetch(chan.kickMessageId).catch(() => null);
					if (existingMessage) {
						await existingMessage.edit({ content, embeds: [sendEmbed] });
						return;
					} else {
						// Send new live message, message was deleted.
						const message = await discordChannel.send({ content, embeds: [sendEmbed] });
						// Update DB with new messageId
						await Channels.update({ kickMessageId: message.id, kickIsLive: streamInfo.stream.is_live }, { where: { id: chan.id } });
					}
				} else {
					// Send new live message
					const message = await discordChannel.send({ content, embeds: [sendEmbed] });
					// Update DB with new messageId
					await Channels.update({ kickMessageId: message.id, kickIsLive: streamInfo.stream.is_live }, { where: { id: chan.id } });
				}
			}
			catch (err) {
				console.error(writeLog(`Failed to send/edit kick message for ${chan.channelName}:`, err));
			}
		});

		// Process all channels for this server concurrently
		await Promise.allSettled(channelPromises);
	}
}

module.exports = { checkKick };