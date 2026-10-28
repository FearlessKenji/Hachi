// Persistent Modmail runtime: managed entry panel, ticket lifecycle, transcripts,
// and restart-safe delayed channel cleanup.
const {
	ActionRowBuilder,
	AttachmentBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	EmbedBuilder,
	PermissionFlagsBits,
} = require(`discord.js`);
const { Op, Transaction } = require(`sequelize`);
const { Buffer } = require(`node:buffer`);
const { ModmailConfigs, ModmailTickets, sequelize } = require(`../database/dbObjects.js`);
const { error, info, warn } = require(`./writeLog.js`);

const MODMAIL_COLOR = 0x5865f2;
const CLOSED_COLOR = 0xfee75c;
const DELETE_DELAY_MS = 15 * 24 * 60 * 60 * 1000;
const INCOMPLETE_TICKET_AGE_MS = 10 * 60 * 1000;
const ENTRY_CHANNEL_CACHE_TTL_MS = 30 * 1000;
const ENTRY_CHANNEL_CACHE_MAX_GUILDS = 1024;
const entryChannelCache = new Map();
const entryEveryoneAllow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
const entryEveryoneDeny = [
	PermissionFlagsBits.SendMessages,
	PermissionFlagsBits.AddReactions,
	PermissionFlagsBits.CreatePublicThreads,
	PermissionFlagsBits.CreatePrivateThreads,
];
const entryBotAllow = [
	PermissionFlagsBits.ViewChannel,
	PermissionFlagsBits.SendMessages,
	PermissionFlagsBits.EmbedLinks,
	PermissionFlagsBits.ReadMessageHistory,
	PermissionFlagsBits.ManageMessages,
];

function parseRoleIds(value) {
	try {
		const ids = JSON.parse(value || `[]`);

		return Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === `string`))] : [];
	} catch {
		return [];
	}
}

function getRoleIds(config) {
	const pingRoleIds = parseRoleIds(config?.pingRoleIdsJson);
	const allowedRoleIds = parseRoleIds(config?.allowedRoleIdsJson);

	return {
		allowedRoleIds,
		effectiveRoleIds: [...new Set([...allowedRoleIds, ...pingRoleIds])],
		pingRoleIds,
	};
}

function ticketName(ticketNumber, closed = false) {
	return `${closed ? `closed` : `ticket`}-${String(ticketNumber).padStart(4, `0`)}`;
}

function buildEntryPanel() {
	return {
		allowedMentions: { parse: [] },
		components: [new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`modmail:create`)
				.setEmoji(`📩`)
				.setLabel(`Create Ticket`)
				.setStyle(ButtonStyle.Primary),
		)],
		embeds: [new EmbedBuilder()
			.setColor(MODMAIL_COLOR)
			.setTitle(`Modmail`)
			.setDescription(`To create a ticket, press 📩`)
			.setFooter({ text: `A moderator will respond when available.` })],
	};
}

function buildOpenControls(ticketId) {
	return [new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`modmail:ticket:${ticketId}:close`)
			.setEmoji(`🔒`)
			.setLabel(`Close`)
			.setStyle(ButtonStyle.Secondary),
	)];
}

function buildClosedPanel(ticket, closedBy) {
	return {
		allowedMentions: { parse: [] },
		components: [new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId(`modmail:ticket:${ticket.id}:transcript`).setEmoji(`📄`).setLabel(`Transcript`).setStyle(ButtonStyle.Secondary),
			new ButtonBuilder().setCustomId(`modmail:ticket:${ticket.id}:open`).setEmoji(`🔓`).setLabel(`Open`).setStyle(ButtonStyle.Secondary),
			new ButtonBuilder().setCustomId(`modmail:ticket:${ticket.id}:delete`).setEmoji(`⛔`).setLabel(`Delete`).setStyle(ButtonStyle.Danger),
			new ButtonBuilder().setCustomId(`modmail:ticket:${ticket.id}:store`).setEmoji(`💾`).setLabel(`Store`).setStyle(ButtonStyle.Primary),
		)],
		embeds: [new EmbedBuilder()
			.setColor(CLOSED_COLOR)
			.setDescription(`Ticket Closed by <@${closedBy}>`)],
	};
}

