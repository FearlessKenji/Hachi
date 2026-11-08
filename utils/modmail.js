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
const { promisify } = require(`node:util`);
const { gzip, gunzip } = require(`node:zlib`);
const { ModmailConfigs, ModmailTickets, sequelize } = require(`../database/dbObjects.js`);
const { error, info } = require(`./writeLog.js`);

const MODMAIL_COLOR = 0x5865f2;
const CLOSED_COLOR = 0xfee75c;
const DELETE_DELAY_MS = 15 * 24 * 60 * 60 * 1000;
const INCOMPLETE_TICKET_AGE_MS = 10 * 60 * 1000;
const MAX_TRANSCRIPT_MESSAGES = 10_000;
const MAX_TRANSCRIPT_BYTES = 24 * 1024 * 1024;
const MAX_STORED_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_PART_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_PARTS = 25;
const TRANSCRIPT_GENERATION_TIMEOUT_MS = 5 * 60 * 1000;
const COMPRESSED_TRANSCRIPT_PREFIX = `hachi-gzip-v1:`;
const TRANSCRIPT_COMPRESSION_THRESHOLD_BYTES = 256 * 1024;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const ENTRY_CHANNEL_CACHE_TTL_MS = 30 * 1000;
const ENTRY_CHANNEL_CACHE_MAX_GUILDS = 1024;
const entryChannelCache = new Map();
// Component clicks for one ticket can arrive together. Serialize transitions so
// a stale button cannot close, reopen, or store the same ticket twice.
const activeTicketTransitions = new Set();
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

async function fetchGuildChannelIfPresent(guild, channelId) {
	if (!channelId) {
		return null;
	}
	try {
		return await guild.channels.fetch(channelId);
	} catch (err) {
		// Only a confirmed missing channel justifies replacing a saved channel ID.
		// A transient Discord error must leave the existing identity retryable.
		if (Number(err?.code) === 10003) {
			return null;
		}
		throw err;
	}
}

async function ensureEntryPanel(guild, config) {
	let channel = await fetchGuildChannelIfPresent(guild, config.entryChannelId);

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

	let panel = null;
	if (config.panelMessageId) {
		try {
			panel = await channel.messages.fetch(config.panelMessageId);
		} catch (err) {
			if (Number(err?.code) !== 10008) {
				throw err;
			}
		}
	}
	if (panel) {
		// Repair the current panel in place. Its saved ID remains valid throughout
		// the purge, and MessageDelete never sees an intentional panel deletion.
		await panel.edit(buildEntryPanel());
	}

	// This channel is deliberately Hachi-managed. Purging guarantees the panel is
	// the only message even when setup repairs a previously altered channel.
	let messages;
	do {
		messages = await channel.messages.fetch({ limit: 100 });
		let deleted = 0;
		for (const message of messages.values()) {
			if (message.id === panel?.id) {
				continue;
			}
			await message.delete();
			deleted++;
		}
		if (!deleted) {
			break;
		}
	} while (messages.size === 100);

	if (!panel) {
		const replacementPanel = await channel.send(buildEntryPanel());
		// Retire the stale ID only after a complete purge and a replacement panel.
		try {
			await config.update({ panelMessageId: replacementPanel.id });
		} catch (err) {
			await replacementPanel.delete().catch(deleteError =>
				error(`Could not remove an unsaved Modmail panel ${replacementPanel.id}:`, deleteError));
			throw err;
		}
	}

	return channel;
}

