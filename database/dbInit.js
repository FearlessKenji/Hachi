const { sequelize } = require(`./dbObjects.js`);
const { runMigrations } = require(`./migrations.js`);
const { info } = require(`../utils/writeLog.js`);
const path = require(`node:path`);
const fs = require(`node:fs`);

async function dbInit() {
	const dbPath = path.resolve(`database/database.sqlite`);
	const exists = fs.existsSync(dbPath);

	await sequelize.sync(); // Creates missing tables without forcing a full database rebuild.
	await runMigrations();

	info(
		exists ?
			`Database synced` :
			`Database created and synced`,
	);
}

module.exports = { dbInit };
