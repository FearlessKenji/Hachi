// /stream command group.
//
// Administrators use this to configure Twitch/Kick notification channels, roles,
// and streamer entries. The command owns a multi-step component UI before saving
// final settings to the Channels/Servers tables.
const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelSelectMenuBuilder,
	ChannelType,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	RoleSelectMenuBuilder,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
} = require(`discord.js`);

const { Servers, Channels } = require(`../../../database/dbObjects.js`);
const { error: logError } = require(`../../../utils/writeLog.js`);

// pendingAdds tracks the short-lived /stream add wizard. pendingStreamSetups
// tracks the broader notification settings wizard. Both are intentionally
// process-local because Discord component setup flows are temporary UI state.
const pendingAdds = new Map();
const pendingStreamSetups = new Map();
const textChannelTypes = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
];

function formatYesNo(value) {
	if (value === null) {
		return `Not Set`;
	}

	return value ? `Yes` : `No`;
}

function formatDiscord(value) {
	return value ? `<${value}>` : `Not provided`;
}

function formatChannel(id) {
	return id ? `<#${id}>` : `Not set`;
}

function formatRole(id) {
	return id ? `<@&${id}>` : `Not set`;
}

async function getStreamSettings(guildId) {
	const server = await Servers.findOne({
		raw: true,
		where: { guildId },
	});

	return {
		guildId,
		selfTwitchChannelId: server?.selfTwitchChannelId || null,
		selfKickChannelId: server?.selfKickChannelId || null,
		affiliateChannelId: server?.affiliateChannelId || null,
		selfTwitchRoleId: server?.selfTwitchRoleId || null,
		selfKickRoleId: server?.selfKickRoleId || null,
		affiliateRoleId: server?.affiliateRoleId || null,
	};
}

// Every component customId includes the setup ID. This guard prevents a user from
// interacting with another user's stale setup panel or a panel from another guild.
async function getPendingStreamSetup(interaction, setupId) {
	const pendingSetup = pendingStreamSetups.get(setupId);

	if (!pendingSetup || pendingSetup.userId !== interaction.user.id || pendingSetup.guildId !== interaction.guild.id) {
		await interaction.update({
			content: `This stream setup request is no longer available. Run \`/stream setup\` again.`,
			components: [],
		});
		return null;
	}

	return pendingSetup;
}

// This content is intentionally plain text rather than an embed so it edits
// quickly during the multi-select wizard and stays readable on mobile Discord.
function buildAddContent(pendingAdd) {
	const submitMessage = pendingAdd.needsSelections ? `\n### Select every option before submitting.` : ``;
	const title = pendingAdd.isEditing ?
		`## Edit Stream` :
		`## Add Stream`;

	return `${title}
- Name: **${pendingAdd.channelName}**
- Discord: ${formatDiscord(pendingAdd.discordUrl)}
- Twitch Notifications: ${formatYesNo(pendingAdd.twitchNotif)}
- Kick Notifications: ${formatYesNo(pendingAdd.kickNotif)}
- Your Stream: ${formatYesNo(pendingAdd.isSelf)}${submitMessage}`;
}

function buildStreamSetupHomeContent(settings) {
	const status = settings.statusMessage ? `\n### ${settings.statusMessage}` : ``;

	return `## Stream Notification Setup
### When you go live
- Twitch Role: ${formatRole(settings.selfTwitchRoleId)}
- Twitch Channel: ${formatChannel(settings.selfTwitchChannelId)}
- Kick Role: ${formatRole(settings.selfKickRoleId)}
- Kick Channel: ${formatChannel(settings.selfKickChannelId)}

### When someone you know goes live
- Role: ${formatRole(settings.affiliateRoleId)}
- Channel: ${formatChannel(settings.affiliateChannelId)}${status}`;
}

function buildSelfContent(settings) {
	return `## My Notification Settings
- Twitch Role: ${formatRole(settings.selfTwitchRoleId)}
- Twitch Channel: ${formatChannel(settings.selfTwitchChannelId)}
- Kick Role: ${formatRole(settings.selfKickRoleId)}
- Kick Channel: ${formatChannel(settings.selfKickChannelId)}`;
}