function memberIsStaff(member, config) {
	if (!member || !config) {
		return false;
	}

	if (member.permissions?.has(PermissionFlagsBits.Administrator)) {
		return true;
	}

	const { effectiveRoleIds } = getRoleIds(config);

	return effectiveRoleIds.some(roleId => member.roles.cache.has(roleId));
}

function memberHasConfiguredRole(member, config) {
	const { effectiveRoleIds } = getRoleIds(config);

	return Boolean(member && effectiveRoleIds.some(roleId => member.roles.cache.has(roleId)));
}

async function getConfig(guildId) {
	return ModmailConfigs.findByPk(guildId);
}

function invalidateEntryChannelCache(guildId) {
	entryChannelCache.delete(guildId);
}

function rememberEntryChannel(guildId, cacheEntry) {
	// Map insertion order gives us a bounded least-recently-used cache without
	// keeping a timer alive for every guild. Expired entries refresh on access.
	entryChannelCache.delete(guildId);
	entryChannelCache.set(guildId, cacheEntry);
	if (entryChannelCache.size > ENTRY_CHANNEL_CACHE_MAX_GUILDS) {
		entryChannelCache.delete(entryChannelCache.keys().next().value);
	}
}

async function getEntryChannelId(guildId) {
	while (true) {
		const cached = entryChannelCache.get(guildId);
		if (cached?.expiresAt > Date.now()) {
			rememberEntryChannel(guildId, cached);
			return cached.entryChannelId;
		}
		if (cached?.pending) {
			await cached.pending;
			continue;
		}

		const pending = ModmailConfigs.findByPk(guildId, { attributes: [`entryChannelId`] });
		const loadingEntry = { pending };
		rememberEntryChannel(guildId, loadingEntry);
		let config;
		try {
			config = await pending;
		} catch (err) {
			if (entryChannelCache.get(guildId) === loadingEntry) {
				invalidateEntryChannelCache(guildId);
			}
			throw err;
		}
		// Setup or channel deletion may have invalidated this lookup while SQLite
		// was answering it. Retry instead of installing or using its stale result.
		if (entryChannelCache.get(guildId) !== loadingEntry) {
			continue;
		}
		const entryChannelId = config?.entryChannelId || null;
		rememberEntryChannel(guildId, {
			entryChannelId,
			expiresAt: Date.now() + ENTRY_CHANNEL_CACHE_TTL_MS,
		});
		return entryChannelId;
	}
}

async function ensureEntryPanel(guild, config) {
	let channel = config.entryChannelId ? await guild.channels.fetch(config.entryChannelId).catch(() => null) : null;

	if (!channel) {
		channel = await guild.channels.create({
			name: `modmail`,
			type: ChannelType.GuildText,
			permissionOverwrites: [
				{ id: guild.roles.everyone.id, allow: entryEveryoneAllow, deny: entryEveryoneDeny },
				{ id: guild.members.me.id, allow: entryBotAllow },
			],
			reason: `Hachi Modmail setup`,
		});
		await config.update({ entryChannelId: channel.id });
		invalidateEntryChannelCache(guild.id);
	}

	await channel.permissionOverwrites.set([
		{ id: guild.roles.everyone.id, allow: entryEveryoneAllow, deny: entryEveryoneDeny },
		{ id: guild.members.me.id, allow: entryBotAllow },
	], `Hachi Modmail managed-channel permissions`);

	// Clear the saved ID before purging so MessageDelete does not interpret this
	// intentional setup refresh as a panel that needs immediate restoration.
	await config.update({ panelMessageId: null });

	// This channel is deliberately Hachi-managed. Purging guarantees the panel is
	// the only message even when setup repairs a previously altered channel.
	let messages;
	do {
		messages = await channel.messages.fetch({ limit: 100 });
		let deleted = 0;
		for (const message of messages.values()) {
			await message.delete()
				.then(() => deleted += 1)
				.catch(err => warn(`Failed to clear Modmail entry message ${message.id}: ${err.message}`));
		}
		if (!deleted) {
			break;
		}
	} while (messages.size === 100);

	const panel = await channel.send(buildEntryPanel());
	await config.update({ panelMessageId: panel.id });

	return channel;
}