async function ensureInfrastructure(guild, settings) {
	let category = await fetchGuildChannelIfPresent(guild, settings.ticketCategoryId);

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

async function runTicketTransition(interaction, ticket, allowedStatuses, action) {
	if (activeTicketTransitions.has(ticket.id)) {
		return interaction.reply({ content: `This ticket is already being updated. Please try again shortly.`, ephemeral: true });
	}

	activeTicketTransitions.add(ticket.id);
	try {
		// The control may have been rendered before another action changed the row.
		const currentTicket = await ModmailTickets.findByPk(ticket.id);
		if (!currentTicket || currentTicket.guildId !== interaction.guild.id ||
			currentTicket.channelId !== interaction.channel.id) {
			return interaction.reply({ content: `This ticket control is no longer valid.`, ephemeral: true });
		}
		if (!allowedStatuses.includes(currentTicket.status)) {
			return interaction.reply({ content: `This ticket has changed state. Use its latest controls.`, ephemeral: true });
		}
		return await action(currentTicket);
	} finally {
		activeTicketTransitions.delete(ticket.id);
	}
}

async function restoreOpenerOverwrite(channel, openerId, previousOverwrite, reason) {
	// An overwrite edit merges flags. The captured object restores the exact old
	// flags; if none existed, remove the overwrite this transition just created.
	if (previousOverwrite) {
		await previousOverwrite.edit({}, reason);
	} else {
		try {
			await channel.permissionOverwrites.delete(openerId, reason);
		} catch (err) {
			// A failed or timed-out edit may never have created the overwrite.
			if (Number(err?.code) !== 10009) {
				throw err;
			}
		}
	}
}

async function closeTicket(interaction, ticket, controlMessageId) {
	if (interaction.user.id === ticket.openerId) {
		return interaction.reply({ content: `The ticket opener cannot close this ticket.`, ephemeral: true });
	}

	// A stored ticket may need several transcript pages. Acknowledge the button
	// before any Discord or database work, then edit the deferred confirmation.
	await interaction.deferUpdate();
	let accessChangeAttempted = false;
	let previousOverwrite;
	let closeSaved = false;
	const previousState = {
		closedAt: ticket.closedAt,
		closedBy: ticket.closedBy,
		deleteAt: ticket.deleteAt,
		status: ticket.status,
		transcript: ticket.transcript,
	};
	try {
		const config = await getConfig(interaction.guild.id);
		const opener = await interaction.guild.members.fetch(ticket.openerId).catch(() => null);
		if (!opener || !memberHasConfiguredRole(opener, config)) {
			previousOverwrite = interaction.channel.permissionOverwrites.cache.get(ticket.openerId);
			// A timed-out Discord request may still have applied. Compensation must
			// run even when the permission call itself reports an error.
			accessChangeAttempted = true;
			await interaction.channel.permissionOverwrites.edit(ticket.openerId,
				{ ViewChannel: false, SendMessages: false }, { reason: `Modmail ticket closed` });
		}

		// Reopening clears a stored snapshot. Rebuild it after revoking the opener's
		// access so the saved history includes messages from this session.
		const transcript = ticket.storedAt ?
			await encodeStoredTranscript(await generateTranscript(interaction.channel, ticket)) :
			undefined;
		const now = new Date();
		const [updated] = await ModmailTickets.update({
			closedAt: now,
			closedBy: interaction.user.id,
			deleteAt: ticket.storedAt ? null : new Date(now.getTime() + DELETE_DELAY_MS),
			status: ticket.storedAt ? `stored` : `closed`,
			...(ticket.storedAt ? { transcript } : {}),
		}, { where: { id: ticket.id, status: `open` } });
		if (updated !== 1) {
			throw new Error(`Modmail ticket ${ticket.id} changed state while closing.`);
		}
		closeSaved = true;
		// Keep the old Close control until a replacement panel is confirmed.
		// If this send fails, restore the database row and opener access below.
		await interaction.channel.send(buildClosedPanel(ticket, interaction.user.id));
	} catch (err) {
		let restorationFailed = false;
		if (closeSaved) {
			try {
				const [restored] = await ModmailTickets.update(previousState, {
					where: { id: ticket.id, status: ticket.storedAt ? `stored` : `closed` },
				});
				restorationFailed = restored !== 1;
			} catch (restoreError) {
				restorationFailed = true;
				error(`Could not roll back Modmail ticket ${ticket.id} after its closed panel failed:`, restoreError);
			}
		}
		if (accessChangeAttempted && !restorationFailed) {
			try {
				await restoreOpenerOverwrite(interaction.channel, ticket.openerId, previousOverwrite,
					`Modmail close failed; restoring ticket access`);
			} catch (restoreError) {
				restorationFailed = true;
				error(`Could not restore opener access after Modmail close failed for ticket ${ticket.id}:`, restoreError);
			}
		}
		error(`Could not close Modmail ticket ${ticket.id}:`, err);
		return interaction.editReply({
			content: restorationFailed ?
				`Hachi could not restore the ticket state or opener access after closing failed. Contact the bot owner.` :
				`The ticket could not be closed. ${err instanceof TranscriptLimitError ? err.message : `Please retry.`}`,
			components: [],
		});
	}

	if (controlMessageId) {
		const controlMessage = await interaction.channel.messages.fetch(controlMessageId).catch(() => null);
		await controlMessage?.edit({ components: [] }).catch(() => null);
	}
	await interaction.channel.setName(ticketName(ticket.ticketNumber, true), `Modmail ticket closed`).catch(() => null);
	await interaction.editReply({ content: `Ticket closed.`, components: [] }).catch(replyError =>
		error(`Could not update close confirmation for Modmail ticket ${ticket.id}:`, replyError));
}

async function reopenTicket(interaction, ticket) {
	await interaction.deferUpdate();
	const previousState = {
		closedAt: ticket.closedAt,
		closedBy: ticket.closedBy,
		deleteAt: ticket.deleteAt,
		status: ticket.status,
		transcript: ticket.transcript,
	};
	// Claim the one-open-ticket slot before restoring access. The database index
	// also rejects another process trying to create a ticket at the same time.
	let anotherOpenTicketExists = false;
	let reopened;
	try {
		reopened = await sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
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
				anotherOpenTicketExists = true;
				return false;
			}
			const [changed] = await ModmailTickets.update(
				{ closedAt: null, closedBy: null, deleteAt: null, status: `open`, transcript: null },
				{ transaction, where: { id: ticket.id, status: ticket.status } },
			);
			return changed === 1;
		});
	} catch (err) {
		error(`Could not claim Modmail ticket ${ticket.id} for reopening:`, err);
		return interaction.followUp({ content: `The ticket could not be reopened. Please retry.`, ephemeral: true });
	}
	if (!reopened) {
		return interaction.followUp({
			content: anotherOpenTicketExists ?
				`The ticket opener already has another open ticket. Close it before reopening this one.` :
				`This ticket changed state before it could be reopened. Use its latest controls.`,
			ephemeral: true,
		});
	}
	const previousOverwrite = interaction.channel.permissionOverwrites.cache.get(ticket.openerId);
	let accessChangeAttempted = false;
	try {
		accessChangeAttempted = true;
		await interaction.channel.permissionOverwrites.edit(ticket.openerId, {
			ViewChannel: true,
			SendMessages: true,
			ReadMessageHistory: true,
			AttachFiles: true,
		}, { reason: `Modmail ticket reopened` });
		// The old closed panel remains usable until the new Close control exists.
		await interaction.channel.send({ content: `Ticket reopened by <@${interaction.user.id}>.`, allowedMentions: { parse: [] }, components: buildOpenControls(ticket.id) });
	} catch (err) {
		let restorationFailed;
		try {
			const [restored] = await ModmailTickets.update(previousState, { where: { id: ticket.id, status: `open` } });
			restorationFailed = restored !== 1;
		} catch (rollbackError) {
			restorationFailed = true;
			error(`Failed to restore Modmail ticket ${ticket.id} after reopening failed:`, rollbackError);
		}
		if (accessChangeAttempted && !restorationFailed) {
			try {
				await restoreOpenerOverwrite(interaction.channel, ticket.openerId, previousOverwrite,
					`Modmail reopen failed; restoring prior access`);
			} catch (restoreError) {
				restorationFailed = true;
				error(`Failed to restore Modmail ticket ${ticket.id} permissions after reopening failed:`, restoreError);
			}
		}
		error(`Could not reopen Modmail ticket ${ticket.id}:`, err);
		return interaction.followUp({
			content: restorationFailed ?
				`Hachi could not restore this ticket after reopening failed. Contact the bot owner.` :
				`The ticket could not be reopened. Please retry.`,
			ephemeral: true,
		});
	}
	await interaction.channel.setName(ticketName(ticket.ticketNumber), `Modmail ticket reopened`).catch(() => null);
	await interaction.message.edit({ components: [], embeds: [] }).catch(err =>
		error(`Could not retire old Modmail controls for reopened ticket ${ticket.id}:`, err));
}

