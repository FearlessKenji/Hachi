const { ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelSelectMenuBuilder,
	ChannelType,
	InteractionContextType,
	MessageFlags,
	RoleSelectMenuBuilder,
	SlashCommandBuilder,
} = require(`discord.js`);
const { Servers } = require(`../../../database/dbObjects.js`);
const { info, warn, error } = require(`../../../utils/writeLog.js`);

const textChannelTypes = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
];

const pendingSetups = new Map();

async function getServerSettings(guildId) {
	const server = await Servers.findOne({
		where: { guildId },
		raw: true,
	});

	return server || {
		guildId,
		selfTwitchChannelId: null,
		selfKickChannelId: null,
		affiliateChannelId: null,
		selfTwitchRoleId: null,
		selfKickRoleId: null,
		affiliateRoleId: null,
	};
}

async function getPendingSetup(interaction, setupId) {
	const pendingSetup = pendingSetups.get(setupId);

	if (!pendingSetup || pendingSetup.userId !== interaction.user.id || pendingSetup.guildId !== interaction.guild.id) {
		await interaction.update({
			content: `This setup request is no longer available. Run \`/setup\` again.`,
			components: [],
		});
		return;
	}

	return pendingSetup;
}

function formatChannel(id) {
	return id ? `<#${id}>` : `Not Set`;
}

function formatRole(id) {
	return id ? `<@&${id}>` : `Not Set`;
}

function buildHomeContent(server) {
	return `## Notification Setup
### When you go live
- Twitch Role: ${formatRole(server.selfTwitchRoleId)}
- Twitch Channel: ${formatChannel(server.selfTwitchChannelId)}
- Kick Role: ${formatRole(server.selfKickRoleId)}
- Kick Channel: ${formatChannel(server.selfKickChannelId)}

### When someone you know goes live
- Role: ${formatRole(server.affiliateRoleId)}
- Channel: ${formatChannel(server.affiliateChannelId)}`;
}

function buildHomeComponents(setupId) {
	return [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`setup:${setupId}:self`)
				.setLabel(`My Stream`)
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId(`setup:${setupId}:affiliate`)
				.setLabel(`Affiliate Streams`)
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId(`setup:${setupId}:submit`)
				.setLabel(`Submit`)
				.setStyle(ButtonStyle.Success),
		),
	];
}

function buildSelfComponents(setupId) {
	return [
		new ActionRowBuilder().addComponents(
			new ChannelSelectMenuBuilder()
				.setCustomId(`setup:${setupId}:self:twitchChannel`)
				.setPlaceholder(`Twitch notification channel`)
				.setChannelTypes(textChannelTypes),
		),
		new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder()
				.setCustomId(`setup:${setupId}:self:twitchRole`)
				.setPlaceholder(`Twitch notification role`),
		),
		new ActionRowBuilder().addComponents(
			new ChannelSelectMenuBuilder()
				.setCustomId(`setup:${setupId}:self:kickChannel`)
				.setPlaceholder(`Kick notification channel`)
				.setChannelTypes(textChannelTypes),
		),
		new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder()
				.setCustomId(`setup:${setupId}:self:kickRole`)
				.setPlaceholder(`Kick notification role`),
		),
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`setup:${setupId}:clearSelf`)
				.setLabel(`Clear My Stream Settings`)
				.setStyle(ButtonStyle.Danger),
			new ButtonBuilder()
				.setCustomId(`setup:${setupId}:home`)
				.setLabel(`Back`)
				.setStyle(ButtonStyle.Secondary),
		),
	];
}

function buildAffiliateComponents(setupId) {
	return [
		new ActionRowBuilder().addComponents(
			new ChannelSelectMenuBuilder()
				.setCustomId(`setup:${setupId}:affiliate:channel`)
				.setPlaceholder(`Affiliate notification channel`)
				.setChannelTypes(textChannelTypes),
		),
		new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder()
				.setCustomId(`setup:${setupId}:affiliate:role`)
				.setPlaceholder(`Affiliate notification role`),
		),
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`setup:${setupId}:clearAffiliate`)
				.setLabel(`Clear Affiliate Settings`)
				.setStyle(ButtonStyle.Danger),
			new ButtonBuilder()
				.setCustomId(`setup:${setupId}:home`)
				.setLabel(`Back`)
				.setStyle(ButtonStyle.Secondary),
		),
	];
}

function buildSelfContent(server) {
	return `## My Notification Settings
- Twitch Role: ${formatRole(server.selfTwitchRoleId)}
- Twitch Channel: ${formatChannel(server.selfTwitchChannelId)}
- Kick Role: ${formatRole(server.selfKickRoleId)}
- Kick Channel: ${formatChannel(server.selfKickChannelId)}`;
}

function buildAffiliateContent(server) {
	return `## Affiliate Notification Settings
- Role: ${formatRole(server.affiliateRoleId)}
- Channel: ${formatChannel(server.affiliateChannelId)}`;
}

function buildSubmissionContent(server) {
	return `${buildHomeContent(server)}
### Settings saved.
- Please use the /stream command to add or remove streamers, including yourself.`;
}

