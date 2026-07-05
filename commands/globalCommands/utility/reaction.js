const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	RoleSelectMenuBuilder,
	SlashCommandBuilder,
} = require(`discord.js`);
const { ReactionRoleItems, ReactionRoleMessages, Servers } = require(`../../../database/dbObjects.js`);
const { error } = require(`../../../utils/writeLog.js`);
const {
	buildPanelEmbed,
	buildPanelPayload,
	canManageReactionRoles,
	chunkItems,
	DEFAULT_PANEL_DESCRIPTION,
	deletePanelMessages,
	deletePanelRecords,
	getDefaultEmoji,
	getPanelGroup,
	getPanelItems,
	getPanelRoleLimit,
	reactToMessageForPanel,
	roleIsAssignable,
} = require(`../../../utils/reactionRoles.js`);

const pendingPanels = new Map();
const textChannelTypes = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
];

function buildPendingFromOptions(interaction) {
	return {
		baseRoleEmojis: [],
		channelId: interaction.options.getChannel(`channel`).id,
		description: interaction.options.getString(`message`) || DEFAULT_PANEL_DESCRIPTION,
		guildId: interaction.guild.id,
		imageUrl: null,
		isEditing: false,
		reactionEmojis: [],
		roles: [],
		setupReactionEmojis: [],
		setupMessageId: null,
		statusMessage: null,
		thumbnailUrl: null,
		title: interaction.options.getString(`title`),
		userId: interaction.user.id,
	};
}

function buildPendingPanel(pending) {
	return {
		description: pending.description,
		id: `preview`,
		imageUrl: pending.imageUrl,
		thumbnailUrl: pending.thumbnailUrl,
		title: pending.title || `Reaction Roles`,
	};
}

function buildPendingItems(pending) {
	return pending.roles.map((role, index) => ({
		category: role.category || null,
		emoji: role.emoji || null,
		label: role.label,
		roleId: role.roleId,
		sortOrder: index,
	}));
}

function getUnusedDefaultEmoji(usedEmojis, startIndex) {
	const limit = getPanelRoleLimit(`reaction`);

	for (let offset = 0; offset < limit; offset += 1) {
		const emoji = getDefaultEmoji((startIndex + offset) % limit);

		if (emoji && !usedEmojis.has(emoji)) {
			return emoji;
		}
	}

	return null;
}

function applyPendingReactionEmojis(pending) {
	const usedEmojis = new Set();
	const baseRoleEmojis = pending.baseRoleEmojis || [];
	const reactionEmojis = pending.reactionEmojis || [];

	for (let index = 0; index < pending.roles.length; index += 1) {
		const role = pending.roles[index];
		const configuredEmoji = reactionEmojis[index];
		const baseEmoji = baseRoleEmojis[index];
		const existingEmoji = role.emoji;

		if (configuredEmoji && !usedEmojis.has(configuredEmoji)) {
			role.emoji = configuredEmoji;
			usedEmojis.add(configuredEmoji);
			continue;
		}

		if (baseEmoji && !usedEmojis.has(baseEmoji)) {
			role.emoji = baseEmoji;
			usedEmojis.add(baseEmoji);
			continue;
		}

		if (existingEmoji && !usedEmojis.has(existingEmoji)) {
			role.emoji = existingEmoji;
			usedEmojis.add(existingEmoji);
			continue;
		}

		const fallbackEmoji = getUnusedDefaultEmoji(usedEmojis, index);
		role.emoji = fallbackEmoji;

		if (fallbackEmoji) {
			usedEmojis.add(fallbackEmoji);
		}
	}
}

function buildPendingContent(pending) {
	const status = pending.statusMessage ? `\n### ${pending.statusMessage}` : ``;
	const limit = getPanelRoleLimit();
	const messageCount = Math.ceil(Math.max(pending.roles.length, 1) / limit);
	const messageText = messageCount > 1 ?
		`This panel will post ${messageCount} messages.` :
		`This panel will post 1 message.`;

	return `## ${pending.isEditing ? `Edit` : `Add`} Reaction Roles
- Channel: <#${pending.channelId}>
- Roles Added: **${pending.roles.length}**
- ${messageText}

### Constraints
- React to this setup message to assign role emojis in order. Removing a reaction updates the list.
- Custom emoji must belong to this server.
- Use Submit to ${pending.isEditing ? `replace the existing panel` : `create the panel`}.${status}`;
}

