const {
	ActionRowBuilder,
	ChannelType,
	EmbedBuilder,
	InteractionContextType,
	MessageFlags,
	ModalBuilder,
	PermissionFlagsBits,
	SlashCommandBuilder,
	TextInputBuilder,
	TextInputStyle,
} = require(`discord.js`);
const { RulesVerificationMessages, Servers } = require(`../../../database/dbObjects.js`);
const { normalizeColorInput, supportedColorText } = require(`../../../utils/colors.js`);
const { RULES_VERIFICATION_EMOJI } = require(`../../../utils/rulesVerification.js`);
const { roleIsAssignable } = require(`../../../utils/reactionRoles.js`);
const { error } = require(`../../../utils/writeLog.js`);

const pendingRules = new Map();
const PENDING_RULES_TTL_MS = 15 * 60 * 1000;
const RULES_TITLE_INPUT_ID = `title`;
const RULES_BODY_INPUT_ID = `body`;
const RULES_VERIFICATION_COLOR = 0x57f287;
const DEFAULT_RULES_TITLE = `Server Rules`;
const DEFAULT_RULES_BODY = `Please read and understand the rules before participating.`;
const RULES_VERIFICATION_DESCRIPTION = `Once you have read and understand the rules, react with ${RULES_VERIFICATION_EMOJI} to gain access to the rest of the server.`;

function hasPermission(interaction, permission) {
	return interaction.memberPermissions?.has(permission) || false;
}

function clearPendingRules(setupId) {
	const pending = pendingRules.get(setupId);

	if (pending?.timeout) {
		clearTimeout(pending.timeout);
	}

	pendingRules.delete(setupId);
}

function trackPendingRules(setupId, pending) {
	const timeout = setTimeout(() => {
		pendingRules.delete(setupId);
	}, PENDING_RULES_TTL_MS);

	pendingRules.set(setupId, {
		...pending,
		timeout,
	});
}

function buildRulesModal(setupId) {
	const titleInput = new TextInputBuilder()
		.setCustomId(RULES_TITLE_INPUT_ID)
		.setLabel(`Rules title`)
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMaxLength(256)
		.setValue(DEFAULT_RULES_TITLE);

	const bodyInput = new TextInputBuilder()
		.setCustomId(RULES_BODY_INPUT_ID)
		.setLabel(`Rules body`)
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(true)
		.setMaxLength(4000)
		.setValue(DEFAULT_RULES_BODY);

	return new ModalBuilder()
		.setCustomId(`rules:${setupId}:post`)
		.setTitle(`Post Rules`)
		.addComponents(
			new ActionRowBuilder().addComponents(titleInput),
			new ActionRowBuilder().addComponents(bodyInput),
		);
}

function buildRulesEmbed(title, body, color) {
	return new EmbedBuilder()
		.setColor(color)
		.setTitle(title)
		.setDescription(body);
}

function buildVerificationEmbed() {
	return new EmbedBuilder()
		.setColor(RULES_VERIFICATION_COLOR)
		.setTitle(`Server Access`)
		.setDescription(RULES_VERIFICATION_DESCRIPTION);
}

function formatHexColor(color) {
	return `#${color.toString(16).padStart(6, `0`)}`;
}

function getVerificationRoleError(interaction, role) {
	if (!role) {
		return null;
	}

	if (!hasPermission(interaction, PermissionFlagsBits.ManageRoles)) {
		return `You need Manage Roles to configure rules verification.`;
	}

	if (!roleIsAssignable(interaction.guild, role, interaction.member)) {
		return `I cannot assign ${role}. Make sure the bot has Manage Roles and that the selected role is below both the bot and you.`;
	}

	return null;
}