function buildAffiliateContent(settings) {
	return `## Affiliate Notification Settings
- Role: ${formatRole(settings.affiliateRoleId)}
- Channel: ${formatChannel(settings.affiliateChannelId)}`;
}

function buildBackToSetupButton(parentSetupId) {
	if (!parentSetupId) {
		return null;
	}

	return new ButtonBuilder()
		.setCustomId(`setup:${parentSetupId}:home`)
		.setLabel(`Back to Setup`)
		.setStyle(ButtonStyle.Secondary);
}

function buildStreamHomeButtons(setupId, parentSetupId = null) {
	const buttons = [
		new ButtonBuilder()
			.setCustomId(`stream:${setupId}:setup:self`)
			.setLabel(`My Stream`)
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder()
			.setCustomId(`stream:${setupId}:setup:affiliate`)
			.setLabel(`Affiliate Streams`)
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(`stream:${setupId}:setup:submit`)
			.setLabel(`Submit`)
			.setStyle(ButtonStyle.Success),
	];
	const backToSetupButton = buildBackToSetupButton(parentSetupId);

	if (backToSetupButton) {
		buttons.push(backToSetupButton);
	}

	return [
		new ActionRowBuilder().addComponents(buttons),
	];
}

function buildSelfComponents(setupId, parentSetupId = null) {
	const buttons = [
		new ButtonBuilder()
			.setCustomId(`stream:${setupId}:setup:clearSelf`)
			.setLabel(`Clear My Stream Settings`)
			.setStyle(ButtonStyle.Danger),
		new ButtonBuilder()
			.setCustomId(`stream:${setupId}:setup:home`)
			.setLabel(`Back`)
			.setStyle(ButtonStyle.Secondary),
	];
	const backToSetupButton = buildBackToSetupButton(parentSetupId);

	if (backToSetupButton) {
		buttons.push(backToSetupButton);
	}

	return [
		new ActionRowBuilder().addComponents(
			new ChannelSelectMenuBuilder()
				.setCustomId(`stream:${setupId}:setup:self:twitchChannel`)
				.setPlaceholder(`Twitch notification channel`)
				.setChannelTypes(textChannelTypes),
		),
		new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder()
				.setCustomId(`stream:${setupId}:setup:self:twitchRole`)
				.setPlaceholder(`Twitch notification role`),
		),
		new ActionRowBuilder().addComponents(
			new ChannelSelectMenuBuilder()
				.setCustomId(`stream:${setupId}:setup:self:kickChannel`)
				.setPlaceholder(`Kick notification channel`)
				.setChannelTypes(textChannelTypes),
		),
		new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder()
				.setCustomId(`stream:${setupId}:setup:self:kickRole`)
				.setPlaceholder(`Kick notification role`),
		),
		new ActionRowBuilder().addComponents(buttons),
	];
}

function buildAffiliateComponents(setupId, parentSetupId = null) {
	const buttons = [
		new ButtonBuilder()
			.setCustomId(`stream:${setupId}:setup:clearAffiliate`)
			.setLabel(`Clear Affiliate Settings`)
			.setStyle(ButtonStyle.Danger),
		new ButtonBuilder()
			.setCustomId(`stream:${setupId}:setup:home`)
			.setLabel(`Back`)
			.setStyle(ButtonStyle.Secondary),
	];
	const backToSetupButton = buildBackToSetupButton(parentSetupId);

	if (backToSetupButton) {
		buttons.push(backToSetupButton);
	}

	return [
		new ActionRowBuilder().addComponents(
			new ChannelSelectMenuBuilder()
				.setCustomId(`stream:${setupId}:setup:affiliate:channel`)
				.setPlaceholder(`Affiliate notification channel`)
				.setChannelTypes(textChannelTypes),
		),
		new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder()
				.setCustomId(`stream:${setupId}:setup:affiliate:role`)
				.setPlaceholder(`Affiliate notification role`),
		),
		new ActionRowBuilder().addComponents(buttons),
	];
}

async function updateStreamSetup(interaction, content, components) {
	await interaction.update({
		content,
		components,
	});
}

async function showStreamHome(interaction, setupId, pendingSetup) {
	await updateStreamSetup(
		interaction,
		buildStreamSetupHomeContent(pendingSetup),
		buildStreamHomeButtons(setupId, pendingSetup.parentSetupId),
	);
}

