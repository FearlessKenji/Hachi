// /modmail setup and administration plus persistent ticket button routing.
const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	RoleSelectMenuBuilder,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
} = require(`discord.js`);
const { ModmailTickets } = require(`../../../database/dbObjects.js`);
const { Op } = require(`sequelize`);
const {
	createTicket,
	ensureInfrastructure,
	getConfig,
	getRoleIds,
	handleTicketComponent,
	ticketName,
} = require(`../../../utils/modmail.js`);

const pendingSetups = new Map();

function formatRoles(roleIds) {
	return roleIds.length ? roleIds.map(id => `<@&${id}>`).join(`, `) : `None`;
}

function setupEmbed(settings) {
	const effective = [...new Set([...settings.allowedRoleIds, ...settings.pingRoleIds])];

	return new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle(`Modmail Setup`)
		.setDescription(`Hachi will create and exclusively manage **#modmail** plus a **Modmail Tickets** category.`)
		.addFields(
			{ name: `Ping Roles`, value: formatRoles(settings.pingRoleIds) },
			{ name: `Access-only Roles`, value: formatRoles(settings.allowedRoleIds) },
			{ name: `Effective Allowed Roles`, value: formatRoles(effective) },
			{ name: `Stored Ticket Limit`, value: String(settings.maxStoredTickets) },
		)
		.setFooter({ text: `Ping roles automatically receive ticket access.` });
}

function setupComponents(setupId) {
	return [
		new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder().setCustomId(`modmail:setup:${setupId}:ping`).setPlaceholder(`Select roles to ping`).setMinValues(0).setMaxValues(25),
		),
		new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder().setCustomId(`modmail:setup:${setupId}:allowed`).setPlaceholder(`Select additional allowed roles`).setMinValues(0).setMaxValues(25),
		),
		new ActionRowBuilder().addComponents(
			new StringSelectMenuBuilder().setCustomId(`modmail:setup:${setupId}:limit`).setPlaceholder(`Stored ticket limit`).addOptions(
				[25, 50, 100, 250].map(value => new StringSelectMenuOptionBuilder().setLabel(String(value)).setValue(String(value))),
			),
		),
		new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId(`modmail:setup:${setupId}:submit`).setLabel(`Create or Update Modmail`).setStyle(ButtonStyle.Success),
		),
	];
}

async function openSetup(interaction) {
	const existing = await getConfig(interaction.guild.id);
	const roles = getRoleIds(existing);
	const settings = {
		allowedRoleIds: roles.allowedRoleIds,
		guildId: interaction.guild.id,
		maxStoredTickets: existing?.maxStoredTickets || 50,
		pingRoleIds: roles.pingRoleIds,
		ticketCategoryId: existing?.ticketCategoryId || null,
		userId: interaction.user.id,
	};

	pendingSetups.set(interaction.id, settings);
	await interaction.reply({ embeds: [setupEmbed(settings)], components: setupComponents(interaction.id), flags: MessageFlags.Ephemeral });
}

async function handleSetup(interaction, setupId, action) {
	const settings = pendingSetups.get(setupId);

	if (!settings || settings.userId !== interaction.user.id || settings.guildId !== interaction.guild.id) {
		return interaction.reply({ content: `This setup panel has expired. Run \`/modmail setup\` again.`, flags: MessageFlags.Ephemeral });
	}

	if (action === `ping`) {
		settings.pingRoleIds = interaction.values;
	}
	if (action === `allowed`) {
		settings.allowedRoleIds = interaction.values;
	}
	if (action === `limit`) {
		settings.maxStoredTickets = Number(interaction.values[0]);
	}

	if (action !== `submit`) {
		return interaction.update({ embeds: [setupEmbed(settings)], components: setupComponents(setupId) });
	}

	await interaction.deferUpdate();
	const config = await ensureInfrastructure(interaction.guild, settings);
	pendingSetups.delete(setupId);
	await interaction.editReply({
		content: `Modmail is ready in <#${config.entryChannelId}>. Tickets will be created under <#${config.ticketCategoryId}>.`,
		embeds: [],
		components: [],
	});
}

