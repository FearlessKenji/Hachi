// Promise-based database connection helper for HachiGen tooling.
const path = require(`node:path`);
const { createRequire } = require(`node:module`);
const {
	databaseFileStatus,
	openSqlCipherDatabase,
	readDatabaseKeyFromEnvFile,
} = require(`./dbEncryption.js`);

// HachiGen's database viewer and maintenance tools need one small query API that
// can read plaintext databases during conversion work and encrypted databases
// afterward. Runtime code should use Sequelize/dbObjects instead.
function createRootRequire(root = process.cwd()) {
	return createRequire(path.join(path.resolve(root || `.`), `package.json`));
}

function loadSqlite3(root) {
	// sqlite3 is installed in the selected Hachi root project.
	return createRootRequire(root)(`sqlite3`).verbose();
}

function sqlite3Mode(sqlite3, readonly) {
	return readonly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE;
}

// Plain database support exists for migration and diagnostics only. Normal
// Hachi startup rejects plaintext databases in configCheck.
function openPlainDatabase({ dbPath, readonly = false, root = process.cwd() } = {}) {
	const sqlite3 = loadSqlite3(root);

	return new Promise((resolve, reject) => {
		const handle = new sqlite3.Database(dbPath, sqlite3Mode(sqlite3, readonly), error => {
			if (error) {
				reject(error);
				return;
			}

			resolve({
				encrypted: false,
				handle,
				kind: `sqlite3`,
				status: databaseFileStatus(dbPath),
				all(sql, params = []) {
					return new Promise((queryResolve, queryReject) => {
						handle.all(sql, params, (queryError, rows) => {
							if (queryError) {
								queryReject(queryError);
								return;
							}

							queryResolve(rows || []);
						});
					});
				},
				get(sql, params = []) {
					return new Promise((queryResolve, queryReject) => {
						handle.get(sql, params, (queryError, row) => {
							if (queryError) {
								queryReject(queryError);
								return;
							}

							queryResolve(row || null);
						});
					});
				},
				exec(sql) {
					return new Promise((queryResolve, queryReject) => {
						handle.exec(sql, queryError => {
							if (queryError) {
								queryReject(queryError);
								return;
							}

							queryResolve();
						});
					});
				},
				close() {
					return new Promise((closeResolve, closeReject) => {
						handle.close(closeError => {
							if (closeError) {
								closeReject(closeError);
								return;
							}

							closeResolve();
						});
					});
				},
			});
		});
	});
}

function bind(statement, method, params = []) {
	if (params === null || params === undefined) {
		return statement[method]();
	}

	if (Array.isArray(params)) {
		return statement[method](...params);
	}

	return statement[method](params);
}

// Encrypted tool connections use the same .env key lookup as runtime, but expose
// promise-friendly query helpers for renderer/database worker code.
function openEncryptedDatabase({
	dbPath,
	envPath = null,
	readonly = false,
	root = process.cwd(),
} = {}) {
	const resolvedRoot = path.resolve(root || `.`);
	const keyInfo = readDatabaseKeyFromEnvFile(envPath || path.join(resolvedRoot, `.env`), process.env, resolvedRoot);

	if (!String(keyInfo.key || ``).trim()) {
		throw new Error(`Database appears encrypted, but no HACHI_DB_KEY or readable HACHI_DB_KEY_FILE is configured.`);
	}

	const handle = openSqlCipherDatabase({
		dbPath,
		fileMustExist: true,
		key: keyInfo.key,
		readonly,
		root: resolvedRoot,
	});

	return {
		encrypted: true,
		handle,
		keySource: keyInfo.source,
		kind: `sqlcipher`,
		status: databaseFileStatus(dbPath),
		all(sql, params = []) {
			return bind(handle.prepare(sql), `all`, params);
		},
		get(sql, params = []) {
			return bind(handle.prepare(sql), `get`, params) || null;
		},
		exec(sql) {
			handle.exec(sql);
		},
		close() {
			handle.close();
		},
	};
}

// Choose the connection type from the file header. This lets HachiGen inspect a
// pre-conversion plaintext database and an encrypted production database through
// the same helper surface.
async function openToolDatabase({
	dbPath,
	envPath = null,
	readonly = false,
	root = process.cwd(),
} = {}) {
	const status = databaseFileStatus(dbPath);

	if (status.encryptedLikely) {
		return openEncryptedDatabase({ dbPath, envPath, readonly, root });
	}

	return openPlainDatabase({ dbPath, readonly, root });
}

function all(db, sql, params = []) {
	return db.all(sql, params);
}

function get(db, sql, params = []) {
	return db.get(sql, params);
}

function exec(db, sql) {
	return db.exec(sql);
}

function closeDatabase(db) {
	return db.close();
}

module.exports = {
	all,
	closeDatabase,
	exec,
	get,
	openToolDatabase,
};
