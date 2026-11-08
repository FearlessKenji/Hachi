// Persistent, self-repairing Twitch VIP verification panels.
const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
	PermissionFlagsBits,
} = require(`discord.js`);
const { TwitchVerificationPanels } = require(`../database/dbObjects.js`);
const { error } = require(`./writeLog.js`);

const REPAIR_COOLDOWN_MS = 60 * 1000;
const WARNING_INTERVAL_MS = 15 * 60 * 1000;
const WARNING_WINDOW_MS = 24 * 60 * 60 * 1000;
const WARNING_LIMIT = 3;
const intentionalPanelDeletes = new Set();

function panelMessageKey(guildId, messageId) {
	return `${guildId}:${messageId}`;
}

function isIntentionalPanelDeletion(guildId, messageId) {
	return intentionalPanelDeletes.has(panelMessageKey(guildId, messageId));
}

async function fetchStoredPanelMessage(guild, panel) {
	if (!panel?.messageId) {
		return null;
	}
	let channel;
	try {
		channel = await guild.channels.fetch(panel.channelId);
	} catch (err) {
		if (err.code !== 10003) {
			throw err;
		}
		return null;
	}
	if (!channel?.messages?.fetch) {
		return null;
	}
	try {
		return await channel.messages.fetch(panel.messageId);
	} catch (err) {
		if (err.code !== 10008) {
			throw err;
		}
		return null;
	}
}

async function deleteStoredPanelMessage(guildId, message) {
	const key = panelMessageKey(guildId, message.id);
	intentionalPanelDeletes.add(key);
	try {
		await message.delete();
	} catch (err) {
		if (err.code !== 10008) {
			intentionalPanelDeletes.delete(key);
			throw err;
		}
	}
	// Keep suppression until the corresponding database ID is retired. A
	// MessageDelete event can arrive after Discord acknowledges the delete.
	return () => intentionalPanelDeletes.delete(key);
}

function panelPayload() {
	return {
		content: [
			`## Twitch Verification`,
			`Click the button to verify your Twitch account with Hachi. If your Twitch account is a VIP for the connected channel, Hachi will update your Discord VIP role.`,
			``,
			`-# Hachi never sees your Twitch password and does not store OAuth tokens from this verification.`,
		].join(`\n`),
		components: [new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId(`twitch:verify`).setLabel(`Verify Twitch`).setStyle(ButtonStyle.Primary),
		)],
	};
}

function channelFailure(guild, channel) {
	if (!channel?.isTextBased?.() || !channel.send) {
		return `unavailable`;
	}
	const permissions = channel.permissionsFor(guild.members.me);
	const missing = [];
	if (!permissions?.has(PermissionFlagsBits.ViewChannel)) {
		missing.push(`view`);
	}
	if (!permissions?.has(PermissionFlagsBits.SendMessages)) {
		missing.push(`send`);
	}
	if (!permissions?.has(PermissionFlagsBits.ReadMessageHistory)) {
		missing.push(`history`);
	}
	return missing.length ? missing.join(`-`) : null;
}

async function recordFailure(panel, code) {
	if (panel.failureCode === code) {
		return;
	}
	await panel.update({
		failureCode: code,
		warningCount: 0,
		warningLastSentAt: null,
		warningWindowStartedAt: null,
	});
}

async function fetchPanelMessage(client, panel) {
	const guild = client.guilds.cache.get(panel.guildId) || await client.guilds.fetch(panel.guildId).catch(() => null);
	if (!guild) {
		return { failure: `guild-unavailable` };
	}
	const channel = await guild.channels.fetch(panel.channelId).catch(() => null);
	const failure = channelFailure(guild, channel);
	if (failure) {
		return { failure, guild };
	}
	let message = null;
	if (panel.messageId) {
		try {
			message = await channel.messages.fetch(panel.messageId);
		} catch (err) {
			// A transient fetch failure cannot prove the old panel disappeared.
			if (err.code !== 10008) {
				throw err;
			}
		}
	}
	return { channel, guild, message };
}

async function repairVerificationPanel(client, panelOrGuildId, { force = false } = {}) {
	const panel = typeof panelOrGuildId === `string` ?
		await TwitchVerificationPanels.findByPk(panelOrGuildId) :
		panelOrGuildId;
	if (!panel) {
		return { ok: false, reason: `No managed Twitch verification panel is configured.` };
	}
	if (!force && panel.lastRepairAt && Date.now() - new Date(panel.lastRepairAt) < REPAIR_COOLDOWN_MS) {
		return { ok: false, reason: `Repair cooldown is active.` };
	}
	const state = await fetchPanelMessage(client, panel);
	if (state.failure) {
		await recordFailure(panel, state.failure);
		return { ok: false, reason: state.failure };
	}
	if (state.message) {
		await state.message.edit(panelPayload());
		await panel.update({ failureCode: null, lastRepairAt: new Date() });
		return { message: state.message, ok: true, repaired: false };
	}
	const message = await state.channel.send(panelPayload());
	try {
		await panel.update({
			failureCode: null,
			lastRepairAt: new Date(),
			messageId: message.id,
			warningCount: 0,
			warningLastSentAt: null,
			warningWindowStartedAt: null,
		});
	} catch (err) {
		await message.delete().catch(cleanupError =>
			error(`Failed to remove an unsaved Twitch verification panel ${message.id}:`, cleanupError));
		throw err;
	}
	return { message, ok: true, repaired: true };
}

