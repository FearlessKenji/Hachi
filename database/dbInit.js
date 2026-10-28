// Database startup initialization.
//
// The ready event calls dbInit() after config validation has selected the correct
// SQLite/SQLCipher runtime. Syncing here ensures tables exist before cron jobs or
// commands query them.
const { sequelize } = require(`./dbObjects.js`);
const { auditDatabaseStartup } = require(`./dbAudit.js`);
const { info, warn } = require(`../utils/writeLog.js`);
const path = require(`node:path`);
const fs = require(`node:fs`);
const { QueryTypes } = require(`sequelize`);

async function ensureOneOpenModmailTicketIndex(database = sequelize) {
	// Existing installs may already have duplicate open tickets. Keep the bot
	// running and report those rows for manual resolution instead of silently
	// deleting a ticket or failing startup while creating the new constraint.
	const duplicates = await database.query(`
		SELECT guildId, openerId, COUNT(*) AS ticketCount
		FROM modmailTickets
		WHERE status = 'open'
		GROUP BY guildId, openerId
		HAVING COUNT(*) > 1
		LIMIT 1
	`, { type: QueryTypes.SELECT });
	if (duplicates.length) {
		warn(`Modmail has duplicate open tickets; resolve them before the one-open-ticket database constraint can be installed.`);
		return;
	}

	await database.query(`
		CREATE UNIQUE INDEX IF NOT EXISTS "modmailTicketsOneOpenPerUser"
		ON "modmailTickets" ("guildId", "openerId")
		WHERE "status" = 'open'
	`);
}

async function dbInit() {
	const dbPath = path.resolve(`database/database.sqlite`);
	const exists = fs.existsSync(dbPath);

	// sequelize.sync creates missing tables for a brand-new database. Install the
	// Modmail uniqueness guard after legacy duplicate review, then audit existing
	// schema drift without silently rebuilding tables.
	await sequelize.sync();
	await ensureOneOpenModmailTicketIndex();
	await auditDatabaseStartup({ dbPath });

	info(
		exists ?
			`Database synced` :
			`Database created and synced`,
	);
}

module.exports = { dbInit, ensureOneOpenModmailTicketIndex };