async function startPost(interaction) {
	if (!interaction.inGuild()) {
		await interaction.reply({
			content: `Rules can only be posted in a server.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (!hasPermission(interaction, PermissionFlagsBits.ManageGuild)) {
		await interaction.reply({
			content: `You need Manage Server to post rules.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const channel = interaction.options.getChannel(`channel`);
	const colorResult = normalizeColorInput(interaction.options.getString(`color`));
	const verificationRole = interaction.options.getRole(`verification`);

	if (!colorResult) {
		await interaction.reply({
			content: `I do not recognize that color. ${supportedColorText()}`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const verificationRoleError = getVerificationRoleError(interaction, verificationRole);

	if (verificationRoleError) {
		await interaction.reply({
			content: verificationRoleError,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const setupId = interaction.id;

	trackPendingRules(setupId, {
		channelId: channel.id,
		color: colorResult.color,
		guildId: interaction.guild.id,
		userId: interaction.user.id,
		verificationRoleId: verificationRole?.id || null,
	});

	await interaction.showModal(buildRulesModal(setupId));
}

async function getPendingRules(interaction, setupId) {
	const pending = pendingRules.get(setupId);

	if (!pending) {
		await interaction.reply({
			content: `This rules setup expired. Run \`/rules\` again.`,
			flags: MessageFlags.Ephemeral,
		});
		return null;
	}

	if (pending.userId !== interaction.user.id || pending.guildId !== interaction.guild.id) {
		await interaction.reply({
			content: `Only the admin who started this rules setup can submit it.`,
			flags: MessageFlags.Ephemeral,
		});
		return null;
	}

	return pending;
}

async function getTargetChannel(interaction, pending) {
	const channel = await interaction.guild.channels.fetch(pending.channelId).catch(() => null);

	if (!channel?.send) {
		throw new Error(`I cannot send messages in the selected channel.`);
	}

	return channel;
}

async function getVerificationRole(interaction, pending) {
	if (!pending.verificationRoleId) {
		return null;
	}

	await interaction.guild.roles.fetch().catch(() => null);
	await interaction.guild.members.fetchMe().catch(() => null);

	const role = interaction.guild.roles.cache.get(pending.verificationRoleId);
	const verificationRoleError = getVerificationRoleError(interaction, role);

	if (verificationRoleError) {
		throw new Error(verificationRoleError);
	}

	return role;
}

async function saveRulesVerification(interaction, pending, message, role) {
	await Servers.upsert({ guildId: pending.guildId });
	await message.react(RULES_VERIFICATION_EMOJI);
	await RulesVerificationMessages.destroy({
		where: { guildId: pending.guildId },
	});
	await RulesVerificationMessages.create({
		channelId: pending.channelId,
		emoji: RULES_VERIFICATION_EMOJI,
		guildId: pending.guildId,
		messageId: message.id,
		roleId: role.id,
	});
}

async function postRulesFromModal(interaction, pending) {
	const title = interaction.fields.getTextInputValue(RULES_TITLE_INPUT_ID).trim();
	const body = interaction.fields.getTextInputValue(RULES_BODY_INPUT_ID).trim();

	if (!title || !body) {
		await interaction.reply({
			content: `Rules title and body are required.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const channel = await getTargetChannel(interaction, pending);
	const verificationRole = await getVerificationRole(interaction, pending);
	const embeds = [buildRulesEmbed(title, body, pending.color)];

	if (verificationRole) {
		embeds.push(buildVerificationEmbed());
	}

	const message = await channel.send({ embeds });

	if (verificationRole) {
		await saveRulesVerification(interaction, pending, message, verificationRole);
	}

	const verificationText = verificationRole ?
		` Verification is enabled for ${verificationRole}.` :
		``;

	await interaction.editReply({
		content: `Rules posted in ${channel} with color ${formatHexColor(pending.color)}.${verificationText}`,
	});
}

async function handleModalSubmit(interaction) {
	const [, setupId, action] = interaction.customId.split(`:`);

	if (action !== `post`) {
		return;
	}

	const pending = await getPendingRules(interaction, setupId);

	if (!pending) {
		return;
	}

	try {
		await postRulesFromModal(interaction, pending);
		clearPendingRules(setupId);
	} catch (err) {
		error(`Failed to post rules:`, err);
		clearPendingRules(setupId);

		const payload = {
			content: `Failed to post rules: ${err.message}`,
			flags: MessageFlags.Ephemeral,
		};

		if (interaction.replied || interaction.deferred) {
			await interaction.followUp(payload);
		} else {
			await interaction.reply(payload);
		}
	}
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`rules`)
		.setDescription(`Post server rules.`)
		.addChannelOption(option =>
			option
				.setName(`channel`)
				.setDescription(`Channel to post the rules in.`)
				.setRequired(true)
				.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
		)
		.addStringOption(option =>
			option
				.setName(`color`)
				.setDescription(`Embed color name or hex code.`)
				.setAutocomplete(true),
		)
		.addRoleOption(option =>
			option
				.setName(`verification`)
				.setDescription(`Optional role granted when members react with the check mark.`),
		)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild),

	async execute(interaction) {
		try {
			await startPost(interaction);
		} catch (err) {
			error(`Failed to execute rules:`, err);

			const payload = {
				content: `Failed to execute rules: ${err.message}`,
				flags: MessageFlags.Ephemeral,
			};

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp(payload);
			} else {
				await interaction.reply(payload);
			}
		}
	},

	handleModalSubmit,
};