async function ensureInfrastructure(guild, settings) {
	let category = settings.ticketCategoryId ? await guild.channels.fetch(settings.ticketCategoryId).catch(() => null) : null;

	if (!category || category.type !== ChannelType.GuildCategory) {
		category = await guild.channels.create({ name: `Modmail Tickets`, type: ChannelType.GuildCategory, reason: `Hachi Modmail setup` });
	}

	const [config] = await ModmailConfigs.findOrCreate({
		defaults: { guildId: guild.id },
		where: { guildId: guild.id },
	});

	await config.update({
		ticketCategoryId: category.id,
		pingRoleIdsJson: JSON.stringify(settings.pingRoleIds || []),
		allowedRoleIdsJson: JSON.stringify(settings.allowedRoleIds || []),
		maxStoredTickets: settings.maxStoredTickets || 50,
	});

	await ensureEntryPanel(guild, config);
	invalidateEntryChannelCache(guild.id);

	return config.reload();
}

async function allocateTicket(guildId, openerId) {
	return sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
		// The button's initial lookup can race with another click. Check again under
		// the SQLite write lock before consuming a ticket number or creating a row.
		const existingTicket = await ModmailTickets.findOne({
			where: { guildId, openerId, status: `open` },
			transaction,
		});
		if (existingTicket) {
			return { ticket: existingTicket, created: false };
		}

		const config = await ModmailConfigs.findByPk(guildId, { transaction });

		if (!config) {
			throw new Error(`Modmail is not configured.`);
		}

		const ticketNumber = config.nextTicketNumber;
		await config.increment(`nextTicketNumber`, { by: 1, transaction });

		const ticket = await ModmailTickets.create(
			{ guildId, ticketNumber, openerId, openedAt: new Date() },
			{ transaction },
		);
		return { ticket, created: true };
	});
}

