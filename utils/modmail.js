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

	return config.reload();
}

async function allocateTicket(guildId, openerId) {
	return sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
		const config = await ModmailConfigs.findByPk(guildId, { transaction });

		if (!config) {
			throw new Error(`Modmail is not configured.`);
		}

		const ticketNumber = config.nextTicketNumber;
		await config.increment(`nextTicketNumber`, { by: 1, transaction });

		return ModmailTickets.create({ guildId, ticketNumber, openerId, openedAt: new Date() }, { transaction });
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

async function createTicket(interaction) {
	const config = await getConfig(interaction.guild.id);

	if (!config) {
		return interaction.reply({ content: `Modmail is not configured.`, ephemeral: true });
	}

	const existing = await ModmailTickets.findOne({ where: { guildId: interaction.guild.id, openerId: interaction.user.id, status: `open` } });

	if (existing?.channelId) {
		return interaction.reply({ content: `You already have an open ticket: <#${existing.channelId}>`, ephemeral: true });
	}

	await interaction.deferReply({ ephemeral: true });
	const ticket = await allocateTicket(interaction.guild.id, interaction.user.id);

	try {
		const channel = await interaction.guild.channels.create({
			name: ticketName(ticket.ticketNumber),
			parent: config.ticketCategoryId,
			permissionOverwrites: buildTicketOverwrites(interaction.guild, interaction.user.id, config),
			reason: `Modmail ticket opened by ${interaction.user.tag}`,
		});
		ticket.channelId = channel.id;
		await ticket.save();
		const { pingRoleIds } = getRoleIds(config);

		await channel.send({
			allowedMentions: { users: [interaction.user.id], roles: pingRoleIds },
			components: buildOpenControls(ticket.id),
			content: welcomeText(interaction.user.id, pingRoleIds),
		});
		await interaction.editReply(`Your ticket has been created: ${channel}`);
	} catch (err) {
		await ticket.destroy().catch(() => null);
		throw err;
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
	await interaction.channel.permissionOverwrites.edit(ticket.openerId, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true }, { reason: `Modmail ticket reopened` });
	await ticket.update({ closedAt: null, closedBy: null, deleteAt: null, status: `open` });
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
	await interaction.update({ content: `Deleting ticket…`, components: [] });
	ticket.channelId = null;
	if (!ticket.storedAt) {
		ticket.status = `deleted`;
	}
	await ticket.save();
	await interaction.channel.delete(`Modmail ticket deleted by ${interaction.user.tag}`);
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
	const tickets = await ModmailTickets.findAll({ where: { status: `closed`, deleteAt: { [Op.lte]: now } } });

	for (const ticket of tickets) {
		const guild = client.guilds.cache.get(ticket.guildId);
		const channel = guild && ticket.channelId ? await guild.channels.fetch(ticket.channelId).catch(() => null) : null;
		if (channel) {
			await channel.delete(`Modmail 15-day retention expired`).catch(err => error(`Failed to delete expired Modmail ticket:`, err));
		}
		ticket.channelId = null;
		ticket.status = `deleted`;
		await ticket.save();
	}

	if (tickets.length) {
		info(`Deleted ${tickets.length} expired Modmail ticket channel(s).`);
	}
	return tickets.length;
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
	memberIsStaff,
	restoreDeletedPanel,
	ticketName,
};