async function showStreamSelf(interaction, setupId, pendingSetup) {
	await updateStreamSetup(
		interaction,
		buildSelfContent(pendingSetup),
		buildSelfComponents(setupId, pendingSetup.parentSetupId),
	);
}

async function showStreamAffiliate(interaction, setupId, pendingSetup) {
	await updateStreamSetup(
		interaction,
		buildAffiliateContent(pendingSetup),
		buildAffiliateComponents(setupId, pendingSetup.parentSetupId),
	);
}

async function submitStreamSetup(interaction, setupId, pendingSetup) {
	await Servers.upsert({
		guildId: pendingSetup.guildId,
		selfTwitchChannelId: pendingSetup.selfTwitchChannelId,
		selfKickChannelId: pendingSetup.selfKickChannelId,
		affiliateChannelId: pendingSetup.affiliateChannelId,
		selfTwitchRoleId: pendingSetup.selfTwitchRoleId,
		selfKickRoleId: pendingSetup.selfKickRoleId,
		affiliateRoleId: pendingSetup.affiliateRoleId,
	});

	pendingStreamSetups.delete(setupId);

	await updateStreamSetup(
		interaction,
		`${buildStreamSetupHomeContent(pendingSetup)}
### Settings saved.
- Use \`/stream add\` and \`/stream remove\` to manage streamers.`,
		[],
	);
}

async function handleStreamSetupButton(interaction, setupId, pendingSetup, action) {
	if (action === `home`) {
		await showStreamHome(interaction, setupId, pendingSetup);
	} else if (action === `self`) {
		await showStreamSelf(interaction, setupId, pendingSetup);
	} else if (action === `affiliate`) {
		await showStreamAffiliate(interaction, setupId, pendingSetup);
	} else if (action === `submit`) {
		await submitStreamSetup(interaction, setupId, pendingSetup);
	} else if (action === `clearSelf`) {
		Object.assign(pendingSetup, {
			selfTwitchChannelId: null,
			selfKickChannelId: null,
			selfTwitchRoleId: null,
			selfKickRoleId: null,
		});
		await showStreamSelf(interaction, setupId, pendingSetup);
	} else if (action === `clearAffiliate`) {
		Object.assign(pendingSetup, {
			affiliateChannelId: null,
			affiliateRoleId: null,
		});
		await showStreamAffiliate(interaction, setupId, pendingSetup);
	}
}

async function handleStreamSetupSelect(interaction, setupId, pendingSetup, group, field) {
	const selectedId = interaction.values[0] || null;

	if (group === `self`) {
		const settings = {
			twitchChannel: { selfTwitchChannelId: selectedId },
			twitchRole: { selfTwitchRoleId: selectedId },
			kickChannel: { selfKickChannelId: selectedId },
			kickRole: { selfKickRoleId: selectedId },
		};

		Object.assign(pendingSetup, settings[field]);
		await showStreamSelf(interaction, setupId, pendingSetup);
	} else if (group === `affiliate`) {
		const settings = {
			channel: { affiliateChannelId: selectedId },
			role: { affiliateRoleId: selectedId },
		};

		Object.assign(pendingSetup, settings[field]);
		await showStreamAffiliate(interaction, setupId, pendingSetup);
	}
}

async function handleStreamSetupComponent(interaction, setupId, action, field) {
	const pendingSetup = await getPendingStreamSetup(interaction, setupId);

	if (!pendingSetup) {
		return;
	}

	if (interaction.isButton()) {
		await handleStreamSetupButton(interaction, setupId, pendingSetup, action);
		return;
	}

	await handleStreamSetupSelect(interaction, setupId, pendingSetup, action, field);
}

async function openSetupPanel(interaction, { parentSetupId = null, update = false } = {}) {
	const setupId = interaction.id;
	const settings = await getStreamSettings(interaction.guild.id);
	const pendingSetup = {
		...settings,
		parentSetupId,
		userId: interaction.user.id,
	};

	pendingStreamSetups.set(setupId, pendingSetup);

	const payload = {
		content: buildStreamSetupHomeContent(pendingSetup),
		components: buildStreamHomeButtons(setupId, pendingSetup.parentSetupId),
	};

	if (update) {
		await interaction.update({
			...payload,
			embeds: [],
		});
		return;
	}

	await interaction.reply({
		...payload,
		flags: MessageFlags.Ephemeral,
	});
}

