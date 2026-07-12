// Named database migration entry points.
//
// This file stays intentionally small: migration implementation lives in
// dbAudit.js, while this module gives scripts or future tooling a stable import.
const { applyMigration } = require(`./dbAudit.js`);

// Compatibility wrapper for older imports. Database migration is now audit-based
// and does not use the old schemaMigrations tracking table.
async function runMigrations(options = {}) {
	return applyMigration(options);
}

module.exports = {
	runMigrations,
};