async function setVerificationPanel(guild, channel) {
	const failure = channelFailure(guild, channel);
	if (failure) {
		throw new Error(`Hachi cannot create a verification panel in that channel (${failure}).`);
	}
	const oldPanel = await TwitchVerificationPanels.findByPk(guild.id);
	const oldMessage = await fetchStoredPanelMessage(guild, oldPanel);
	if (oldPanel?.channelId === channel.id && oldMessage) {
		await oldMessage.edit(panelPayload());
		await oldPanel.update({ failureCode: null, lastRepairAt: new Date() });
		return oldMessage;
	}
	// Create the replacement first, but retire the old message before changing
	// the canonical stored ID. A failed delete keeps the old panel retryable.
	const message = await channel.send(panelPayload());
	let releaseDeletion = null;
	try {
		if (oldMessage) {
			releaseDeletion = await deleteStoredPanelMessage(guild.id, oldMessage);
		}
		await TwitchVerificationPanels.upsert({
			guildId: guild.id,
			channelId: channel.id,
			messageId: message.id,
			failureCode: null,
			lastRepairAt: new Date(),
			warningCount: 0,
			warningLastSentAt: null,
			warningWindowStartedAt: null,
		});
	} catch (err) {
		// Discord and SQLite cannot share a transaction. Best-effort rollback
		// removes the replacement if retiring the old ID or saving the new one fails.
		await message.delete().catch(cleanupError =>
			error(`Failed to remove an unsaved Twitch verification panel ${message.id}:`, cleanupError));
		throw err;
	} finally {
		releaseDeletion?.();
	}
	return message;
}

async function removeVerificationPanel(guild) {
	const panel = await TwitchVerificationPanels.findByPk(guild.id);
	if (!panel) {
		return false;
	}
	const message = await fetchStoredPanelMessage(guild, panel);
	const releaseDeletion = message ? await deleteStoredPanelMessage(guild.id, message) : null;
	try {
		// The ID remains available until Discord confirms removal or absence.
		await panel.destroy();
	} finally {
		releaseDeletion?.();
	}
	return true;
}

async function reconcileVerificationPanels(client) {
	const panels = await TwitchVerificationPanels.findAll();
	return Promise.all(panels.map(panel => repairVerificationPanel(client, panel, { force: true })
		.catch(err => {
			error(`Failed to reconcile Twitch verification panel for ${panel.guildId}:`, err);
			return { ok: false, reason: err.message };
		})));
}

function warningContent(code) {
	if (code === `unavailable`) {
		return `The configured Twitch verification panel channel is unavailable. ` +
			`Use /twitch panel to move it or /twitch panel action:remove to stop managing it.`;
	}
	const names = [];
	if (code?.split(`-`).includes(`view`)) {
		names.push(`View Channel`);
	}
	if (code?.split(`-`).includes(`send`)) {
		names.push(`Send Messages`);
	}
	if (code?.split(`-`).includes(`history`)) {
		names.push(`Read Message History`);
	}
	return `Hachi cannot maintain the Twitch verification panel in its configured channel. ` +
		`Use /twitch panel to move it, or repair the channel permissions.\n\n` +
		`**Missing permissions:** ${names.join(`, `) || `Unknown`}`;
}

async function sendVerificationPanelWarningToManager(interaction, now = new Date()) {
	if (!interaction.isChatInputCommand?.() || !interaction.guildId ||
		!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
		return false;
	}
	const panel = await TwitchVerificationPanels.findByPk(interaction.guildId);
	if (!panel?.failureCode) {
		return false;
	}
	const windowExpired = !panel.warningWindowStartedAt || now - new Date(panel.warningWindowStartedAt) >= WARNING_WINDOW_MS;
	const count = windowExpired ? 0 : panel.warningCount;
	if (count >= WARNING_LIMIT ||
		(panel.warningLastSentAt && now - new Date(panel.warningLastSentAt) < WARNING_INTERVAL_MS)) {
		return false;
	}
	const payload = {
		content: `## Twitch verification panel needs attention:\n\n${warningContent(panel.failureCode)}`,
		flags: MessageFlags.Ephemeral,
	};
	if (interaction.replied || interaction.deferred) {
		await interaction.followUp(payload);
	} else {
		await interaction.reply(payload);
	}
	await panel.update({
		warningCount: count + 1,
		warningLastSentAt: now,
		warningWindowStartedAt: windowExpired ? now : panel.warningWindowStartedAt,
	});
	return true;
}

module.exports = {
	isIntentionalPanelDeletion,
	panelPayload,
	reconcileVerificationPanels,
	removeVerificationPanel,
	repairVerificationPanel,
	sendVerificationPanelWarningToManager,
	setVerificationPanel,
};
