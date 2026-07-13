// sqlite3-compatible adapter backed by better-sqlite3-multiple-ciphers.
const { Buffer } = require(`node:buffer`);
const { setImmediate } = require(`node:timers`);
const {
	openSqlCipherDatabase,
	readDatabaseKeyFromEnv,
} = require(`./dbEncryption.js`);

// Sequelize's sqlite dialect expects the callback-oriented sqlite3 package API.
// The SQLCipher driver used by Hachi is better-sqlite3-compatible instead. This
// adapter implements only the sqlite3 surface Sequelize uses: Database, run,
// all, get, exec, close, and the OPEN_* constants.
const OPEN_READONLY = 1;
const OPEN_READWRITE = 2;
const OPEN_CREATE = 4;
const OPEN_FULLMUTEX = 0x00010000;
const OPEN_URI = 0x00000040;
const OPEN_SHAREDCACHE = 0x00020000;
const OPEN_PRIVATECACHE = 0x00040000;

// sqlite3 callbacks are asynchronous. setImmediate keeps callback timing close
// enough that Sequelize does not accidentally rely on sync completion.
function defer(callback, context, ...args) {
	if (typeof callback !== `function`) {
		return;
	}

	setImmediate(() => {
		callback.call(context, ...args);
	});
}

// sqlite3 supports (sql, callback), (sql, params, callback), and named params.
// Normalize those call shapes before binding into better-sqlite3 statements.
function normalizeMethodArgs(params, callback) {
	if (typeof params === `function`) {
		return {
			callback: params,
			params: [],
		};
	}

	return {
		callback,
		params: params === undefined ? [] : params,
	};
}

// sqlite3 named parameters can be passed as $name/:name/@name. better-sqlite3
// expects bare keys, so strip the prefix only at the adapter boundary.
function normalizeNamedParameters(params) {
	if (!params || typeof params !== `object` || Array.isArray(params) || Buffer.isBuffer(params)) {
		return params;
	}

	return Object.fromEntries(Object.entries(params).map(([key, value]) => [
		key.replace(/^[$:@]/u, ``),
		normalizeBindableValue(value),
	]));
}

function normalizeBindableValue(value) {
	if (typeof value === `boolean`) {
		return value ? 1 : 0;
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	return value;
}

function bindStatement(statement, method, params) {
	const normalizedParams = normalizeNamedParameters(params);

	if (normalizedParams === null || normalizedParams === undefined) {
		return statement[method]();
	}

	if (Array.isArray(normalizedParams)) {
		return statement[method](...normalizedParams.map(normalizeBindableValue));
	}

	return statement[method](normalizedParams);
}

function toLastId(value) {
	if (typeof value === `bigint`) {
		const numeric = Number(value);
		return Number.isSafeInteger(numeric) ? numeric : value.toString();
	}

	return value;
}

// sqlite3 exposes lastID/changes on the Statement callback context. Sequelize
// reads those fields after INSERT/UPDATE statements, so preserve that shape.
class Statement {
	constructor(info = {}) {
		this.lastID = toLastId(info.lastInsertRowid || 0);
		this.changes = Number(info.changes || 0);
	}
}

class SqlcipherDatabase {
	constructor(filename, mode = OPEN_READWRITE | OPEN_CREATE, callback = null) {
		let openMode = mode;
		let openCallback = callback;

		if (typeof mode === `function`) {
			openCallback = mode;
			openMode = OPEN_READWRITE | OPEN_CREATE;
		}

		this.filename = filename;
		this.open = false;

		try {
			// The adapter reads the database key from process.env because Sequelize
			// constructs dialect modules without passing custom Hachi options.
			const keyInfo = readDatabaseKeyFromEnv(process.env, process.cwd());

			if (!String(keyInfo.key || ``).trim()) {
				throw new Error(`No HACHI_DB_KEY or readable HACHI_DB_KEY_FILE is configured for encrypted database runtime.`);
			}

			this.handle = openSqlCipherDatabase({
				dbPath: filename,
				fileMustExist: filename === `:memory:` ? false : (openMode & OPEN_CREATE) === 0,
				key: keyInfo.key,
				readonly: Boolean(openMode & OPEN_READONLY),
				root: process.cwd(),
			});
			this.open = true;
			defer(openCallback, this, null);
		} catch (error) {
			this.openError = error;
			defer(openCallback, this, error);
		}
	}

	assertOpen() {
		if (this.openError) {
			throw this.openError;
		}

		if (!this.handle || !this.open) {
			throw new Error(`Database is closed.`);
		}
	}

	serialize(callback) {
		if (typeof callback === `function`) {
			callback();
		}

		return this;
	}

	parallelize(callback) {
		if (typeof callback === `function`) {
			callback();
		}

		return this;
	}

	run(sql, params, callback) {
		const args = normalizeMethodArgs(params, callback);
		let statementResult = new Statement();

		try {
			this.assertOpen();
			const info = bindStatement(this.handle.prepare(sql), `run`, args.params);
			statementResult = new Statement(info);
			defer(args.callback, statementResult, null);
		} catch (error) {
			defer(args.callback, statementResult, error);
		}

		return this;
	}

	all(sql, params, callback) {
		const args = normalizeMethodArgs(params, callback);

		try {
			this.assertOpen();
			const statement = this.handle.prepare(sql);
			const rows = statement.reader ? bindStatement(statement, `all`, args.params) : [];

			if (!statement.reader) {
				bindStatement(statement, `run`, args.params);
			}

			defer(args.callback, this, null, rows || []);
		} catch (error) {
			defer(args.callback, this, error);
		}

		return this;
	}

	get(sql, params, callback) {
		const args = normalizeMethodArgs(params, callback);

		try {
			this.assertOpen();
			const statement = this.handle.prepare(sql);
			const row = statement.reader ? bindStatement(statement, `get`, args.params) : undefined;

			if (!statement.reader) {
				bindStatement(statement, `run`, args.params);
			}

			defer(args.callback, this, null, row || undefined);
		} catch (error) {
			defer(args.callback, this, error);
		}

		return this;
	}

	exec(sql, callback) {
		try {
			this.assertOpen();
			this.handle.exec(sql);
			defer(callback, this, null);
		} catch (error) {
			defer(callback, this, error);
		}

		return this;
	}

	close(callback) {
		try {
			if (this.handle && this.open) {
				this.handle.close();
			}

			this.open = false;
			defer(callback, this, null);
		} catch (error) {
			defer(callback, this, error);
		}

		return this;
	}
}

module.exports = {
	Database: SqlcipherDatabase,
	OPEN_CREATE,
	OPEN_FULLMUTEX,
	OPEN_PRIVATECACHE,
	OPEN_READONLY,
	OPEN_READWRITE,
	OPEN_SHAREDCACHE,
	OPEN_URI,
	verbose() {
		return module.exports;
	},
};