async function updatePanel(interaction, content, components) {
	await interaction.update({
		content,
		components,
	});
}

async function showPage(interaction, setupId, pendingSetup, contentBuilder, componentBuilder) {
	await updatePanel(
		interaction,
		contentBuilder(pendingSetup),
		componentBuilder(setupId),
	);
}

async function showHome(interaction, setupId, pendingSetup) {
	await showPage(
		interaction,
		setupId,
		pendingSetup,
		buildHomeContent,
		buildHomeComponents,
	);
}

async function showSelf(interaction, setupId, pendingSetup) {
	await showPage(
		interaction,
		setupId,
		pendingSetup,
		buildSelfContent,
		buildSelfComponents,
	);
}

async function showAffiliate(interaction, setupId, pendingSetup) {
	await showPage(
		interaction,
		setupId,
		pendingSetup,
		buildAffiliateContent,
		buildAffiliateComponents,
	);
}

async function showSubmission(interaction, setupId, pendingSetup) {
	await Servers.upsert({
		guildId: pendingSetup.guildId,
		selfTwitchChannelId: pendingSetup.selfTwitchChannelId,
		selfKickChannelId: pendingSetup.selfKickChannelId,
		affiliateChannelId: pendingSetup.affiliateChannelId,
		selfTwitchRoleId: pendingSetup.selfTwitchRoleId,
		selfKickRoleId: pendingSetup.selfKickRoleId,
		affiliateRoleId: pendingSetup.affiliateRoleId,
	});

	pendingSetups.delete(setupId);

	await updatePanel(
		interaction,
		buildSubmissionContent(pendingSetup),
		[],
	);
}

function updateSetting(pendingSetup, settings) {
	Object.assign(pendingSetup, settings);
}

async function handleButton(interaction, setupId, pendingSetup, action) {
	if (action === `home`) {
		await showHome(interaction, setupId, pendingSetup);
	} else if (action === `self`) {
		await showSelf(interaction, setupId, pendingSetup);
	} else if (action === `affiliate`) {
		await showAffiliate(interaction, setupId, pendingSetup);
	} else if (action === `submit`) {
		await showSubmission(interaction, setupId, pendingSetup);
	} else if (action === `clearSelf`) {
		updateSetting(pendingSetup, {
			selfTwitchChannelId: null,
			selfKickChannelId: null,
			selfTwitchRoleId: null,
			selfKickRoleId: null,
		});
		await showSelf(interaction, setupId, pendingSetup);
	} else if (action === `clearAffiliate`) {
		updateSetting(pendingSetup, {
			affiliateChannelId: null,
			affiliateRoleId: null,
		});
		await showAffiliate(interaction, setupId, pendingSetup);
	}
}

async function handleSelect(interaction, setupId, pendingSetup, group, field) {
	const selectedId = interaction.values[0] || null;

	if (group === `self`) {
		const settings = {
			twitchChannel: { selfTwitchChannelId: selectedId },
			twitchRole: { selfTwitchRoleId: selectedId },
			kickChannel: { selfKickChannelId: selectedId },
			kickRole: { selfKickRoleId: selectedId },
		};

		updateSetting(pendingSetup, settings[field]);
		await showSelf(interaction, setupId, pendingSetup);
	} else if (group === `affiliate`) {
		const settings = {
			channel: { affiliateChannelId: selectedId },
			role: { affiliateRoleId: selectedId },
		};

		updateSetting(pendingSetup, settings[field]);
		await showAffiliate(interaction, setupId, pendingSetup);
	}
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`setup`)
		.setDescription(`Configure channel and role settings.`)
		.setDefaultMemberPermissions(0) // Restrict to admins or bot owner,
		.setContexts(InteractionContextType.Guild),

	async execute(interaction) {
		try {
			const setupId = interaction.id;
			const server = await getServerSettings(interaction.guild.id);
			const pendingSetup = {
				...server,
				userId: interaction.user.id,
			};

			pendingSetups.set(setupId, pendingSetup);

			await interaction.reply({
				content: buildHomeContent(pendingSetup),
				components: buildHomeComponents(setupId),
				flags: MessageFlags.Ephemeral,
			});
		} catch (error) {
			error(`Failed to open setup panel:`, error);
			await interaction.reply({ content: `Failed to open setup panel.`, flags: MessageFlags.Ephemeral });
		}
	},

	async handleComponent(interaction) {
		const [, setupId, group, field] = interaction.customId.split(`:`);

		try {
			const pendingSetup = await getPendingSetup(interaction, setupId);

			if (!pendingSetup) {
				return;
			}

			if (interaction.isButton()) {
				await handleButton(interaction, setupId, pendingSetup, group);
			} else {
				await handleSelect(interaction, setupId, pendingSetup, group, field);
			}
		} catch (error) {
			error(`Failed to update setup settings:`, error);

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: `Failed to update setup settings.`, flags: MessageFlags.Ephemeral });
			} else {
				await interaction.reply({ content: `Failed to update setup settings.`, flags: MessageFlags.Ephemeral });
			}
		}
	},
};