function buildCompleteContent(pendingAdd) {
	return `${buildAddContent(pendingAdd)}
### Stream saved.`;
}

function buildYesNoComponents(customId, placeholder) {
	return new ActionRowBuilder().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(customId)
			.setPlaceholder(placeholder)
			.addOptions(
				new StringSelectMenuOptionBuilder()
					.setLabel(`Yes`)
					.setValue(`yes`),
				new StringSelectMenuOptionBuilder()
					.setLabel(`No`)
					.setValue(`no`),
			),
	);
}

function buildAddComponents(addId) {
	return [
		buildYesNoComponents(`stream:${addId}:setting:twitch`, `Post Twitch streams?`),
		buildYesNoComponents(`stream:${addId}:setting:kick`, `Post Kick streams?`),
		buildYesNoComponents(`stream:${addId}:setting:self`, `Is this your stream?`),
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`stream:${addId}:submit`)
				.setLabel(`Submit`)
				.setStyle(ButtonStyle.Success),
		),
	];
}

function buildPendingAdd(interaction) {
	return {
		channelName: interaction.options.getString(`name`).toLowerCase().trim(),
		discordUrl: interaction.options.getString(`discord`) || null,
		guildId: interaction.guild.id,
		isSelf: null,
		kickNotif: null,
		needsSelections: false,
		twitchNotif: null,
		userId: interaction.user.id,
	};
}

async function getPendingAdd(interaction, addId) {
	const pendingAdd = pendingAdds.get(addId);
	if (!pendingAdd || pendingAdd.userId !== interaction.user.id || pendingAdd.guildId !== interaction.guild.id) {
		await interaction.update({
			content: `This request has timed out. Run \`/stream add\` again.`,
			components: [],
		});
		return;
	}

	return pendingAdd;
}

async function updatePanel(interaction, pendingAdd, components) {
	await interaction.update({
		content: buildAddContent(pendingAdd),
		components,
	});
}

async function showAdd(interaction, addId, pendingAdd) {
	await updatePanel(
		interaction,
		pendingAdd,
		buildAddComponents(addId),
	);
}

async function showComplete(interaction, pendingAdd) {
	await interaction.update({
		content: buildCompleteContent(pendingAdd),
		components: [],
	});
}

async function savePendingAdd(interaction, addId, pendingAdd) {
	await Servers.upsert({ guildId: pendingAdd.guildId });
	await Channels.upsert({
		channelName: pendingAdd.channelName,
		discordUrl: pendingAdd.discordUrl,
		guildId: pendingAdd.guildId,
		isSelf: pendingAdd.isSelf,
		twitchNotif: pendingAdd.twitchNotif,
		kickNotif: pendingAdd.kickNotif,
	});

	pendingAdds.delete(addId);
	await showComplete(interaction, pendingAdd);
}

async function startAdd(interaction) {

	const channelName = interaction.options.getString(`name`).toLowerCase().trim();
	const existingChannel = await Channels.findOne({
		where: {
			channelName,
			guildId: interaction.guild.id,
		},
		raw: true,
	});

	const addId = interaction.id;
	const pendingAdd = existingChannel ?
		{
			...existingChannel,
			userId: interaction.user.id,
			guildId: interaction.guild.id,
			needsSelections: false,
			isEditing: true,
		} :
		{
			...buildPendingAdd(interaction),
			isEditing: false,
		};

	pendingAdds.set(addId, pendingAdd);

	await interaction.reply({
		content: buildAddContent(pendingAdd),
		components: buildAddComponents(addId),
		flags: MessageFlags.Ephemeral,
	});
}

