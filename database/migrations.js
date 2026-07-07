const { applyMigration } = require(`./dbAudit.js`);

// Compatibility wrapper for older imports. Database migration is now audit-based
// and does not use the old schemaMigrations tracking table.
async function runMigrations(options = {}) {
	return applyMigration(options);
}

module.exports = {
	runMigrations,
};