function buildTicketOverwrites(guild, openerId, config) {
	const { effectiveRoleIds } = getRoleIds(config);
	const botAllow = [
		PermissionFlagsBits.ViewChannel,
		PermissionFlagsBits.SendMessages,
		PermissionFlagsBits.ReadMessageHistory,
		PermissionFlagsBits.ManageChannels,
		PermissionFlagsBits.ManageMessages,
		PermissionFlagsBits.AttachFiles,
		PermissionFlagsBits.EmbedLinks,
	];
	const participantAllow = [
		PermissionFlagsBits.ViewChannel,
		PermissionFlagsBits.SendMessages,
		PermissionFlagsBits.ReadMessageHistory,
		PermissionFlagsBits.AttachFiles,
	];

	return [
		{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
		{ id: guild.members.me.id, allow: botAllow },
		{ id: openerId, allow: participantAllow },
		...effectiveRoleIds.map(roleId => ({ id: roleId, allow: participantAllow })),
	];
}

function welcomeText(openerId, pingRoleIds) {
	if (!pingRoleIds.length) {
		return `Welcome, <@${openerId}>. A moderator will be with you shortly.`;
	}

	if (pingRoleIds.length === 1) {
		return `Welcome, <@${openerId}>. A member of <@&${pingRoleIds[0]}> will be with you shortly.`;
	}

	return `Welcome, <@${openerId}>. A member of our support team will be with you shortly.\n${pingRoleIds.map(id => `<@&${id}>`).join(` `)}`;
}

async function recoverIncompleteTicket(interaction, ticket, config) {
	const staleBefore = new Date(Date.now() - INCOMPLETE_TICKET_AGE_MS);
	if (new Date(ticket.openedAt) > staleBefore) {
		return { state: `pending` };
	}

	// The channel may have been created just before a crash but before its ID
	// was saved. Inspect Discord before releasing the reserved ticket number.
	const guildChannels = await interaction.guild.channels.fetch();
	const namedChannels = [...guildChannels.values()].filter(channel =>
		channel.type === ChannelType.GuildText &&
		channel.name === ticketName(ticket.ticketNumber));
	const matchingChannels = namedChannels.filter(channel =>
		channel.permissionOverwrites?.cache?.has(ticket.openerId));
	if (namedChannels.length !== matchingChannels.length) {
		// A matching name without the expected opener overwrite may still be the
		// unfinished ticket. Keep its row for manual review instead of orphaning it.
		throw new Error(`A channel has the name of incomplete Modmail ticket ${ticket.id} but its opener access is unclear; inspect it before retrying.`);
	}
	if (matchingChannels.length > 1) {
		throw new Error(`Several channels match incomplete Modmail ticket ${ticket.id}; inspect them before retrying.`);
	}
	if (matchingChannels.length === 1) {
		const channel = matchingChannels[0];
		const [claimed] = await ModmailTickets.update(
			{ channelId: channel.id },
			{ where: { id: ticket.id, status: `open`, channelId: null } },
		);
		if (claimed === 1) {
			const { pingRoleIds } = getRoleIds(config);
			try {
				await channel.send({
					allowedMentions: { users: [ticket.openerId], roles: pingRoleIds },
					components: buildOpenControls(ticket.id),
					content: welcomeText(ticket.openerId, pingRoleIds),
				});
			} catch (err) {
				error(`Recovered Modmail channel ${channel.id} without its welcome message:`, err);
				return { state: `recovered`, message: `Your ticket channel was recovered: <#${channel.id}>. Hachi could not finish its setup; please contact a moderator.` };
			}
			return { state: `recovered`, message: `Your ticket channel is ready: <#${channel.id}>` };
		}
		const currentTicket = await ModmailTickets.findByPk(ticket.id);
		return currentTicket?.channelId ?
			{ state: `recovered`, message: `You already have an open ticket: <#${currentTicket.channelId}>` } :
			{ state: `removed` };
	}

	// A stale row without any matching channel can be released. The conditional
	// delete preserves it if another worker saved the channel ID meanwhile.
	const removed = await ModmailTickets.destroy({
		where: { id: ticket.id, status: `open`, channelId: null, openedAt: { [Op.lte]: staleBefore } },
	});
	return { state: removed === 1 ? `removed` : `pending` };
}

async function createTicket(interaction) {
	const config = await getConfig(interaction.guild.id);

	if (!config) {
		return interaction.reply({ content: `Modmail is not configured.`, ephemeral: true });
	}

	await interaction.deferReply({ ephemeral: true });
	let ticket;
	let created = false;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		({ ticket, created } = await allocateTicket(interaction.guild.id, interaction.user.id));
		if (created) {
			break;
		}
		if (ticket.channelId) {
			return interaction.editReply(`You already have an open ticket: <#${ticket.channelId}>`);
		}
		const recovery = await recoverIncompleteTicket(interaction, ticket, config);
		if (recovery.state === `recovered`) {
			return interaction.editReply(recovery.message);
		}
		if (recovery.state === `pending`) {
			return interaction.editReply(`Your ticket is still being created. Please try again shortly.`);
		}
	}
	if (!created) {
		throw new Error(`Could not allocate a Modmail ticket after clearing stale entries.`);
	}

	let channel = null;
	let channelIdSaved = false;
	try {
		channel = await interaction.guild.channels.create({
			name: ticketName(ticket.ticketNumber),
			parent: config.ticketCategoryId,
			permissionOverwrites: buildTicketOverwrites(interaction.guild, interaction.user.id, config),
			reason: `Modmail ticket opened by ${interaction.user.tag}`,
		});
		await ticket.update({ channelId: channel.id });
		channelIdSaved = true;
		const { pingRoleIds } = getRoleIds(config);

		await channel.send({
			allowedMentions: { users: [interaction.user.id], roles: pingRoleIds },
			components: buildOpenControls(ticket.id),
			content: welcomeText(interaction.user.id, pingRoleIds),
		});
		await interaction.editReply(`Your ticket has been created: ${channel}`);
	} catch (err) {
		if (!channelIdSaved) {
			// Discord channel creation and SQLite cannot share a transaction. If
			// persistence fails, remove the new channel before freeing the ticket row.
			let channelRemoved = !channel;
			if (channel) {
				try {
					await channel.delete(`Modmail ticket setup failed`);
					channelRemoved = true;
				} catch (cleanupError) {
					error(`Failed to remove incomplete Modmail channel ${channel.id}:`, cleanupError);
					await ticket.update({ channelId: channel.id }).catch(saveError =>
						error(`Failed to retain incomplete Modmail channel ${channel.id}:`, saveError));
				}
			}
			if (channelRemoved) {
				await ticket.destroy().catch(cleanupError =>
					error(`Failed to remove incomplete Modmail ticket ${ticket.id}:`, cleanupError));
			}
			throw err;
		}

		// Once the channel ID is durable, keep the ticket even if its starter
		// message or interaction reply fails. Another click can find that channel.
		error(`Modmail ticket ${ticket.id} has a channel but setup was incomplete:`, err);
		await interaction.editReply(`Your ticket channel was created: <#${channel.id}>. Hachi could not finish its setup; please contact a moderator.`)
			.catch(() => null);
	}
}

