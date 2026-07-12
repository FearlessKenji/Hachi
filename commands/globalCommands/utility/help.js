// /help command.
//
// Builds a permission-aware help catalog from command metadata. Moderators can
// also post public help panels with a category picker.
const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	InteractionContextType,
	MessageFlags,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
} = require(`discord.js`);
const {
	buildHelpCatalog,
	canPostPublicHelp,
	filterCatalogForMember,
	formatCategoryValue,
	getCatalogByIds,
} = require(`../../../utils/helpCatalog.js`);

const HELP_COLOR = 0xffb020;
const EMBED_FIELD_LIMIT = 25;
const EMPTY_FIELD = `\u200b`;
const pendingPublicHelpPanels = new Map();

function buildHelpEmbed(categories, options = {}) {
	const embed = new EmbedBuilder()
		.setColor(HELP_COLOR)
		.setTitle(`Hachi Help`)
		.setDescription(`A quick overview of Hachi's commands and server tools.`);

	if (!categories.length) {
		embed.addFields({
			name: `No Commands Available`,
			value: `No help categories are available for this view.`,
		});
	} else {
		const canAddSpacers = categories.length * 2 - 1 <= EMBED_FIELD_LIMIT;

		for (const [index, category] of categories.entries()) {
			embed.addFields({
				name: category.name,
				value: formatCategoryValue(category).slice(0, 1024),
			});

			if (canAddSpacers && index < categories.length - 1) {
				embed.addFields({
					name: EMPTY_FIELD,
					value: EMPTY_FIELD,
				});
			}
		}
	}

	if (options.hiddenCount > 0) {
		embed.setFooter({ text: `Some commands may be hidden because you do not have permission to use them.` });
	} else if (options.public) {
		embed.setFooter({ text: `Use /help for a private command list.` });
	}

	return embed;
}

function countEntries(categories) {
	return categories.reduce((total, category) => total + category.entries.length, 0);
}

function buildPickerContent(catalog, selectedIds) {
	const selectedText = selectedIds.length ?
		getCatalogByIds(catalog, selectedIds).map(category => category.name).join(`, `) :
		`None selected`;

	return `## Public Help
Select the categories Hachi should post publicly.

Selected: ${selectedText}`;
}

function buildPickerComponents(panelId, catalog, selectedIds) {
	const selected = new Set(selectedIds);
	const options = catalog.map(category =>
		new StringSelectMenuOptionBuilder()
			.setLabel(category.name)
			.setDescription(category.description)
			.setValue(category.id)
			.setDefault(selected.has(category.id)),
	);

	return [
		new ActionRowBuilder().addComponents(
			new StringSelectMenuBuilder()
				.setCustomId(`help:${panelId}:categories`)
				.setPlaceholder(`Help categories`)
				.setMinValues(1)
				.setMaxValues(catalog.length)
				.addOptions(options),
		),
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`help:${panelId}:post`)
				.setLabel(`Post Help`)
				.setStyle(ButtonStyle.Primary)
				.setDisabled(!selectedIds.length),
		),
	];
}

async function getPendingPanel(interaction, panelId) {
	const pendingPanel = pendingPublicHelpPanels.get(panelId);

	if (!pendingPanel || pendingPanel.userId !== interaction.user.id || pendingPanel.guildId !== interaction.guild.id) {
		await interaction.update({
			content: `This help panel is no longer available. Run \`/help public:true\` again.`,
			components: [],
			embeds: [],
		});
		return null;
	}

	return pendingPanel;
}

async function openPublicHelpPicker(interaction, catalog) {
	if (!canPostPublicHelp(interaction.memberPermissions)) {
		await interaction.reply({
			content: `Public help can only be posted by moderators or administrators.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const panelId = interaction.id;
	const pendingPanel = {
		catalog,
		guildId: interaction.guild.id,
		selectedIds: [],
		userId: interaction.user.id,
	};

	pendingPublicHelpPanels.set(panelId, pendingPanel);

	await interaction.reply({
		content: buildPickerContent(pendingPanel.catalog, pendingPanel.selectedIds),
		components: buildPickerComponents(panelId, pendingPanel.catalog, pendingPanel.selectedIds),
		flags: MessageFlags.Ephemeral,
	});
}

async function postPublicHelp(interaction, panelId, pendingPanel) {
	const categories = getCatalogByIds(pendingPanel.catalog, pendingPanel.selectedIds);

	if (!categories.length) {
		await interaction.update({
			content: buildPickerContent(pendingPanel.catalog, pendingPanel.selectedIds),
			components: buildPickerComponents(panelId, pendingPanel.catalog, pendingPanel.selectedIds),
		});
		return;
	}

	await interaction.channel.send({
		allowedMentions: { parse: [] },
		embeds: [buildHelpEmbed(categories, { public: true })],
	});

	pendingPublicHelpPanels.delete(panelId);

	await interaction.update({
		content: `Public help posted.`,
		components: [],
	});
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`help`)
		.setDescription(`Show Hachi's commands and capabilities.`)
		.addBooleanOption(option =>
			option
				.setName(`public`)
				.setDescription(`Moderator-only. Ask which help categories to post publicly.`),
		)
		.setContexts(InteractionContextType.Guild),

	help: {
		category: `general`,
		entries: [
			{
				command: `/help`,
				description: `show a permission-aware command list.`,
			},
		],
	},

	async execute(interaction) {
		const catalog = buildHelpCatalog(interaction.client.commands, { guildId: interaction.guildId || interaction.guild.id });
		const publicResponse = interaction.options.getBoolean(`public`) || false;

		if (publicResponse) {
			await openPublicHelpPicker(interaction, catalog);
			return;
		}

		const visibleCategories = filterCatalogForMember(catalog, interaction.memberPermissions);
		const hiddenCount = countEntries(catalog) - countEntries(visibleCategories);

		await interaction.reply({
			embeds: [buildHelpEmbed(visibleCategories, { hiddenCount })],
			flags: MessageFlags.Ephemeral,
		});
	},

	async handleComponent(interaction) {
		const [, panelId, action] = interaction.customId.split(`:`);
		const pendingPanel = await getPendingPanel(interaction, panelId);

		if (!pendingPanel) {
			return;
		}

		if (action === `categories`) {
			pendingPanel.selectedIds = interaction.values;
			await interaction.update({
				content: buildPickerContent(pendingPanel.catalog, pendingPanel.selectedIds),
				components: buildPickerComponents(panelId, pendingPanel.catalog, pendingPanel.selectedIds),
			});
		} else if (action === `post`) {
			await postPublicHelp(interaction, panelId, pendingPanel);
		}
	},
};
