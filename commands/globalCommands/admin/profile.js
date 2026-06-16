const {
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
} = require(`discord.js`);
const { Buffer } = require(`node:buffer`);
const { error: logError } = require(`../../../utils/writeLog.js`);

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIN_IMAGE_DIMENSION = 64;
const ALLOWED_IMAGE_TYPES = new Set([
	`image/gif`,
	`image/jpeg`,
	`image/png`,
]);
const CLEAR_TARGET_LABELS = {
	all: `avatar, banner, bio, and nickname`,
	avatar: `avatar`,
	banner: `banner`,
	bio: `bio`,
	nickname: `nickname`,
};

class ProfileValidationError extends Error {}

function normalizeContentType(contentType) {
	if (!contentType) {
		return null;
	}

	const normalized = contentType
		.split(`;`)[0]
		.trim()
		.toLowerCase();

	return normalized === `image/jpg` ? `image/jpeg` : normalized;
}

function formatBytes(bytes) {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hasUpdate(updates, field) {
	return Object.prototype.hasOwnProperty.call(updates, field);
}

function getPngInfo(buffer) {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

	if (
		buffer.length < 24 ||
		!signature.every((byte, index) => buffer[index] === byte) ||
		buffer.toString(`ascii`, 12, 16) !== `IHDR`
	) {
		return null;
	}

	return {
		contentType: `image/png`,
		height: buffer.readUInt32BE(20),
		width: buffer.readUInt32BE(16),
	};
}

function getGifInfo(buffer) {
	if (buffer.length < 10) {
		return null;
	}

	const header = buffer.toString(`ascii`, 0, 6);

	if (header !== `GIF87a` && header !== `GIF89a`) {
		return null;
	}

	return {
		contentType: `image/gif`,
		height: buffer.readUInt16LE(8),
		width: buffer.readUInt16LE(6),
	};
}

function isJpegSofMarker(marker) {
	return [
		0xc0,
		0xc1,
		0xc2,
		0xc3,
		0xc5,
		0xc6,
		0xc7,
		0xc9,
		0xca,
		0xcb,
		0xcd,
		0xce,
		0xcf,
	].includes(marker);
}

function getJpegInfo(buffer) {
	if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
		return null;
	}

	let offset = 2;

	while (offset < buffer.length) {
		if (buffer[offset] !== 0xff) {
			offset++;
			continue;
		}

		while (buffer[offset] === 0xff) {
			offset++;
		}

		const marker = buffer[offset];
		offset++;

		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			continue;
		}

		if (marker === 0xd9 || marker === 0xda) {
			break;
		}

		if (offset + 2 > buffer.length) {
			break;
		}

		const blockLength = buffer.readUInt16BE(offset);

		if (blockLength < 2 || offset + blockLength > buffer.length) {
			break;
		}

		if (isJpegSofMarker(marker)) {
			if (blockLength < 7) {
				return null;
			}

			return {
				contentType: `image/jpeg`,
				height: buffer.readUInt16BE(offset + 3),
				width: buffer.readUInt16BE(offset + 5),
			};
		}

		offset += blockLength;
	}

	return null;
}

function detectImageInfo(buffer) {
	const imageInfo = getPngInfo(buffer) || getGifInfo(buffer) || getJpegInfo(buffer);

	if (!imageInfo || imageInfo.width < MIN_IMAGE_DIMENSION || imageInfo.height < MIN_IMAGE_DIMENSION) {
		return null;
	}

	return imageInfo;
}

function validateImageMetadata(attachment, label) {
	const contentType = normalizeContentType(attachment.contentType);

	if (contentType && !ALLOWED_IMAGE_TYPES.has(contentType)) {
		throw new ProfileValidationError(`${label} must be a PNG, JPG, or GIF image.`);
	}

	if (attachment.size > MAX_IMAGE_BYTES) {
		throw new ProfileValidationError(`${label} must be ${formatBytes(MAX_IMAGE_BYTES)} or smaller.`);
	}
}

async function downloadImage(attachment, label) {
	validateImageMetadata(attachment, label);

	let response;

	try {
		response = await fetch(attachment.url);
	} catch (err) {
		throw new ProfileValidationError(`Could not download ${label}: ${err.message}`);
	}

	if (!response.ok) {
		throw new ProfileValidationError(`Could not download ${label}. Discord returned HTTP ${response.status}.`);
	}

	const contentLength = Number(response.headers.get(`content-length`));

	if (!Number.isNaN(contentLength) && contentLength > MAX_IMAGE_BYTES) {
		throw new ProfileValidationError(`${label} must be ${formatBytes(MAX_IMAGE_BYTES)} or smaller.`);
	}

	const buffer = Buffer.from(await response.arrayBuffer());

	if (buffer.length > MAX_IMAGE_BYTES) {
		throw new ProfileValidationError(`${label} must be ${formatBytes(MAX_IMAGE_BYTES)} or smaller.`);
	}

	const detectedInfo = detectImageInfo(buffer);
	const declaredType = normalizeContentType(attachment.contentType);

	if (!detectedInfo) {
		throw new ProfileValidationError(`${label} could not be verified as a valid PNG, JPG, or GIF image.`);
	}

	if (declaredType && declaredType !== detectedInfo.contentType) {
		throw new ProfileValidationError(`${label} file type does not match its image data.`);
	}

	return `data:${detectedInfo.contentType};base64,${buffer.toString(`base64`)}`;
}

