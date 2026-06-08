const { sequelize } = require(`../database/dbObjects.js`);
const { info, warn, error } = require(`../utils/writeLog.js`);
const path = require(`node:path`);
const fs = require(`node:fs`);

async function dbInit() {
	const dbPath = path.resolve(`database/database.sqlite`);
	const exists = fs.existsSync(dbPath);

	await sequelize.sync(); // alter: true for attempted less destructive reforming of database. force: true for destructive complete remaking of database.

	info(
		exists ?
			`Database synced` :
			`Database created and synced`,
	);
}

module.exports = { dbInit };
