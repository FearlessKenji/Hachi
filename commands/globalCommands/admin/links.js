// /links manages per-guild link rewriting and Discord AutoMod domain blocking.
const {
	EmbedBuilder,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require(`discord.js`);
const { LinkBlockRules, LinkConfigs, LinkFixRules } = require(`../../../database/dbObjects.js`);
const {
	expandAffiliateDomains,
	MAX_REGEX_PATTERNS,
	syncBlockRule,
} = require(`../../../utils/linkBlocking.js`);
const { normalizeDomain, RECOMMENDED_FIX_RULES } = require(`../../../utils/socialLinks.js`);

const COLOR = 0xffb020;

async function configFor(guildId) {
	const [config] = await LinkConfigs.findOrCreate({ where: { guildId } });
	return config;
}

function domainOption(option, name, description) {
	// Keep generated AutoMod regex patterns below Discord's 260-character limit.
	return option.setName(name).setDescription(description).setRequired(true).setMaxLength(180);
}

async function setEnabled(interaction, feature, enabled) {
	const config = await configFor(interaction.guild.id);
	if (feature === `block`) {
		const rules = await LinkBlockRules.findAll({ raw: true, where: { guildId: interaction.guild.id } });
		if (enabled && !rules.length) {
			throw new Error(`Add at least one blocked domain before enabling link blocking.`);
		}
		await syncBlockRule(interaction.guild, rules.map(rule => rule.domain), enabled);
	} else {
		await config.update({ fixingEnabled: enabled });
	}
	await interaction.reply({ content: `Link ${feature === `fix` ? `fixing` : `blocking`} is now **${enabled ? `enabled` : `disabled`}**.`, flags: MessageFlags.Ephemeral });
}

async function addFix(interaction) {
	const sourceDomain = normalizeDomain(interaction.options.getString(`source`, true));
	const targetDomain = normalizeDomain(interaction.options.getString(`replacement`, true));
	if (!sourceDomain || !targetDomain) {
		throw new Error(`Source and replacement must be plain domain names.`);
	}
	if (sourceDomain === targetDomain) {
		throw new Error(`Source and replacement domains must be different.`);
	}

	await LinkFixRules.upsert({ guildId: interaction.guild.id, sourceDomain, targetDomain, createdBy: interaction.user.id, createdAt: new Date() });
	const facebookWarning = sourceDomain === `facebook.com` || sourceDomain.endsWith(`.facebook.com`) ?
		`\n\n⚠️ Facebook share links may disclose the sharer's profile identity. This mapping is not considered privacy-safe.` :
		``;
	await interaction.reply({ content: `Added **${sourceDomain}** → **${targetDomain}**.${facebookWarning}`, flags: MessageFlags.Ephemeral });
}

async function removeFix(interaction) {
	const sourceDomain = normalizeDomain(interaction.options.getString(`source`, true));
	if (!sourceDomain) {
		throw new Error(`Source must be a plain domain name.`);
	}
	const removed = await LinkFixRules.destroy({ where: { guildId: interaction.guild.id, sourceDomain } });
	await interaction.reply({ content: removed ? `Removed the **${sourceDomain}** mapping.` : `No mapping exists for **${sourceDomain}**.`, flags: MessageFlags.Ephemeral });
}

async function fixStatus(interaction) {
	const config = await configFor(interaction.guild.id);
	const rules = await LinkFixRules.findAll({ order: [[`sourceDomain`, `ASC`]], raw: true, where: { guildId: interaction.guild.id } });
	const body = rules.length ?
		rules.map(rule => `• ${rule.sourceDomain} → ${rule.targetDomain}`).join(`\n`) :
		`No mappings configured. Recommended first mappings:\n${RECOMMENDED_FIX_RULES.map(rule => `• ${rule.sourceDomain} → ${rule.targetDomain}`).join(`\n`)}`;
	const embed = new EmbedBuilder()
		.setColor(COLOR)
		.setTitle(`Link Fixing`)
		.setDescription(`**${config.fixingEnabled ? `Enabled` : `Disabled`}**\n\n${body}`);
	await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function addBlock(interaction) {
	const normalized = normalizeDomain(interaction.options.getString(`domain`, true));
	const domain = normalized?.replace(/^www\./u, ``);
	if (!domain) {
		throw new Error(`Enter a plain domain name.`);
	}
	const fixRules = await LinkFixRules.findAll({ raw: true, where: { guildId: interaction.guild.id } });
	const affiliateDomains = expandAffiliateDomains(domain, fixRules);
	const existingRules = await LinkBlockRules.findAll({ raw: true, where: { guildId: interaction.guild.id } });
	const existingDomains = new Set(existingRules.map(rule => rule.domain));
	const domainsToAdd = affiliateDomains.filter(candidate => !existingDomains.has(candidate));
	if (!domainsToAdd.length) {
		return interaction.reply({ content: `**${domain}** and its known affiliates are already blocked.`, flags: MessageFlags.Ephemeral });
	}
	if (existingDomains.size + domainsToAdd.length > MAX_REGEX_PATTERNS) {
		throw new Error(`This server has reached Discord's ${MAX_REGEX_PATTERNS}-domain AutoMod limit.`);
	}
	await LinkBlockRules.bulkCreate(domainsToAdd.map(candidate => ({
		createdAt: new Date(),
		createdBy: interaction.user.id,
		domain: candidate,
		guildId: interaction.guild.id,
	})));
	const config = await configFor(interaction.guild.id);
	if (config.blockingEnabled) {
		const rules = await LinkBlockRules.findAll({ raw: true, where: { guildId: interaction.guild.id } });
		await syncBlockRule(interaction.guild, rules.map(rule => rule.domain), true);
	}
	await interaction.reply({
		content: `Blocked: ${affiliateDomains.map(candidate => `**${candidate}**`).join(`, `)}.`,
		flags: MessageFlags.Ephemeral,
	});
}

async function removeBlock(interaction) {
	const normalized = normalizeDomain(interaction.options.getString(`domain`, true));
	const domain = normalized?.replace(/^www\./u, ``);
	if (!domain) {
		throw new Error(`Enter a plain domain name.`);
	}
	const fixRules = await LinkFixRules.findAll({ raw: true, where: { guildId: interaction.guild.id } });
	const affiliateDomains = expandAffiliateDomains(domain, fixRules);
	const removed = await LinkBlockRules.destroy({
		where: { domain: affiliateDomains, guildId: interaction.guild.id },
	});
	const config = await configFor(interaction.guild.id);
	if (removed && config.blockingEnabled) {
		const rules = await LinkBlockRules.findAll({ raw: true, where: { guildId: interaction.guild.id } });
		await syncBlockRule(interaction.guild, rules.map(rule => rule.domain), true);
	}
	await interaction.reply({
		content: removed ?
			`Removed **${domain}** and its known affiliates from the blocklist.` :
			`**${domain}** and its known affiliates are not blocked.`,
		flags: MessageFlags.Ephemeral,
	});
}

async function blockStatus(interaction) {
	const config = await configFor(interaction.guild.id);
	const rules = await LinkBlockRules.findAll({ order: [[`domain`, `ASC`]], raw: true, where: { guildId: interaction.guild.id } });
	let sync = `Not created`;
	if (config.autoModRuleId) {
		try {
			await interaction.guild.autoModerationRules.fetch(config.autoModRuleId);
			sync = `Synchronized`;
		} catch {
			sync = `Needs repair`;
		}
	}
	const domains = rules.length ? rules.map(rule => `• ${rule.domain} (includes subdomains)`).join(`\n`) : `No blocked domains.`;
	const embed = new EmbedBuilder()
		.setColor(COLOR)
		.setTitle(`Link Blocking`)
		.setDescription(`**${config.blockingEnabled ? `Enabled` : `Disabled`}**\nAutoMod: ${sync}\n\n${domains}`);
	await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

function addToggleCommands(group) {
	return group
		.addSubcommand(command => command.setName(`enable`).setDescription(`Enable this link feature.`))
		.addSubcommand(command => command.setName(`disable`).setDescription(`Disable this link feature.`))
		.addSubcommand(command => command.setName(`status`).setDescription(`Show this feature's configuration and health.`));
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`links`).setDescription(`Configure link fixing and blocking.`)
		.addSubcommandGroup(group => addToggleCommands(group.setName(`fix`).setDescription(`Configure embed-friendly link replacements.`))
			.addSubcommand(command => command.setName(`add`).setDescription(`Add or replace a domain mapping.`)
				.addStringOption(option =>
					domainOption(option, `source`, `Original domain, such as instagram.com.`).setAutocomplete(true),
				)
				.addStringOption(option =>
					domainOption(option, `replacement`, `Replacement domain, such as www.kkinstagram.com.`).setAutocomplete(true),
				))
			.addSubcommand(command => command.setName(`remove`).setDescription(`Remove a domain mapping.`)
				.addStringOption(option => domainOption(option, `source`, `Original domain to remove.`))))
		.addSubcommandGroup(group => addToggleCommands(group.setName(`block`).setDescription(`Configure blocked link sources.`))
			.addSubcommand(command => command.setName(`add`).setDescription(`Add a blocked domain and its subdomains.`)
				.addStringOption(option => domainOption(option, `domain`, `Domain to block.`)))
			.addSubcommand(command => command.setName(`remove`).setDescription(`Remove a blocked domain.`)
				.addStringOption(option => domainOption(option, `domain`, `Domain to remove.`))))
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild),
	help: { category: `management`, permissions: [PermissionFlagsBits.ManageGuild], entries: [
		{ command: `/links fix`, description: `manage automatic embed-friendly domain mappings.` },
		{ command: `/links block`, description: `manage AutoMod-backed blocked link sources.` },
	] },
	async execute(interaction) {
		const group = interaction.options.getSubcommandGroup();
		const command = interaction.options.getSubcommand();
		try {
			if (command === `enable` || command === `disable`) {
				return await setEnabled(interaction, group, command === `enable`);
			}
			if (group === `fix` && command === `add`) {
				return await addFix(interaction);
			}
			if (group === `fix` && command === `remove`) {
				return await removeFix(interaction);
			}
			if (group === `fix`) {
				return await fixStatus(interaction);
			}
			if (command === `add`) {
				return await addBlock(interaction);
			}
			if (command === `remove`) {
				return await removeBlock(interaction);
			}
			return await blockStatus(interaction);
		} catch (err) {
			return interaction.reply({ content: err.message || `Unable to update links.`, flags: MessageFlags.Ephemeral });
		}
	},
};