function getCleanStringOption(interaction, optionName, label) {
	const value = interaction.options.getString(optionName);

	if (value === null) {
		return undefined;
	}

	const trimmed = value.trim();

	if (!trimmed) {
		throw new ProfileValidationError(`${label} cannot be blank.`);
	}

	return trimmed;
}

function ensureManageGuild(interaction) {
	if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
		throw new ProfileValidationError(`You need Manage Server permission to update my server profile.`);
	}
}

async function ensureCanChangeNickname(interaction, updates) {
	if (!hasUpdate(updates, `nick`)) {
		return;
	}

	await interaction.guild.members.fetchMe().catch(() => null);

	if (!interaction.guild.members.me?.permissions.has(PermissionFlagsBits.ChangeNickname)) {
		throw new ProfileValidationError(`I need the Change Nickname permission to update my server nickname.`);
	}
}

function getUpdatedLabels(updates) {
	const labels = [];

	if (hasUpdate(updates, `avatar`)) {
		labels.push(`avatar`);
	}

	if (hasUpdate(updates, `banner`)) {
		labels.push(`banner`);
	}

	if (hasUpdate(updates, `bio`)) {
		labels.push(`bio`);
	}

	if (hasUpdate(updates, `nick`)) {
		labels.push(`nickname`);
	}

	return labels.join(`, `);
}

async function buildSetUpdates(interaction) {
	const updates = {};
	const nickname = getCleanStringOption(interaction, `nickname`, `Nickname`);
	const bio = getCleanStringOption(interaction, `bio`, `Bio`);
	const avatar = interaction.options.getAttachment(`avatar`);
	const banner = interaction.options.getAttachment(`banner`);

	if (nickname !== undefined) {
		updates.nick = nickname;
	}

	if (bio !== undefined) {
		updates.bio = bio;
	}

	if (avatar) {
		updates.avatar = await downloadImage(avatar, `Avatar`);
	}

	if (banner) {
		updates.banner = await downloadImage(banner, `Banner`);
	}

	if (!Object.keys(updates).length) {
		throw new ProfileValidationError(`Choose at least one profile field to update.`);
	}

	return updates;
}

function buildClearUpdates(target) {
	const updates = {};

	if (target === `all` || target === `avatar`) {
		updates.avatar = null;
	}

	if (target === `all` || target === `banner`) {
		updates.banner = null;
	}

	if (target === `all` || target === `bio`) {
		updates.bio = null;
	}

	if (target === `all` || target === `nickname`) {
		updates.nick = null;
	}

	return updates;
}

async function applyProfileUpdates(interaction, updates) {
	await ensureCanChangeNickname(interaction, updates);

	await interaction.guild.members.editMe({
		...updates,
		reason: `Server profile updated by ${interaction.user.tag} (${interaction.user.id})`,
	});
}

async function setProfile(interaction) {
	ensureManageGuild(interaction);
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const updates = await buildSetUpdates(interaction);
	await applyProfileUpdates(interaction, updates);

	await interaction.editReply({
		content: `Updated my server profile: ${getUpdatedLabels(updates)}.`,
	});
}

async function clearProfile(interaction) {
	ensureManageGuild(interaction);
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const target = interaction.options.getString(`target`, true);
	const updates = buildClearUpdates(target);

	await applyProfileUpdates(interaction, updates);

	await interaction.editReply({
		content: `Cleared my server profile ${CLEAR_TARGET_LABELS[target]}.`,
	});
}

async function sendErrorResponse(interaction, content) {
	const payload = {
		content,
		flags: MessageFlags.Ephemeral,
	};

	if (interaction.deferred) {
		await interaction.editReply({ content });
	} else if (interaction.replied) {
		await interaction.followUp(payload);
	} else {
		await interaction.reply(payload);
	}
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`profile`)
		.setDescription(`Manage my per-server profile.`)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`set`)
				.setDescription(`Set my profile for this server.`)
				.addAttachmentOption(option =>
					option
						.setName(`avatar`)
						.setDescription(`PNG, JPG, or GIF avatar image.`),
				)
				.addAttachmentOption(option =>
					option
						.setName(`banner`)
						.setDescription(`PNG, JPG, or GIF banner image.`),
				)
				.addStringOption(option =>
					option
						.setName(`bio`)
						.setDescription(`Server profile bio.`)
						.setMaxLength(190),
				)
				.addStringOption(option =>
					option
						.setName(`nickname`)
						.setDescription(`Server nickname.`)
						.setMaxLength(32),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`clear`)
				.setDescription(`Clear part of my profile for this server.`)
				.addStringOption(option =>
					option
						.setName(`target`)
						.setDescription(`Profile field to clear.`)
						.setRequired(true)
						.addChoices(
							{ name: `Avatar`, value: `avatar` },
							{ name: `Banner`, value: `banner` },
							{ name: `Bio`, value: `bio` },
							{ name: `Nickname`, value: `nickname` },
							{ name: `All`, value: `all` },
						),
				),
		)
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setContexts(InteractionContextType.Guild),

	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();

		try {
			if (subcommand === `set`) {
				await setProfile(interaction);
			} else if (subcommand === `clear`) {
				await clearProfile(interaction);
			}
		} catch (err) {
			if (!(err instanceof ProfileValidationError)) {
				logError(`Failed to execute profile ${subcommand}:`, err);
			}

			await sendErrorResponse(interaction, `Failed to update server profile: ${err.message}`);
		}
	},
};