async function getTicketContext(interaction, ticketId) {
	const [ticket, config] = await Promise.all([
		ModmailTickets.findByPk(ticketId),
		getConfig(interaction.guild.id),
	]);

	if (!ticket || ticket.guildId !== interaction.guild.id || ticket.channelId !== interaction.channel.id) {
		await interaction.reply({ content: `This ticket control is no longer valid.`, ephemeral: true });
		return null;
	}
	if (ticket.status === `delete_pending`) {
		await interaction.reply({ content: `This ticket channel is queued for deletion.`, ephemeral: true });
		return null;
	}

	if (!memberIsStaff(interaction.member, config)) {
		await interaction.reply({ content: `Only an allowed Modmail role can use this control.`, ephemeral: true });
		return null;
	}

	return { config, ticket };
}

async function closeTicket(interaction, ticket, controlMessageId) {
	if (interaction.user.id === ticket.openerId) {
		return interaction.update({ content: `The ticket opener cannot close this ticket.`, components: [] });
	}

	const config = await getConfig(interaction.guild.id);
	const opener = await interaction.guild.members.fetch(ticket.openerId).catch(() => null);

	if (!opener || !memberHasConfiguredRole(opener, config)) {
		await interaction.channel.permissionOverwrites.edit(ticket.openerId, { ViewChannel: false, SendMessages: false }, { reason: `Modmail ticket closed` });
	}

	const now = new Date();
	await ticket.update({
		closedAt: now,
		closedBy: interaction.user.id,
		deleteAt: ticket.storedAt ? null : new Date(now.getTime() + DELETE_DELAY_MS),
		status: ticket.storedAt ? `stored` : `closed`,
	});
	if (controlMessageId) {
		const controlMessage = await interaction.channel.messages.fetch(controlMessageId).catch(() => null);
		await controlMessage?.edit({ components: [] }).catch(() => null);
	}
	await interaction.channel.setName(ticketName(ticket.ticketNumber, true), `Modmail ticket closed`).catch(() => null);
	await interaction.update({ content: `Ticket closed.`, components: [] });
	await interaction.channel.send(buildClosedPanel(ticket, interaction.user.id));
}

async function reopenTicket(interaction, ticket) {
	await interaction.deferUpdate();
	const previousState = {
		closedAt: ticket.closedAt,
		closedBy: ticket.closedBy,
		deleteAt: ticket.deleteAt,
		status: ticket.status,
	};
	// Claim the one-open-ticket slot before restoring access. The database index
	// also rejects another process trying to create a ticket at the same time.
	const reopened = await sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
		const anotherOpenTicket = await ModmailTickets.findOne({
			where: {
				guildId: ticket.guildId,
				openerId: ticket.openerId,
				status: `open`,
				id: { [Op.ne]: ticket.id },
			},
			transaction,
		});
		if (anotherOpenTicket) {
			return false;
		}
		await ticket.update({ closedAt: null, closedBy: null, deleteAt: null, status: `open` }, { transaction });
		return true;
	});
	if (!reopened) {
		return interaction.followUp({
			content: `The ticket opener already has another open ticket. Close it before reopening this one.`,
			ephemeral: true,
		});
	}
	try {
		await interaction.channel.permissionOverwrites.edit(ticket.openerId, {
			ViewChannel: true,
			SendMessages: true,
			ReadMessageHistory: true,
			AttachFiles: true,
		}, { reason: `Modmail ticket reopened` });
	} catch (err) {
		await ticket.update(previousState).catch(rollbackError =>
			error(`Failed to restore Modmail ticket ${ticket.id} after a permission error:`, rollbackError));
		throw err;
	}
	await interaction.channel.setName(ticketName(ticket.ticketNumber), `Modmail ticket reopened`).catch(() => null);
	await interaction.message.edit({ components: [], embeds: [] });
	await interaction.channel.send({ content: `Ticket reopened by <@${interaction.user.id}>.`, allowedMentions: { parse: [] }, components: buildOpenControls(ticket.id) });
}