function buildPendingComponents(setupId, pending) {
	const components = [];

	components.push(new ActionRowBuilder().addComponents(
		new RoleSelectMenuBuilder()
			.setCustomId(`reaction:${setupId}:addRole`)
			.setPlaceholder(`Search and add role`)
			.setMinValues(1)
			.setMaxValues(1),
	));

	components.push(new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`reaction:${setupId}:undo`)
			.setLabel(`Undo`)
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(!pending.roles.length),
		new ButtonBuilder()
			.setCustomId(`reaction:${setupId}:submit`)
			.setLabel(`Submit`)
			.setStyle(ButtonStyle.Success)
			.setDisabled(!pending.roles.length),
	));

	return components;
}

function buildPendingPayload(setupId, pending) {
	applyPendingReactionEmojis(pending);

	return {
		content: buildPendingContent(pending),
		embeds: [buildPanelEmbed(buildPendingPanel(pending), buildPendingItems(pending), { preview: true })],
		components: buildPendingComponents(setupId, pending),
	};
}

function trackPendingSetupMessage(pending, message) {
	if (message?.id) {
		pending.setupMessageId = message.id;
	}
}

function findPendingSetupByMessage(message) {
	for (const [setupId, pending] of pendingPanels.entries()) {
		if (pending.setupMessageId === message.id && pending.guildId === message.guild?.id) {
			return { pending, setupId };
		}
	}

	return null;
}

function getReactionEmojiValue(reaction) {
	if (reaction.emoji.id) {
		const prefix = reaction.emoji.animated ? `a` : ``;
		return `<${prefix}:${reaction.emoji.name}:${reaction.emoji.id}>`;
	}

	return reaction.emoji.name;
}

function getSetupEmojiLimit(pending) {
	return pending.roles.length;
}

async function customEmojiBelongsToGuild(reaction, message) {
	if (!reaction.emoji.id) {
		return true;
	}

	if (message.guild?.emojis.cache.has(reaction.emoji.id)) {
		return true;
	}

	await message.guild?.emojis.fetch().catch(() => null);

	return message.guild?.emojis.cache.has(reaction.emoji.id) || false;
}

async function removeUserReaction(reaction, user) {
	await reaction.users.remove(user.id).catch(() => null);
}

async function fetchReactionMessage(reaction) {
	if (reaction.partial) {
		await reaction.fetch().catch(() => null);
	}

	if (reaction.message?.partial) {
		await reaction.message.fetch().catch(() => null);
	}

	return reaction.message || null;
}

async function updatePendingSetupMessage(message, setupId, pending) {
	await message.edit(buildPendingPayload(setupId, pending));
}

async function showPendingPanel(interaction, setupId, pending, method = `update`) {
	const payload = buildPendingPayload(setupId, pending);

	if (method === `reply`) {
		await interaction.reply(payload);
		trackPendingSetupMessage(pending, await interaction.fetchReply().catch(() => null));
		return;
	}

	if (method === `editReply`) {
		trackPendingSetupMessage(pending, await interaction.editReply(payload));
		return;
	}

	trackPendingSetupMessage(pending, interaction.message);
	await interaction.update(payload);
}

async function getPendingPanel(interaction, setupId) {
	const pending = pendingPanels.get(setupId);

	if (!pending) {
		await interaction.reply({
			content: `This reaction-role setup request is no longer available. Run \`/reaction roles add\` again.`,
			flags: MessageFlags.Ephemeral,
		});
		return null;
	}

	if (pending.userId !== interaction.user.id || pending.guildId !== interaction.guild.id) {
		await interaction.reply({
			content: `Only the admin who started this reaction-role setup can use these controls.`,
			flags: MessageFlags.Ephemeral,
		});
		return null;
	}

	return pending;
}