async function removeChannel(interaction) {
	const channelName = interaction.options.getString(`name`).toLowerCase().trim();
	const guildId = interaction.guild.id;

	const removed = await Channels.destroy({
		where: { channelName, guildId },
	});

	if (!removed) {
		await interaction.reply({
			content: `Channel **${channelName}** not found in database.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.reply({
		content: `Removed **${channelName}** successfully.`,
		flags: MessageFlags.Ephemeral,
	});
}

function buildChannelList(channels) {
	return channels.map(chan =>
		`- **${chan.channelName}** ${chan.isSelf ? `(self)` : `(affiliate)`} ${chan.twitchNotif ? `(Twitch notify)` : ``} ${chan.kickNotif ? `(Kick notify)` : ``}`,
	);
}

async function listChannels(interaction) {
	const channels = await Channels.findAll({
		where: { guildId: interaction.guild.id },
		raw: true,
	});

	if (!channels.length) {
		await interaction.reply({
			content: `No stream channels configured.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.reply({
		content: `**Stream Channels:**\n${buildChannelList(channels).join(`\n`)}`,
		flags: MessageFlags.Ephemeral,
	});
}

async function handleAddSelection(interaction, step, addId) {
	const pendingAdd = await getPendingAdd(interaction, addId);

	if (!pendingAdd) {
		return;
	}

	if (step === `twitch`) {
		pendingAdd.twitchNotif = interaction.values[0] === `yes`;
	} else if (step === `kick`) {
		pendingAdd.kickNotif = interaction.values[0] === `yes`;
	} else if (step === `self`) {
		pendingAdd.isSelf = interaction.values[0] === `yes`;
	}

	pendingAdd.needsSelections = false;
	await showAdd(interaction, addId, pendingAdd);
}

async function handleSubmit(interaction, addId) {
	const pendingAdd = await getPendingAdd(interaction, addId);

	if (!pendingAdd) {
		return;
	}

	if (pendingAdd.twitchNotif === null || pendingAdd.kickNotif === null || pendingAdd.isSelf === null) {
		pendingAdd.needsSelections = true;
		await showAdd(interaction, addId, pendingAdd);
		return;
	}

	await savePendingAdd(interaction, addId, pendingAdd);
}

async function handleAddComponent(interaction, addId, action, field) {
	if (action === `setting`) {
		await handleAddSelection(interaction, field, addId);
	} else if (action === `submit`) {
		await handleSubmit(interaction, addId);
	}
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`stream`)
		.setDescription(`Stream options.`)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`setup`)
				.setDescription(`Configure stream notification channels and roles.`),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`add`)
				.setDescription(`Add or edit a channel. Tab to add optional Discord invite link.`)
				.addStringOption(option =>
					option.setName(`name`)
						.setDescription(`Username.`)
						.setRequired(true),
				)
				.addStringOption(option =>
					option.setName(`discord`)
						.setDescription(`Discord invite URL for the channel. Shows in embed.`),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`remove`)
				.setDescription(`Remove a channel from the list.`)
				.addStringOption(option =>
					option.setName(`name`)
						.setDescription(`Username to remove.`)
						.setRequired(true),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`list`)
				.setDescription(`List all channels for this server and their configurations.`),
		)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild),

	help: {
		category: `streams`,
		permissions: [PermissionFlagsBits.ManageGuild],
		entries: [
			{
				command: `/stream setup`,
				description: `configure Twitch/Kick notification channels and roles.`,
			},
			{
				command: `/stream add/remove/list`,
				description: `manage tracked Twitch/Kick streamers.`,
			},
		],
	},

	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();

		try {
			if (subcommand === `setup`) {
				await openSetupPanel(interaction);
			} else if (subcommand === `add`) {
				await startAdd(interaction);
			} else if (subcommand === `remove`) {
				await removeChannel(interaction);
			} else if (subcommand === `list`) {
				await listChannels(interaction);
			}
		} catch (err) {
			logError(`Failed to execute command ${subcommand}:`, err);
			await interaction.reply({
				content: `Failed to execute command ${subcommand}.`,
				flags: MessageFlags.Ephemeral,
			});
		}
	},

	async handleComponent(interaction) {
		const [, addId, action, field, subfield] = interaction.customId.split(`:`);

		try {
			if (action === `setup`) {
				await handleStreamSetupComponent(interaction, addId, field, subfield);
			} else {
				await handleAddComponent(interaction, addId, action, field);
			}
		} catch (err) {
			logError(`Failed to add stream settings:`, err);

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: `Failed to add stream settings.`, flags: MessageFlags.Ephemeral });
			} else {
				await interaction.reply({ content: `Failed to add stream settings.`, flags: MessageFlags.Ephemeral });
			}
		}
	},

	openSetupPanel,
};