class TranscriptLimitError extends Error {}

function formatTranscriptMessage(message) {
	const details = [message.content || ``];
	for (const attachment of message.attachments?.values() || []) {
		details.push(`Attachment: ${attachment.url}`);
	}
	for (const embed of message.embeds || []) {
		const embedDetails = [
			embed.title,
			embed.description,
			embed.url,
			...(embed.fields || []).map(field => `${field.name}: ${field.value}`),
			embed.image?.url,
			embed.thumbnail?.url,
		].filter(Boolean);
		details.push(`Embed: ${embedDetails.join(` | `) || `[no text]`}`);
	}
	for (const sticker of message.stickers?.values() || []) {
		details.push(`Sticker: ${sticker.name} (${sticker.id})`);
	}
	return `[${message.createdAt.toISOString()}] ${message.author.tag || message.author.id} (${message.author.id}): ${details.filter(Boolean).join(` | `)}`;
}

async function generateTranscript(channel, ticket) {
	const header = [
		`Modmail ticket ${ticketName(ticket.ticketNumber)}`,
		`Guild: ${channel.guild.name} (${channel.guild.id})`,
		`Opened by: ${ticket.openerId}`,
		`Opened: ${ticket.openedAt.toISOString()}`,
		``,
	].join(`\n`);
	const pages = [];
	let totalBytes = Buffer.byteLength(header, `utf8`);
	let messageCount = 0;
	let before;
	const startedAt = Date.now();

	// Discord returns newest first. Keep only one fetched batch of message objects at a
	// time, and prepend its formatted text so the finished transcript reads oldest first.
	while (true) {
		if (Date.now() - startedAt > TRANSCRIPT_GENERATION_TIMEOUT_MS) {
			throw new TranscriptLimitError(`Transcript generation exceeded five minutes. No partial transcript was saved or sent; please retry.`);
		}
		const batch = await channel.messages.fetch({ before, limit: 100 });
		if (Date.now() - startedAt > TRANSCRIPT_GENERATION_TIMEOUT_MS) {
			throw new TranscriptLimitError(`Transcript generation exceeded five minutes. No partial transcript was saved or sent; please retry.`);
		}
		if (messageCount + batch.size > MAX_TRANSCRIPT_MESSAGES) {
			throw new TranscriptLimitError(
				`This transcript exceeds the ${MAX_TRANSCRIPT_MESSAGES.toLocaleString()}-message limit. ` +
				`No partial transcript was saved or sent; ask the bot owner to export the ticket manually.`,
			);
		}
		if (batch.size === 0) {
			break;
		}

		const pageLines = [];
		for (const message of [...batch.values()].reverse()) {
			pageLines.push(formatTranscriptMessage(message));
		}
		const pageText = pageLines.join(`\n`);
		totalBytes += Buffer.byteLength(pageText, `utf8`) + 1;
		if (totalBytes > MAX_TRANSCRIPT_BYTES) {
			throw new TranscriptLimitError(`This transcript exceeds the 24 MiB size limit. No partial transcript was saved or sent; ask the bot owner to export the ticket manually.`);
		}
		pages.unshift(pageText);
		messageCount += batch.size;

		if (batch.size < 100) {
			break;
		}
		const nextBefore = batch.last()?.id;
		if (!nextBefore || nextBefore === before) {
			throw new Error(`Discord did not advance Modmail transcript pagination.`);
		}
		before = nextBefore;
	}

	return [header, ...pages].join(`\n`);
}