async function startAdd(interaction) {
	if (!canManageReactionRoles(interaction)) {
		await interaction.reply({
			content: `You need both Manage Server and Manage Roles to manage reaction roles.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await Servers.upsert({ guildId: interaction.guild.id });

	const setupId = interaction.id;
	const pending = buildPendingFromOptions(interaction);

	pendingPanels.set(setupId, pending);
	await showPendingPanel(interaction, setupId, pending, `reply`);
}

async function buildPendingFromPanel(interaction, panel) {
	const groupPanels = await getPanelGroup(panel);
	const items = [];

	for (const groupPanel of groupPanels) {
		const panelItems = await getPanelItems(groupPanel.id);
		items.push(...panelItems);
	}

	const firstPanel = groupPanels[0] || panel;
	const roles = items.map(item => ({
		category: item.category || null,
		emoji: item.emoji || null,
		label: item.label,
		roleId: item.roleId,
	}));
	const emojis = roles.map(role => role.emoji || null);

	return {
		baseRoleEmojis: emojis,
		channelId: firstPanel.channelId,
		description: firstPanel.description || DEFAULT_PANEL_DESCRIPTION,
		editPanelIds: groupPanels.map(groupPanel => groupPanel.id),
		guildId: interaction.guild.id,
		imageUrl: firstPanel.imageUrl,
		isEditing: true,
		reactionEmojis: [],
		roles,
		setupReactionEmojis: [],
		setupMessageId: null,
		statusMessage: `Loaded ${roles.length} role(s) from the existing panel.`,
		thumbnailUrl: firstPanel.thumbnailUrl,
		title: firstPanel.title,
		userId: interaction.user.id,
	};
}

async function startEdit(interaction, panel) {
	if (!canManageReactionRoles(interaction)) {
		await interaction.reply({
			content: `You need both Manage Server and Manage Roles to manage reaction roles.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const setupId = interaction.id;
	const pending = await buildPendingFromPanel(interaction, panel);

	pendingPanels.set(setupId, pending);
	await showPendingPanel(interaction, setupId, pending, `reply`);
}

async function getTargetChannel(interaction, pending) {
	const channel = await interaction.guild.channels.fetch(pending.channelId).catch(() => null);

	if (!channel?.send) {
		throw new Error(`I cannot send messages in the selected channel.`);
	}

	return channel;
}

async function createPanelChunk(interaction, pending, channel, roles, panelIndex, totalPanels, groupKey) {
	const placeholderMessageId = `pending:${interaction.id}:${panelIndex}`;
	let panel = null;

	try {
		panel = await ReactionRoleMessages.create({
			channelId: channel.id,
			description: pending.description,
			groupKey,
			guildId: interaction.guild.id,
			imageUrl: pending.imageUrl,
			messageId: placeholderMessageId,
			panelIndex,
			status: `active`,
			thumbnailUrl: pending.thumbnailUrl,
			title: pending.title,
		});

		const items = [];

		for (let index = 0; index < roles.length; index += 1) {
			const role = roles[index];
			const globalIndex = panelIndex * getPanelRoleLimit() + index;
			const emoji = role.emoji || getDefaultEmoji(index);
			const item = await ReactionRoleItems.create({
				category: role.category || null,
				emoji,
				guildId: interaction.guild.id,
				label: role.label,
				messageId: null,
				reactionRoleMessageId: panel.id,
				roleId: role.roleId,
				sortOrder: globalIndex,
			});

			items.push(item);
		}

		const message = await channel.send(buildPanelPayload(panel, items, { panelIndex, totalPanels }));
		await panel.update({ messageId: message.id });
		await ReactionRoleItems.update(
			{ messageId: message.id },
			{ where: { reactionRoleMessageId: panel.id } },
		);
		await reactToMessageForPanel(message, panel, items);

		return { message, panel };
	} catch (err) {
		if (panel) {
			await deletePanelRecords([panel.id]);
		}

		throw err;
	}
}

async function disableAndDeletePanels(client, panels) {
	const ids = panels
		.map(panel => panel.id)
		.filter(id => id);

	if (!ids.length) {
		return;
	}

	await ReactionRoleMessages.update(
		{ status: `disabled` },
		{ where: { id: ids } },
	);
	await deletePanelMessages(client, panels);
	await deletePanelRecords(ids);
}

async function clearSetupMessage(message) {
	if (!message) {
		return;
	}

	await message.delete().catch(async () => {
		await message.edit({
			content: `Reaction-role setup closed.`,
			embeds: [],
			components: [],
		}).catch(() => null);
	});
}

async function createSubmittedPanels(interaction, pending) {
	if (!pending.roles.length) {
		throw new Error(`Add at least one role before submitting.`);
	}

	applyPendingReactionEmojis(pending);

	const limit = getPanelRoleLimit();
	const chunks = chunkItems(pending.roles, limit);
	const createdPanels = [];

	const channel = await getTargetChannel(interaction, pending);
	const groupKey = chunks.length > 1 ? `reaction-${interaction.id}` : null;

	try {
		for (let index = 0; index < chunks.length; index += 1) {
			const { panel } = await createPanelChunk(interaction, pending, channel, chunks[index], index, chunks.length, groupKey);
			createdPanels.push(panel);
		}

		if (pending.editPanelIds?.length) {
			const oldPanels = await ReactionRoleMessages.findAll({
				where: { id: pending.editPanelIds },
			});
			await disableAndDeletePanels(interaction.client, oldPanels);
		}

		return {
			channel,
			count: chunks.length,
		};
	} catch (err) {
		if (createdPanels.length) {
			await disableAndDeletePanels(interaction.client, createdPanels).catch(cleanupErr => {
				error(`Failed to clean up partial reaction-role panel creation:`, cleanupErr);
			});
		}

		throw err;
	}
}

async function submitPendingPanel(interaction, setupId) {
	const pending = await getPendingPanel(interaction, setupId);

	if (!pending) {
		return;
	}

	if (!pending.roles.length) {
		pending.statusMessage = `Add at least one role before submitting.`;
		await showPendingPanel(interaction, setupId, pending);
		return;
	}

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	try {
		const result = await createSubmittedPanels(interaction, pending);

		pendingPanels.delete(setupId);

		await interaction.editReply({
			content: `${pending.isEditing ? `Updated` : `Created`} ${result.count} reaction-role message(s) in <#${result.channel.id}>.`,
		});
		await clearSetupMessage(interaction.message);
	} catch (err) {
		error(`Failed to submit reaction-role panel:`, err);
		await interaction.editReply({
			content: `Failed to create reaction-role panel: ${err.message}`,
		});
	}
}

async function addPendingRole(interaction, setupId) {
	const pending = await getPendingPanel(interaction, setupId);

	if (!pending) {
		return;
	}

	const roleId = interaction.values[0];
	const role = interaction.guild.roles.cache.get(roleId);

	if (!roleIsAssignable(interaction.guild, role, interaction.member)) {
		pending.statusMessage = `That role is no longer assignable.`;
		await showPendingPanel(interaction, setupId, pending);
		return;
	}

	if (pending.roles.some(pendingRole => pendingRole.roleId === roleId)) {
		pending.statusMessage = `That role is already added.`;
		await showPendingPanel(interaction, setupId, pending);
		return;
	}

	pending.roles.push({
		category: null,
		emoji: getDefaultEmoji(pending.roles.length % getPanelRoleLimit()),
		label: role.name,
		roleId,
	});
	pending.statusMessage = `Added ${role.name}.`;
	await showPendingPanel(interaction, setupId, pending);
}

async function undoPendingRole(interaction, setupId) {
	const pending = await getPendingPanel(interaction, setupId);

	if (!pending) {
		return;
	}

	const removed = pending.roles.pop();

	if (removed) {
		pending.statusMessage = `Removed ${removed.label}.`;
	}

	await showPendingPanel(interaction, setupId, pending);
}

async function handleSetupComponent(interaction, setupId, action) {
	if (action === `addRole`) {
		await addPendingRole(interaction, setupId);
	} else if (action === `undo`) {
		await undoPendingRole(interaction, setupId);
	} else if (action === `submit`) {
		await submitPendingPanel(interaction, setupId);
	}
}

async function handleSetupReaction(reaction, user, shouldAdd) {
	if (user.bot) {
		return false;
	}

	const message = await fetchReactionMessage(reaction);

	if (!message?.id) {
		return false;
	}

	const setup = findPendingSetupByMessage(message);

	if (!setup) {
		return false;
	}

	const { pending, setupId } = setup;

	if (user.id !== pending.userId) {
		await removeUserReaction(reaction, user);
		return true;
	}

	if (!pending.reactionEmojis) {
		pending.reactionEmojis = [];
	}

	if (!pending.setupReactionEmojis) {
		pending.setupReactionEmojis = [];
	}

	const emoji = getReactionEmojiValue(reaction);

	if (!emoji) {
		return true;
	}

	if (shouldAdd) {
		if (!await customEmojiBelongsToGuild(reaction, message)) {
			pending.statusMessage = `Custom emoji must belong to this server.`;
			await removeUserReaction(reaction, user);
			await updatePendingSetupMessage(message, setupId, pending);
			return true;
		}

		if (pending.setupReactionEmojis.length >= getSetupEmojiLimit(pending)) {
			pending.statusMessage = pending.roles.length ?
				`This panel already has one setup emoji for each role. Remove one before adding another.` :
				`Add a role before assigning emoji.`;
			await removeUserReaction(reaction, user);
			await updatePendingSetupMessage(message, setupId, pending);
			return true;
		}

		if (!pending.reactionEmojis.includes(emoji)) {
			pending.reactionEmojis.push(emoji);
			pending.setupReactionEmojis.push(emoji);
			pending.statusMessage = `Updated role emoji preview.`;
			await updatePendingSetupMessage(message, setupId, pending);
		}

		return true;
	}

	if (!pending.setupReactionEmojis.includes(emoji)) {
		return true;
	}

	const originalCount = pending.reactionEmojis.length;
	pending.reactionEmojis = pending.reactionEmojis.filter(reactionEmoji => reactionEmoji !== emoji);
	pending.setupReactionEmojis = pending.setupReactionEmojis.filter(reactionEmoji => reactionEmoji !== emoji);

	if (pending.reactionEmojis.length !== originalCount) {
		pending.statusMessage = `Updated role emoji preview.`;
		await updatePendingSetupMessage(message, setupId, pending);
	}

	return true;
}

async function sendErrorResponse(interaction, content) {
	if (interaction.deferred) {
		await interaction.editReply(content);
		return;
	}

	if (interaction.replied) {
		await interaction.followUp({
			content,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.reply({
		content,
		flags: MessageFlags.Ephemeral,
	});
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`reaction`)
		.setDescription(`Reaction role options.`)
		.addSubcommandGroup(group =>
			group
				.setName(`roles`)
				.setDescription(`Manage reaction role panels.`)
				.addSubcommand(subcommand =>
					subcommand
						.setName(`add`)
						.setDescription(`Create a reaction-role panel.`)
						.addChannelOption(option =>
							option
								.setName(`channel`)
								.setDescription(`Channel to post the panel in.`)
								.setRequired(true)
								.addChannelTypes(...textChannelTypes),
						)
						.addStringOption(option =>
							option
								.setName(`title`)
								.setDescription(`Embed title.`)
								.setRequired(true),
						)
						.addStringOption(option =>
							option
								.setName(`message`)
								.setDescription(`Optional text shown above the role list.`),
						),
				),
		)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild),

	help: {
		category: `management`,
		permissions: [
			PermissionFlagsBits.ManageGuild,
			PermissionFlagsBits.ManageRoles,
		],
		entries: [
			{
				command: `/reaction roles add`,
				description: `create reaction-role panels.`,
			},
		],
	},

	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();

		try {
			if (subcommand === `add`) {
				await startAdd(interaction);
			}
		} catch (err) {
			error(`Failed to execute reaction roles ${subcommand}:`, err);
			await sendErrorResponse(interaction, `Failed to execute reaction roles ${subcommand}: ${err.message}`);
		}
	},

	async handleComponent(interaction) {
		const [, scope, id, action] = interaction.customId.split(`:`);

		try {
			await handleSetupComponent(interaction, scope, id, action);
		} catch (err) {
			error(`Failed to handle reaction-role component:`, err);

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: `Failed to handle reaction-role interaction.`, flags: MessageFlags.Ephemeral });
			} else {
				await interaction.reply({ content: `Failed to handle reaction-role interaction.`, flags: MessageFlags.Ephemeral });
			}
		}
	},

	handleSetupReaction,

	startEditFromContext(interaction, panel) {
		return startEdit(interaction, panel);
	},

	async createFromContext(interaction, pending) {
		try {
			const result = await createSubmittedPanels(interaction, pending);
			const status = pending.statusMessage ? `\n${pending.statusMessage}` : ``;

			await interaction.editReply({
				content: `Created ${result.count} reaction-role message(s) in <#${result.channel.id}>.${status}`,
			});
		} catch (err) {
			error(`Failed to create reaction-role panel from context menu:`, err);
			await interaction.editReply({
				content: `Failed to create reaction-role panel: ${err.message}`,
			});
		}
	},
};
