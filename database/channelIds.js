// Allocate stable channel IDs without leaving visible gaps after removals.
const { QueryTypes } = require(`sequelize`);

async function findReusableChannelId(sequelize, transaction) {
	// A previous database cleanup may have left child rows pointing at a missing
	// channel. Reserve those IDs so a new streamer cannot inherit old identity or
	// replay state. The caller holds an IMMEDIATE transaction until insertion.
	const [availableRow] = await sequelize.query(`
		WITH occupiedIds(channelId) AS (
			SELECT 0
			UNION SELECT id FROM channels WHERE id > 0
			UNION SELECT channelId FROM streamChannelIdentities WHERE channelId > 0
			UNION SELECT channelId FROM kickLiveSessions WHERE channelId > 0
			UNION SELECT channelId FROM pendingStreamVods WHERE channelId > 0
		)
		SELECT MIN(occupied.channelId + 1) AS availableId
		FROM occupiedIds AS occupied
		WHERE NOT EXISTS (
			SELECT 1 FROM occupiedIds AS nextId
			WHERE nextId.channelId = occupied.channelId + 1
		)
	`, { transaction, type: QueryTypes.SELECT });

	const availableId = Number(availableRow?.availableId);
	if (!Number.isSafeInteger(availableId) || availableId < 1) {
		throw new Error(`Could not allocate a safe streamer row ID.`);
	}

	return availableId;
}

module.exports = { findReusableChannelId };