async function encodeStoredTranscript(transcript) {
	const rawBytes = Buffer.byteLength(transcript, `utf8`);
	let storedTranscript = transcript;
	if (rawBytes > TRANSCRIPT_COMPRESSION_THRESHOLD_BYTES) {
		// The existing TEXT column can hold a versioned compressed snapshot without a
		// schema change. Older plain-text tickets remain readable.
		const compressed = `${COMPRESSED_TRANSCRIPT_PREFIX}${(await gzipAsync(Buffer.from(transcript, `utf8`))).toString(`base64`)}`;
		if (Buffer.byteLength(compressed, `utf8`) < rawBytes) {
			storedTranscript = compressed;
		}
	}
	if (Buffer.byteLength(storedTranscript, `utf8`) > MAX_STORED_TRANSCRIPT_BYTES) {
		throw new TranscriptLimitError(`This transcript exceeds the 8 MiB stored-ticket limit after compression. The ticket was not stored; ask the bot owner to export it manually.`);
	}
	return storedTranscript;
}

async function decodeStoredTranscript(storedTranscript) {
	if (!storedTranscript.startsWith(COMPRESSED_TRANSCRIPT_PREFIX)) {
		// Pre-compression tickets were stored as plain text and may exceed today's
		// snapshot limit. They remain downloadable up to the transcript output cap.
		return storedTranscript;
	}
	if (Buffer.byteLength(storedTranscript, `utf8`) > MAX_STORED_TRANSCRIPT_BYTES) {
		throw new TranscriptLimitError(`This stored transcript exceeds the supported 8 MiB snapshot limit. Ask the bot owner to export the ticket manually.`);
	}
	try {
		const compressed = Buffer.from(storedTranscript.slice(COMPRESSED_TRANSCRIPT_PREFIX.length), `base64`);
		return (await gunzipAsync(compressed, { maxOutputLength: MAX_TRANSCRIPT_BYTES })).toString(`utf8`);
	} catch (err) {
		error(`Could not decode a stored Modmail transcript:`, err);
		throw new TranscriptLimitError(`The stored transcript could not be read. Ask the bot owner to inspect this ticket.`);
	}
}

