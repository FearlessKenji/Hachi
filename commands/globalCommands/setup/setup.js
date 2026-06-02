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
const { writeLog } = require(`../../../utils/writeLog.js`);

const textChannelTypes = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
];

async function getServerSettings(guildId) {
	await Servers.upsert({ guildId });
	return Servers.findOne({ where: { guildId }, raw: true });
}

function formatChannel(id) {
	return id ? `<#${id}>` : `Not Set`;
}

function formatRole(id) {
	return id ? `<@&${id}>` : `Not Set`;
}

function buildHomeContent(server) {
	return `## Stream Notification Setup
### When you go live
- Twitch Role: ${formatRole(server.selfTwitchRoleId)}
- Twitch Channel: ${formatChannel(server.selfTwitchChannelId)}
- Kick Role: ${formatRole(server.selfKickRoleId)}
- Kick Channel: ${formatChannel(server.selfKickChannelId)}

### When someone you know goes live
- Role: ${formatRole(server.affiliateRoleId)}
- Channel: ${formatChannel(server.affiliateChannelId)}`;
}

function buildHomeComponents() {
	return [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`setup:self`)
				.setLabel(`My Stream`)
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId(`setup:affiliate`)
				.setLabel(`Affiliate Streams`)
				.setStyle(ButtonStyle.Secondary),
		),
	];
}

function buildSelfComponents() {
	return [
		new ActionRowBuilder().addComponents(
			new ChannelSelectMenuBuilder()
				.setCustomId(`setup:self:twitchChannel`)
				.setPlaceholder(`Twitch notification channel`)
				.setChannelTypes(textChannelTypes),
		),
		new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder()
				.setCustomId(`setup:self:twitchRole`)
				.setPlaceholder(`Twitch notification role`),
		),
		new ActionRowBuilder().addComponents(
			new ChannelSelectMenuBuilder()
				.setCustomId(`setup:self:kickChannel`)
				.setPlaceholder(`Kick notification channel`)
				.setChannelTypes(textChannelTypes),
		),
		new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder()
				.setCustomId(`setup:self:kickRole`)
				.setPlaceholder(`Kick notification role`),
		),
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`setup:clearSelf`)
				.setLabel(`Clear My Stream Settings`)
				.setStyle(ButtonStyle.Danger),
			new ButtonBuilder()
				.setCustomId(`setup:home`)
				.setLabel(`Back`)
				.setStyle(ButtonStyle.Secondary),
		),
	];
}

function buildAffiliateComponents() {
	return [
		new ActionRowBuilder().addComponents(
			new ChannelSelectMenuBuilder()
				.setCustomId(`setup:affiliate:channel`)
				.setPlaceholder(`Affiliate notification channel`)
				.setChannelTypes(textChannelTypes),
		),
		new ActionRowBuilder().addComponents(
			new RoleSelectMenuBuilder()
				.setCustomId(`setup:affiliate:role`)
				.setPlaceholder(`Affiliate notification role`),
		),
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`setup:clearAffiliate`)
				.setLabel(`Clear Affiliate Settings`)
				.setStyle(ButtonStyle.Danger),
			new ButtonBuilder()
				.setCustomId(`setup:home`)
				.setLabel(`Back`)
				.setStyle(ButtonStyle.Secondary),
		),
	];
}

function buildSelfContent(server) {
	return `## My Stream Settings
- Twitch Role: ${formatRole(server.selfTwitchRoleId)}
- Twitch Channel: ${formatChannel(server.selfTwitchChannelId)}
- Kick Role: ${formatRole(server.selfKickRoleId)}
- Kick Channel: ${formatChannel(server.selfKickChannelId)}`;
}

function buildAffiliateContent(server) {
	return `## Affiliate Stream Settings
- Role: ${formatRole(server.affiliateRoleId)}
- Channel: ${formatChannel(server.affiliateChannelId)}`;
}

async function updatePanel(interaction, content, components) {
	await interaction.update({
		content,
		components,
	});
}

async function showHome(interaction) {
	const server = await getServerSettings(interaction.guild.id);
	await updatePanel(interaction, buildHomeContent(server), buildHomeComponents());
}

async function showSelf(interaction) {
	const server = await getServerSettings(interaction.guild.id);
	await updatePanel(interaction, buildSelfContent(server), buildSelfComponents());
}

async function showAffiliate(interaction) {
	const server = await getServerSettings(interaction.guild.id);
	await updatePanel(interaction, buildAffiliateContent(server), buildAffiliateComponents());
}

async function updateSetting(interaction, settings) {
	await Servers.update(settings, { where: { guildId: interaction.guild.id } });
}

async function handleButton(interaction, action) {
	if (action === `home`) {
		await showHome(interaction);
	} else if (action === `self`) {
		await showSelf(interaction);
	} else if (action === `affiliate`) {
		await showAffiliate(interaction);
	} else if (action === `clearSelf`) {
		await updateSetting(interaction, {
			selfTwitchChannelId: null,
			selfKickChannelId: null,
			selfTwitchRoleId: null,
			selfKickRoleId: null,
		});
		await showSelf(interaction);
	} else if (action === `clearAffiliate`) {
		await updateSetting(interaction, {
			affiliateChannelId: null,
			affiliateRoleId: null,
		});
		await showAffiliate(interaction);
	}
}

async function handleSelect(interaction, group, field) {
	const selectedId = interaction.values[0] || null;

	if (group === `self`) {
		const settings = {
			twitchChannel: { selfTwitchChannelId: selectedId },
			twitchRole: { selfTwitchRoleId: selectedId },
			kickChannel: { selfKickChannelId: selectedId },
			kickRole: { selfKickRoleId: selectedId },
		};

		await updateSetting(interaction, settings[field]);
		await showSelf(interaction);
	} else if (group === `affiliate`) {
		const settings = {
			channel: { affiliateChannelId: selectedId },
			role: { affiliateRoleId: selectedId },
		};

		await updateSetting(interaction, settings[field]);
		await showAffiliate(interaction);
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
			const server = await getServerSettings(interaction.guild.id);

			await interaction.reply({
				content: buildHomeContent(server),
				components: buildHomeComponents(),
				flags: MessageFlags.Ephemeral,
			});
		} catch (error) {
			console.error(writeLog(`Failed to open setup panel:`, error));
			await interaction.reply({ content: `Failed to open setup panel.`, flags: MessageFlags.Ephemeral });
		}
	},

	async handleComponent(interaction) {
		const [, group, field] = interaction.customId.split(`:`);

		try {
			if (interaction.isButton()) {
				await handleButton(interaction, group);
			} else {
				await handleSelect(interaction, group, field);
			}
		} catch (error) {
			console.error(writeLog(`Failed to update setup settings:`, error));

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: `Failed to update setup settings.`, flags: MessageFlags.Ephemeral });
			} else {
				await interaction.reply({ content: `Failed to update setup settings.`, flags: MessageFlags.Ephemeral });
			}
		}
	},
};
