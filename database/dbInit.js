const { sequelize } = require(`./dbObjects.js`);
const { auditDatabaseStartup } = require(`./dbAudit.js`);
const { info } = require(`../utils/writeLog.js`);
const path = require(`node:path`);
const fs = require(`node:fs`);

async function dbInit() {
	const dbPath = path.resolve(`database/database.sqlite`);
	const exists = fs.existsSync(dbPath);

	// sequelize.sync creates missing tables for a brand-new database. The audit
	// pass below checks existing databases without changing schema automatically.
	await sequelize.sync();
	await auditDatabaseStartup({ dbPath });

	info(
		exists ?
			`Database synced` :
			`Database created and synced`,
	);
}

module.exports = { dbInit };