function splitTranscript(transcript, attachmentSizeLimit) {
	const transcriptBytes = Buffer.from(transcript, `utf8`);
	if (!transcriptBytes.length) {
		throw new TranscriptLimitError(`This stored transcript is empty. Ask the bot owner to inspect this ticket.`);
	}
	if (transcriptBytes.length > MAX_TRANSCRIPT_BYTES) {
		throw new TranscriptLimitError(`This transcript exceeds the 24 MiB size limit. Ask the bot owner to export the ticket manually.`);
	}
	// Leave room below Discord's per-interaction upload limit for request overhead.
	const uploadLimit = Number.isSafeInteger(attachmentSizeLimit) ? attachmentSizeLimit - 1024 : TRANSCRIPT_PART_BYTES;
	const partSizeLimit = Math.min(TRANSCRIPT_PART_BYTES, uploadLimit);
	if (partSizeLimit < 1024) {
		throw new TranscriptLimitError(`Discord's upload limit for this interaction is too small to deliver a transcript.`);
	}
	const parts = [];
	for (let start = 0; start < transcriptBytes.length;) {
		let end = Math.min(start + partSizeLimit, transcriptBytes.length);
		if (end < transcriptBytes.length) {
			const lastNewline = transcriptBytes.lastIndexOf(10, end - 1);
			if (lastNewline >= end - Math.min(4096, Math.floor(partSizeLimit / 8))) {
				end = lastNewline + 1;
			} else {
				// A long line can still be split without cutting a UTF-8 character.
				while (end > start && (transcriptBytes[end] & 0xc0) === 0x80) {
					end--;
				}
			}
		}
		parts.push(transcriptBytes.subarray(start, end));
		if (parts.length > MAX_TRANSCRIPT_PARTS) {
			throw new TranscriptLimitError(`Discord's upload limit would require more than ${MAX_TRANSCRIPT_PARTS} transcript attachments. No partial transcript was sent.`);
		}
		start = end;
	}
	return parts;
}