async function fetchAllMessages(channel) {
	const messages = [];
	let before;

	do {
		const batch = await channel.messages.fetch({ before, limit: 100 });
		messages.push(...batch.values());
		before = batch.last()?.id;
		if (batch.size < 100) {
			break;
		}
	} while (before);

	return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function generateTranscript(channel, ticket) {
	const messages = await fetchAllMessages(channel);
	const lines = [
		`Modmail ticket ${ticketName(ticket.ticketNumber)}`,
		`Guild: ${channel.guild.name} (${channel.guild.id})`,
		`Opened by: ${ticket.openerId}`,
		`Opened: ${ticket.openedAt.toISOString()}`,
		``,
	];

	for (const message of messages) {
		const attachments = [...message.attachments.values()].map(item => item.url).join(` `);
		lines.push(`[${message.createdAt.toISOString()}] ${message.author.tag} (${message.author.id}): ${message.content || ``}${attachments ? ` ${attachments}` : ``}`);
	}

	return lines.join(`\n`);
}

async function sendTranscript(interaction, ticket) {
	await interaction.deferReply({ ephemeral: true });
	const transcript = ticket.transcript || await generateTranscript(interaction.channel, ticket);
	const attachment = new AttachmentBuilder(Buffer.from(transcript, `utf8`), { name: `${ticketName(ticket.ticketNumber)}.txt` });

	await interaction.editReply({ content: `Transcript for ${ticketName(ticket.ticketNumber)}.`, files: [attachment] });
}

async function storeTicket(interaction, ticket, config) {
	if (ticket.storedAt) {
		return interaction.reply({ content: `This ticket is already stored.`, ephemeral: true });
	}

	const storedCount = await ModmailTickets.count({ where: { guildId: ticket.guildId, storedAt: { [Op.ne]: null } } });

	if (storedCount >= config.maxStoredTickets) {
		return interaction.reply({ content: `The stored-ticket limit of ${config.maxStoredTickets} has been reached.`, ephemeral: true });
	}

	await interaction.deferReply({ ephemeral: true });
	await ticket.update({
		deleteAt: null,
		status: `stored`,
		storedAt: new Date(),
		storedBy: interaction.user.id,
		transcript: await generateTranscript(interaction.channel, ticket),
	});
	await interaction.editReply(`Stored ${ticketName(ticket.ticketNumber)}. Its automatic deletion has been cancelled.`);
}

async function deleteTicketChannel(interaction, ticket) {
	await interaction.deferUpdate();
	// Persist a retryable intent before deleting from Discord. A failed follow-up
	// save cannot strand a stored ticket with a stale channel ID forever.
	await ticket.update({ status: `delete_pending` });
	try {
		await interaction.channel.delete(`Modmail ticket deleted by ${interaction.user.tag}`);
	} catch (err) {
		await interaction.followUp({ content: `Hachi could not delete this channel. It will retry during cleanup.`, ephemeral: true });
		throw err;
	}

	// A failed database save leaves the old channel ID available for the timed
	// cleanup pass, which can recognize Discord's confirmed "unknown channel".
	await ticket.update({
		channelId: null,
		status: ticket.storedAt ? `stored` : `deleted`,
	});
	await interaction.editReply({ content: `Ticket deleted.`, components: [] }).catch(() => null);
}

async function handleTicketComponent(interaction, ticketId, action, controlMessageId = null) {
	const context = await getTicketContext(interaction, ticketId);

	if (!context) {
		return;
	}
	const { config, ticket } = context;

	if (action === `close`) {
		if (ticket.status !== `open`) {
			return interaction.reply({ content: `This ticket is already closed.`, ephemeral: true });
		}
		if (interaction.user.id === ticket.openerId) {
			return interaction.reply({ content: `The ticket opener cannot close this ticket.`, ephemeral: true });
		}
		return interaction.reply({
			content: `Close this ticket? The opener will lose access and the channel will be deleted in 15 days unless stored.`,
			components: [new ActionRowBuilder().addComponents(
				new ButtonBuilder().setCustomId(`modmail:ticket:${ticket.id}:confirm-close:${interaction.message.id}`).setLabel(`Close Ticket`).setStyle(ButtonStyle.Danger),
				new ButtonBuilder().setCustomId(`modmail:ticket:${ticket.id}:cancel`).setLabel(`Cancel`).setStyle(ButtonStyle.Secondary),
			)],
			ephemeral: true,
		});
	}

	if (action === `confirm-close`) {
		return closeTicket(interaction, ticket, controlMessageId);
	}
	if (action === `open`) {
		return reopenTicket(interaction, ticket);
	}
	if (action === `transcript`) {
		return sendTranscript(interaction, ticket);
	}
	if (action === `store`) {
		return storeTicket(interaction, ticket, config);
	}
	if (action === `delete`) {
		return interaction.reply({
			content: `Permanently delete this ticket channel?`,
			components: [new ActionRowBuilder().addComponents(
				new ButtonBuilder().setCustomId(`modmail:ticket:${ticket.id}:confirm-delete`).setLabel(`Delete Ticket`).setStyle(ButtonStyle.Danger),
				new ButtonBuilder().setCustomId(`modmail:ticket:${ticket.id}:cancel`).setLabel(`Cancel`).setStyle(ButtonStyle.Secondary),
			)],
			ephemeral: true,
		});
	}
	if (action === `confirm-delete`) {
		return deleteTicketChannel(interaction, ticket);
	}
	if (action === `cancel`) {
		return interaction.update({ content: `Cancelled.`, components: [] });
	}
}

async function enforceEntryChannel(message) {
	if (!message.guild) {
		return false;
	}
	const entryChannelId = await getEntryChannelId(message.guild.id);
	if (message.channel.id !== entryChannelId) {
		return false;
	}
	// Only messages in the managed channel need the current panel ID. Recheck
	// the database here so a stale positive cache entry cannot delete a message.
	const config = await ModmailConfigs.findOne({ where: { guildId: message.guild.id, entryChannelId: message.channel.id } });

	if (!config || message.id === config.panelMessageId) {
		return false;
	}

	// Panel sends emit MessageCreate before the caller can persist the new message
	// ID. Recognize Hachi's exact persistent control so it is not deleted mid-send.
	const isModmailPanel = message.author.id === message.client.user.id &&
		message.components?.[0]?.components?.[0]?.customId === `modmail:create`;

	if (isModmailPanel) {
		return false;
	}
	await message.delete();
	return true;
}

async function restoreDeletedPanel(message) {
	if (!message.guild) {
		return false;
	}
	const config = await ModmailConfigs.findOne({ where: { guildId: message.guild.id, panelMessageId: message.id } });

	if (!config) {
		return false;
	}
	const panel = await message.channel.send(buildEntryPanel());
	config.panelMessageId = panel.id;
	await config.save();
	return true;
}

async function cleanupClosedTickets(client, now = new Date()) {
	const tickets = await ModmailTickets.findAll({ where: { [Op.or]: [
		{ status: `closed`, deleteAt: { [Op.lte]: now } },
		{ status: `delete_pending` },
	] } });
	let deletedCount = 0;

	for (const ticket of tickets) {
		try {
			if (!ticket.channelId) {
				await ticket.update({ status: ticket.storedAt ? `stored` : `deleted` });
				deletedCount += 1;
				continue;
			}
			const guild = client.guilds.cache.get(ticket.guildId) ||
				await client.guilds.fetch(ticket.guildId);
			let channel = null;
			try {
				channel = await guild.channels.fetch(ticket.channelId);
				if (!channel) {
					throw new Error(`Discord did not confirm whether Modmail channel ${ticket.channelId} exists.`);
				}
			} catch (err) {
				if (Number(err?.code) !== 10003) {
					throw err;
				}
			}
			if (channel) {
				try {
					await channel.delete(`Modmail 15-day retention expired`);
				} catch (err) {
					if (Number(err?.code) !== 10003) {
						throw err;
					}
				}
			}
			// Only a successful deletion or Discord's confirmed missing-channel
			// response retires the ledger row; transient failures remain retryable.
			await ticket.update({ channelId: null, status: ticket.storedAt ? `stored` : `deleted` });
			deletedCount += 1;
		} catch (err) {
			error(`Failed to delete expired Modmail ticket ${ticket.id}:`, err);
		}
	}

	if (deletedCount) {
		info(`Retired ${deletedCount} Modmail ticket channel record(s).`);
	}
	return deletedCount;
}

module.exports = {
	buildEntryPanel,
	cleanupClosedTickets,
	createTicket,
	enforceEntryChannel,
	ensureInfrastructure,
	getConfig,
	getRoleIds,
	handleTicketComponent,
	invalidateEntryChannelCache,
	memberIsStaff,
	restoreDeletedPanel,
	ticketName,
};
