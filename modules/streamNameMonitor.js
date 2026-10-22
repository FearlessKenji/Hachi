// Track each provider's current name by stable account ID. A shared saved
// channel name cannot represent different Twitch and Kick names after a rename.
const { Op } = require(`sequelize`);
const { StreamChannelIdentities } = require(`../database/dbObjects.js`);
const { info, warn } = require(`../utils/writeLog.js`);

const PROVIDERS = new Set([`twitch`, `kick`]);
const mismatchedIdentityWarnings = new Map();
let identityOperationTail = Promise.resolve();

function serializeIdentityOperation(operation) {
	// Twitch and Kick polls can overlap. SQLite permits one writer, so keep
	// identity changes in one queue across both providers and recover the queue
	// after a failed operation so later polls can retry.
	const result = identityOperationTail.then(operation);
	identityOperationTail = result.catch(() => null);
	return result;
}

async function getIdentityMap(channels, provider) {
	if (!PROVIDERS.has(provider)) {
		throw new Error(`Unknown stream provider: ${provider}`);
	}

	const channelIds = channels.map(channel => channel.id);
	if (!channelIds.length) {
		return new Map();
	}

	const identities = await StreamChannelIdentities.findAll({
		where: { channelId: { [Op.in]: channelIds }, provider },
		raw: true,
	});
	return new Map(identities.map(identity => [identity.channelId, identity]));
}

async function recordStreamName(channel, provider, providerUserId, currentName) {
	if (!PROVIDERS.has(provider)) {
		throw new Error(`Unknown stream provider: ${provider}`);
	}

	const userId = String(providerUserId || ``).trim();
	const name = String(currentName || ``).toLowerCase().trim();
	if (!channel?.id || !userId || !/^[a-z0-9_-]+$/u.test(name)) {
		return null;
	}

	return serializeIdentityOperation(async () => {
		// findCreateFind reads existing identities without opening a transaction
		// for every channel on every poll. The unique index handles insert races.
		const [identity] = await StreamChannelIdentities.findCreateFind({
			where: { channelId: channel.id, provider },
			defaults: { providerUserId: userId, currentName: name },
		});
		if (!identity) {
			throw new Error(`Could not load ${provider} identity for saved channel ${channel.channelName}.`);
		}

		// A saved provider ID is authoritative. A reused old name must not silently
		// bind the row to a different account.
		const warningKey = `${channel.id}:${provider}`;
		if (identity.providerUserId !== userId) {
			if (mismatchedIdentityWarnings.get(warningKey) !== userId) {
				warn(`Ignored ${provider} identity change for saved channel ${channel.channelName}: ${identity.providerUserId} -> ${userId}.`);
				mismatchedIdentityWarnings.set(warningKey, userId);
			}
			return identity;
		}
		mismatchedIdentityWarnings.delete(warningKey);

		const nameChanged = identity.currentName !== name;
		if (nameChanged) {
			const previousName = identity.currentName;
			await identity.update({ currentName: name });
			const detectedAt = new Date().toISOString();
			// The logger adds the observation time and records this event in both raw
			// and structured logs so a later rename can be traced to its saved row.
			info(`Detected stream name change on ${provider} at ${detectedAt}: ${previousName} -> ${name} (account ID ${userId}, saved entry ${channel.channelName}, guild ${channel.guildId}).`, {
				module: `streamNameMonitor`,
				meta: {
					detectedAt,
					provider,
					providerUserId: userId,
					savedEntry: channel.channelName,
					guildId: channel.guildId,
					previousName,
					currentName: name,
				},
			});
		}

		return identity;
	});
}

module.exports = {
	getIdentityMap,
	recordStreamName,
};