async function sendTranscript(interaction, ticket) {
	await interaction.deferReply({ ephemeral: true });
	let parts;
	try {
		let transcript;
		try {
			// A saved snapshot may predate a stored ticket's last reopen. Read the
			// live channel whenever it exists so the download includes later messages.
			transcript = await generateTranscript(interaction.channel, ticket);
		} catch (err) {
			if (Number(err?.code) !== 10003 || !ticket.transcript) {
				throw err;
			}
			// A confirmed missing channel is the only reason to use its snapshot.
			transcript = await decodeStoredTranscript(ticket.transcript);
		}
		parts = splitTranscript(transcript, interaction.attachmentSizeLimit);
	} catch (err) {
		if (err instanceof TranscriptLimitError) {
			return interaction.editReply({ content: err.message });
		}
		throw err;
	}

	const name = ticketName(ticket.ticketNumber);
	let sentParts = 0;
	try {
		for (const [partIndex, part] of parts.entries()) {
			const filename = parts.length === 1 ? `${name}.txt` : `${name}-part-${String(partIndex + 1).padStart(2, `0`)}.txt`;
			const payload = {
				content: parts.length === 1 ? `Transcript for ${name}.` : `Transcript for ${name}, part ${partIndex + 1} of ${parts.length}.`,
				files: [new AttachmentBuilder(part, { name: filename })],
			};
			if (partIndex === 0) {
				await interaction.editReply(payload);
			} else {
				await interaction.followUp({ ...payload, ephemeral: true });
			}
			sentParts++;
		}
	} catch (err) {
		error(`Could not deliver Modmail transcript ${ticket.id}:`, err);
		await interaction.editReply({ content: `Could not deliver the complete transcript (${sentParts} of ${parts.length} parts sent). Please retry.` });
	}
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
	let transcript;
	try {
		transcript = await encodeStoredTranscript(await generateTranscript(interaction.channel, ticket));
	} catch (err) {
		if (err instanceof TranscriptLimitError) {
			return interaction.editReply({ content: err.message });
		}
		throw err;
	}
	await ticket.update({
		deleteAt: null,
		status: `stored`,
		storedAt: new Date(),
		storedBy: interaction.user.id,
		transcript,
	});
	await interaction.editReply(`Stored ${ticketName(ticket.ticketNumber)}. Its automatic deletion has been cancelled.`);
}

async function deleteTicketChannel(interaction, ticket) {
	await interaction.deferUpdate();
	if (ticket.storedAt) {
		try {
			// Staff can add messages after closing. Refresh an archived snapshot
			// before its channel is permanently removed from Discord.
			const transcript = await encodeStoredTranscript(await generateTranscript(interaction.channel, ticket));
			await ticket.update({ transcript });
		} catch (err) {
			error(`Could not preserve transcript before deleting stored Modmail ticket ${ticket.id}:`, err);
			return interaction.editReply({
				content: `The ticket was not deleted because its current transcript could not be saved. ${err instanceof TranscriptLimitError ? err.message : `Please retry.`}`,
				components: [],
			});
		}
	}
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
		return runTicketTransition(interaction, ticket, [`open`], currentTicket =>
			closeTicket(interaction, currentTicket, controlMessageId));
	}
	if (action === `open`) {
		return runTicketTransition(interaction, ticket, [`closed`, `stored`], currentTicket =>
			reopenTicket(interaction, currentTicket));
	}
	if (action === `transcript`) {
		if (ticket.status !== `closed` && ticket.status !== `stored`) {
			return interaction.reply({ content: `Close this ticket before downloading its transcript.`, ephemeral: true });
		}
		return sendTranscript(interaction, ticket);
	}
	if (action === `store`) {
		return runTicketTransition(interaction, ticket, [`closed`], currentTicket =>
			storeTicket(interaction, currentTicket, config));
	}
	if (action === `delete`) {
		if (ticket.status !== `closed` && ticket.status !== `stored`) {
			return interaction.reply({ content: `Close this ticket before deleting it.`, ephemeral: true });
		}
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
		return runTicketTransition(interaction, ticket, [`closed`, `stored`], currentTicket =>
			deleteTicketChannel(interaction, currentTicket));
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
	try {
		await config.update({ panelMessageId: panel.id });
	} catch (err) {
		await panel.delete().catch(deleteError =>
			error(`Could not remove an unsaved replacement Modmail panel ${panel.id}:`, deleteError));
		throw err;
	}
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