async function showStatus(interaction) {
	const config = await getConfig(interaction.guild.id);

	if (!config) {
		return interaction.reply({ content: `Modmail is not configured. Run \`/modmail setup\`.`, flags: MessageFlags.Ephemeral });
	}

	const roles = getRoleIds(config);
	const stored = await ModmailTickets.count({ where: { guildId: interaction.guild.id, storedAt: { [Op.ne]: null } } });
	await interaction.reply({
		embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle(`Modmail Status`).addFields(
			{ name: `Entry Channel`, value: `<#${config.entryChannelId}>`, inline: true },
			{ name: `Ticket Category`, value: `<#${config.ticketCategoryId}>`, inline: true },
			{ name: `Next Ticket`, value: ticketName(config.nextTicketNumber), inline: true },
			{ name: `Ping Roles`, value: formatRoles(roles.pingRoleIds) },
			{ name: `Additional Allowed Roles`, value: formatRoles(roles.allowedRoleIds) },
			{ name: `Stored Tickets`, value: `${stored}/${config.maxStoredTickets}`, inline: true },
		)],
		flags: MessageFlags.Ephemeral,
	});
}

async function listStored(interaction) {
	const tickets = await ModmailTickets.findAll({
		limit: 25,
		order: [[`storedAt`, `DESC`]],
		where: { guildId: interaction.guild.id, storedAt: { [Op.ne]: null } },
	});
	const content = tickets.length ?
		tickets.map(ticket =>
			`• **${ticketName(ticket.ticketNumber)}** — opened by <@${ticket.openerId}>, stored <t:${Math.floor(ticket.storedAt.getTime() / 1000)}:R>`,
		).join(`\n`) :
		`No tickets are stored.`;

	await interaction.reply({ content, allowedMentions: { parse: [] }, flags: MessageFlags.Ephemeral });
}

async function deleteStored(interaction) {
	const number = interaction.options.getInteger(`number`, true);
	const ticket = await ModmailTickets.findOne({
		where: { guildId: interaction.guild.id, storedAt: { [Op.ne]: null }, ticketNumber: number },
	});

	if (!ticket) {
		return interaction.reply({ content: `Stored ticket ${ticketName(number)} was not found.`, flags: MessageFlags.Ephemeral });
	}

	const isOpen = ticket.channelId && !ticket.closedAt;
	ticket.transcript = null;
	ticket.storedAt = null;
	ticket.storedBy = null;
	ticket.status = isOpen ? `open` : ticket.channelId ? `closed` : `deleted`;
	ticket.deleteAt = ticket.channelId && !isOpen ? new Date(Date.now() + 15 * 24 * 60 * 60 * 1000) : null;
	await ticket.save();
	await interaction.reply({ content: `Removed the stored transcript for ${ticketName(number)}.`, flags: MessageFlags.Ephemeral });
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`modmail`)
		.setDescription(`Configure and manage Modmail tickets.`)
		.setContexts(InteractionContextType.Guild)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.addSubcommand(command => command.setName(`setup`).setDescription(`Create or update the Modmail system.`))
		.addSubcommand(command => command.setName(`status`).setDescription(`Show the current Modmail configuration.`))
		.addSubcommand(command => command.setName(`stored`).setDescription(`List recently stored Modmail tickets.`))
		.addSubcommand(command => command.setName(`delete-stored`).setDescription(`Remove a stored ticket transcript.`)
			.addIntegerOption(option => option.setName(`number`).setDescription(`Ticket number, without leading zeroes.`).setRequired(true).setMinValue(1))),

	help: {
		category: `management`,
		permissions: [PermissionFlagsBits.ManageGuild],
		entries: [
			{ command: `/modmail setup`, description: `create the managed Modmail entry channel and configure staff roles.` },
			{ command: `/modmail status`, description: `show Modmail channels, roles, numbering, and storage usage.` },
			{ command: `/modmail stored`, description: `list stored ticket transcripts.` },
		],
	},

	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();

		if (subcommand === `setup`) {
			return openSetup(interaction);
		}
		if (subcommand === `status`) {
			return showStatus(interaction);
		}
		if (subcommand === `stored`) {
			return listStored(interaction);
		}
		if (subcommand === `delete-stored`) {
			return deleteStored(interaction);
		}
	},

	async handleComponent(interaction) {
		const parts = interaction.customId.split(`:`);

		if (parts[1] === `create`) {
			return createTicket(interaction);
		}
		if (parts[1] === `setup`) {
			return handleSetup(interaction, parts[2], parts[3]);
		}
		if (parts[1] === `ticket`) {
			return handleTicketComponent(interaction, parts[2], parts[3], parts[4]);
		}
	},
};
