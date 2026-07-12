// SQLCipher database encryption, conversion, rekey, and backup helpers.
const crypto = require(`node:crypto`);
const fs = require(`node:fs`);
const os = require(`node:os`);
const path = require(`node:path`);
const { Buffer } = require(`node:buffer`);

// Shared database protection helpers. Hachi runtime, HachiGen, smoke tests, and
// database tooling all use this file so encryption behavior stays consistent.
// The module intentionally separates three concepts:
// - file status: what the bytes on disk look like
// - key status: where the configured key comes from
// - access status: whether SQLCipher can actually open the file with that key
const CIPHER_DRIVER_PACKAGE = `better-sqlite3-multiple-ciphers`;
const BACKUP_METADATA_TYPE = `hachi-database-backup`;
const BACKUP_METADATA_VERSION = 1;
const KEY_FINGERPRINT_CONTEXT = `hachi-db-key-v1`;

// Plain SQLite files start with this exact header. SQLCipher databases do not,
// so this cheap check lets HachiGen identify plaintext databases before opening
// them and lets configCheck fail fast when plaintext is still present.
const SQLITE_HEADER = Buffer.from([
	0x53,
	0x51,
	0x4c,
	0x69,
	0x74,
	0x65,
	0x20,
	0x66,
	0x6f,
	0x72,
	0x6d,
	0x61,
	0x74,
	0x20,
	0x33,
	0x00,
]);

// Duplicated lightly from the env-secret helper so dbEncryption can be loaded by
// database-only scripts without pulling in all secret-encryption concerns.
function parseDotEnvContent(content) {
	const values = {};
	const lines = String(content || ``).split(/\r?\n/u);

	for (const line of lines) {
		const trimmed = line.trim();

		if (!trimmed || trimmed.startsWith(`#`)) {
			continue;
		}

		const equalsIndex = trimmed.indexOf(`=`);

		if (equalsIndex === -1) {
			continue;
		}

		const key = trimmed.slice(0, equalsIndex).trim();
		let value = trimmed.slice(equalsIndex + 1).trim();

		if (value.startsWith(`"`) && value.endsWith(`"`)) {
			try {
				value = JSON.parse(value);
			} catch {
				value = value.slice(1, -1);
			}
		} else if (value.startsWith(`'`) && value.endsWith(`'`)) {
			value = value.slice(1, -1);
		}

		values[key] = value;
	}

	return values;
}

// "Protection enabled" accepts historical/preparation labels because HachiGen
// may read older .env states while migrating them to the current encrypted mode.
function isDatabaseProtectionEnabled(value) {
	return [`1`, `on`, `true`, `yes`, `prepared`, `key-ready`, `encrypted`, `runtime`, `active`].includes(String(value || ``).trim().toLowerCase());
}

// Runtime requires a stricter state: Hachi should use SQLCipher only when the
// install has explicitly moved into encrypted database operation.
function isEncryptedDatabaseRuntimeEnabled(value) {
	return [`encrypted`, `runtime`, `active`].includes(String(value || ``).trim().toLowerCase());
}

function resolveKeyFilePath(value, cwd = process.cwd()) {
	const raw = String(value || ``).trim();

	if (!raw) {
		return ``;
	}

	if (raw === `~`) {
		return process.env.HOME || process.env.USERPROFILE || os.homedir() || raw;
	}

	if (raw.startsWith(`~/`) || raw.startsWith(`~\\`)) {
		return path.join(process.env.HOME || process.env.USERPROFILE || os.homedir() || `.`, raw.slice(2));
	}

	return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

// Database keys can be direct env values or file pointers. The file-pointer path
// is preferred because it keeps raw key material out of .env.
function readDatabaseKeyFromEnv(env = process.env, cwd = process.cwd()) {
	const directKey = String(env.HACHI_DB_KEY || ``).trim();

	if (directKey) {
		return {
			key: directKey,
			source: `direct`,
		};
	}

	const keyFilePath = resolveKeyFilePath(env.HACHI_DB_KEY_FILE, cwd);

	if (!keyFilePath) {
		return {
			key: ``,
			source: `none`,
		};
	}

	return {
		key: fs.readFileSync(keyFilePath, `utf8`).trim(),
		keyFilePath,
		source: `file`,
	};
}

function readDatabaseKeyFromEnvFile(envPath = path.resolve(`.env`), baseEnv = process.env, cwd = process.cwd()) {
	const parsedEnv = fs.existsSync(envPath) ? parseDotEnvContent(fs.readFileSync(envPath, `utf8`)) : {};
	return readDatabaseKeyFromEnv({
		...baseEnv,
		...parsedEnv,
	}, cwd);
}

// Fingerprints are metadata only. They let HachiGen say "this backup was made
// with the current key" without storing the key or trying to decrypt every time.
function databaseKeyFingerprint(key) {
	const normalizedKey = String(key || ``).trim();

	if (!normalizedKey) {
		return ``;
	}

	return `sha256:${crypto
		.createHash(`sha256`)
		.update(KEY_FINGERPRINT_CONTEXT)
		.update(`\0`)
		.update(normalizedKey)
		.digest(`hex`)}`;
}

function databaseKeyFingerprintPreview(fingerprint) {
	const normalized = String(fingerprint || ``).replace(/^sha256:/u, ``);
	return normalized ? normalized.slice(0, 12) : ``;
}

function databaseBackupMetadataPath(backupPath) {
	return `${backupPath}.meta.json`;
}

// Backup metadata is advisory. If it is missing or invalid, HachiGen can still
// inspect the backup file itself and attempt verification with the current key.
function readDatabaseBackupMetadata(backupPath) {
	const metadataPath = databaseBackupMetadataPath(backupPath);

	if (!fs.existsSync(metadataPath)) {
		return null;
	}

	try {
		const metadata = JSON.parse(fs.readFileSync(metadataPath, `utf8`));

		if (metadata?.type !== BACKUP_METADATA_TYPE) {
			return null;
		}

		return metadata;
	} catch {
		return null;
	}
}

// Metadata lives beside the backup instead of inside SQLite because encrypted
// backups cannot be opened without a key, and plaintext backups may be converted
// later during backup rotation.
function writeDatabaseBackupMetadata({
	backupPath,
	key = ``,
	reason = `manual`,
	root = process.cwd(),
	source = `local`,
	status = null,
} = {}) {
	if (!backupPath) {
		throw new Error(`No database backup path was provided.`);
	}

	const now = new Date().toISOString();
	const existing = readDatabaseBackupMetadata(backupPath);
	const fileStatus = status || databaseFileStatus(backupPath);
	const fingerprint = fileStatus.encryptedLikely ? databaseKeyFingerprint(key) : ``;
	const metadataPath = databaseBackupMetadataPath(backupPath);
	const metadata = {
		createdAt: existing?.createdAt || now,
		encryptedLikely: Boolean(fileStatus.encryptedLikely),
		file: path.basename(backupPath),
		keyFingerprint: fingerprint,
		keyFingerprintPreview: databaseKeyFingerprintPreview(fingerprint),
		reason,
		relativePath: path.relative(root, backupPath),
		size: fileStatus.size || 0,
		source,
		status: fileStatus.status,
		type: BACKUP_METADATA_TYPE,
		updatedAt: now,
		version: BACKUP_METADATA_VERSION,
	};

	fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
		encoding: `utf8`,
		mode: 0o600,
	});

	try {
		fs.chmodSync(metadataPath, 0o600);
	} catch {
		// Windows ACLs may not map cleanly to POSIX modes.
	}

	return metadata;
}

// Convert low-level file/key facts into the user-facing backup status shown in
// HachiGen. This function avoids mutating backups; rotation is a separate action.
function describeDatabaseBackup({
	backupPath,
	currentKey = ``,
	root = process.cwd(),
	verifyWithCurrentKey = true,
} = {}) {
	const fileStatus = databaseFileStatus(backupPath);
	const metadata = readDatabaseBackupMetadata(backupPath);
	const currentFingerprint = databaseKeyFingerprint(currentKey);
	const backupFingerprint = String(metadata?.keyFingerprint || ``);
	const fingerprintPreview = databaseKeyFingerprintPreview(backupFingerprint);
	const base = {
		detail: fileStatus.detail,
		dot: fileStatus.dot,
		keyFingerprint: backupFingerprint,
		keyFingerprintPreview: fingerprintPreview,
		metadata,
		status: fileStatus.status,
	};

	if (fileStatus.status === `plaintext`) {
		return {
			...base,
			detail: `Backup is plain SQLite and should be encrypted with the current key.`,
			dot: `warn`,
			label: `Plain Backup`,
			status: `plaintext`,
		};
	}

	if (!fileStatus.encryptedLikely) {
		return {
			...base,
			label: fileStatus.label || `Invalid Format`,
		};
	}

	if (backupFingerprint && currentFingerprint && backupFingerprint === currentFingerprint) {
		return {
			...base,
			detail: `Backup metadata matches the current database key.`,
			dot: `good`,
			label: `Current Key`,
			status: `current-key`,
		};
	}

	if (backupFingerprint && currentFingerprint && backupFingerprint !== currentFingerprint) {
		return {
			...base,
			detail: `Backup metadata points to a different database key.`,
			dot: `warn`,
			label: `Older Key`,
			status: `older-key`,
		};
	}

	if (backupFingerprint) {
		return {
			...base,
			detail: `Backup has key metadata, but the current key is not available to compare.`,
			dot: `info`,
			label: fingerprintPreview ? `Tracked Key ${fingerprintPreview}` : `Tracked Key`,
			status: `tracked-key`,
		};
	}

	if (currentFingerprint && verifyWithCurrentKey) {
		const access = databaseAccessStatus({
			dbPath: backupPath,
			key: currentKey,
			root,
		});

		if (access.status === `encrypted`) {
			return {
				...base,
				detail: `Backup opens with the current database key. Rotate Backups can add metadata.`,
				dot: `good`,
				label: `Current Key`,
				status: `current-key`,
			};
		}

		return {
			...base,
			detail: `Backup could not be opened with the current database key.`,
			dot: `bad`,
			label: `Invalid Format`,
			status: `invalid`,
		};
	}

	if (currentFingerprint) {
		return {
			...base,
			detail: `Backup encryption has not been verified against the current key. Use Rotate Backups to verify and tag it.`,
			dot: `info`,
			label: `Not Verified`,
			status: `not-verified`,
		};
	}

	return {
		...base,
		detail: `Backup is encrypted. Configure the matching key to verify access.`,
		dot: `warn`,
		label: `Key Required`,
		status: `key-required`,
	};
}

// Header inspection cannot prove the database opens, but it is fast and safe:
// plaintext is detected, encrypted-looking files are flagged for key verification.
function databaseFileStatus(dbPath = path.resolve(`database`, `database.sqlite`)) {
	if (!fs.existsSync(dbPath)) {
		return {
			detail: `No database file found.`,
			dot: `muted`,
			encryptedLikely: false,
			label: `Missing`,
			path: dbPath,
			status: `missing`,
		};
	}

	const stats = fs.statSync(dbPath);

	if (!stats.isFile()) {
		return {
			detail: `Database path exists but is not a file.`,
			dot: `bad`,
			encryptedLikely: false,
			label: `Invalid Path`,
			path: dbPath,
			status: `invalid`,
		};
	}

	if (stats.size < SQLITE_HEADER.length) {
		return {
			detail: `Database file is too small to be a valid encrypted database.`,
			dot: `bad`,
			encryptedLikely: false,
			label: `Invalid Format`,
			path: dbPath,
			size: stats.size,
			status: `invalid`,
		};
	}

	const handle = fs.openSync(dbPath, `r`);
	const header = Buffer.alloc(SQLITE_HEADER.length);

	try {
		fs.readSync(handle, header, 0, SQLITE_HEADER.length, 0);
	} finally {
		fs.closeSync(handle);
	}

	if (header.equals(SQLITE_HEADER)) {
		return {
			detail: `Database is still plain SQLite.`,
			dot: `info`,
			encryptedLikely: false,
			label: `Plain SQLite`,
			path: dbPath,
			size: stats.size,
			status: `plaintext`,
		};
	}

	return {
		detail: `Database file is encrypted. Open it with the configured key to verify access.`,
		dot: `info`,
		encryptedLikely: true,
		label: `Encrypted`,
		path: dbPath,
		size: stats.size,
		status: `encrypted`,
	};
}

function verifiedEncryptedDatabaseStatus(dbPath) {
	return {
		...databaseFileStatus(dbPath),
		detail: `Database opens with the configured key.`,
		dot: `good`,
		encryptedLikely: true,
		label: `Encrypted`,
		status: `encrypted`,
	};
}

// Access status is stronger than file status because it proves the configured
// key can open the encrypted file and read basic schema metadata.
function databaseAccessStatus({
	dbPath = path.resolve(`database`, `database.sqlite`),
	key = ``,
	root = process.cwd(),
} = {}) {
	const status = databaseFileStatus(dbPath);

	if (!status.encryptedLikely) {
		return status;
	}

	if (!String(key || ``).trim()) {
		return {
			...status,
			detail: `Database is encrypted. Configure the database key to verify access.`,
			dot: `warn`,
			label: `Encrypted`,
			status: `encrypted`,
		};
	}

	try {
		verifyEncryptedDatabaseFile({
			dbPath,
			key,
			root,
		});

		return verifiedEncryptedDatabaseStatus(dbPath);
	} catch (error) {
		return {
			...status,
			detail: `Database could not be opened with the configured key: ${error.message || String(error)}`,
			dot: `bad`,
			encryptedLikely: false,
			label: `Invalid Format`,
			status: `invalid`,
		};
	}
}

function findPackageJson(modulePath, packageName) {
	let currentDir = path.dirname(modulePath);

	while (currentDir && currentDir !== path.dirname(currentDir)) {
		const packagePath = path.join(currentDir, `package.json`);

		if (fs.existsSync(packagePath)) {
			try {
				const packageJson = JSON.parse(fs.readFileSync(packagePath, `utf8`));

				if (packageJson.name === packageName) {
					return packagePath;
				}
			} catch {
				return ``;
			}
		}

		currentDir = path.dirname(currentDir);
	}

	return ``;
}

function loadCipherDriver(root = process.cwd()) {
	const modulePath = require.resolve(CIPHER_DRIVER_PACKAGE, { paths: [root] });
	return require(modulePath);
}

// Keep SQL quoting local to PRAGMA application. Database keys are strings, not
// identifiers, so quoteSqlString escapes single quotes for SQLCipher PRAGMA key.
function quoteSqlString(value) {
	return `'${String(value || ``).replace(/'/gu, `''`)}'`;
}

function quoteSqlIdentifier(value) {
	return `"${String(value || ``).replace(/"/gu, `""`)}"`;
}

function applySqlCipherPragmas(db, key) {
	db.pragma(`cipher='sqlcipher'`);
	db.pragma(`legacy=4`);
	db.pragma(`key=${quoteSqlString(key)}`);
}

// Central open helper for every direct SQLCipher connection. Callers should use
// this instead of constructing better-sqlite3-multiple-ciphers handles directly.
function openSqlCipherDatabase({
	dbPath,
	fileMustExist = true,
	key,
	readonly = false,
	root = process.cwd(),
} = {}) {
	const normalizedKey = String(key || ``).trim();

	if (!normalizedKey) {
		throw new Error(`No database encryption key is configured.`);
	}

	if (!dbPath) {
		throw new Error(`No database path was provided.`);
	}

	const Database = loadCipherDriver(root);
	const db = new Database(dbPath, {
		fileMustExist: Boolean(fileMustExist),
		readonly: Boolean(readonly),
	});
	applySqlCipherPragmas(db, normalizedKey);

	return db;
}

// Schema-copy helpers below use SQLite metadata rather than model definitions.
// That preserves the current live database shape during encryption conversion,
// including tables that may have compatible drift from older versions.
function getSqliteTables(db) {
	return db.prepare(`
		SELECT name, sql
		FROM sqlite_master
		WHERE type = 'table'
			AND name NOT LIKE 'sqlite_%'
			AND sql IS NOT NULL
		ORDER BY name
	`).all();
}

function getSqliteObjects(db) {
	return db.prepare(`
		SELECT name, sql, type
		FROM sqlite_master
		WHERE type IN ('index', 'trigger', 'view')
			AND sql IS NOT NULL
		ORDER BY
			CASE type
				WHEN 'index' THEN 1
				WHEN 'trigger' THEN 2
				WHEN 'view' THEN 3
				ELSE 4
			END,
			name
	`).all();
}

function sqliteTableExists(db, tableName) {
	const row = db.prepare(`
		SELECT name
		FROM sqlite_master
		WHERE type = 'table'
			AND name = ?
	`).get(tableName);
	return Boolean(row);
}

function copySqliteRows(sourceDb, targetDb, tableName) {
	const columns = sourceDb.prepare(`PRAGMA table_info(${quoteSqlIdentifier(tableName)})`).all()
		.map(column => column.name);

	if (!columns.length) {
		return 0;
	}

	const quotedColumns = columns.map(quoteSqlIdentifier).join(`, `);
	const placeholders = columns.map(() => `?`).join(`, `);
	const select = sourceDb.prepare(`SELECT ${quotedColumns} FROM ${quoteSqlIdentifier(tableName)}`);
	const insert = targetDb.prepare(`INSERT INTO ${quoteSqlIdentifier(tableName)} (${quotedColumns}) VALUES (${placeholders})`);
	let rowsCopied = 0;

	for (const row of select.iterate()) {
		insert.run(...columns.map(column => row[column]));
		rowsCopied += 1;
	}

	return rowsCopied;
}

function copySqliteSequence(sourceDb, targetDb) {
	if (!sqliteTableExists(sourceDb, `sqlite_sequence`) || !sqliteTableExists(targetDb, `sqlite_sequence`)) {
		return;
	}

	const sequenceRows = sourceDb.prepare(`SELECT name, seq FROM sqlite_sequence`).all();
	const insertSequence = targetDb.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`);

	targetDb.exec(`DELETE FROM sqlite_sequence`);

	for (const row of sequenceRows) {
		insertSequence.run(row.name, row.seq);
	}
}

// Verification intentionally performs a tiny read instead of trusting that open()
// succeeded. Wrong SQLCipher keys can create confusing late failures otherwise.
function verifyEncryptedDatabaseFile({ dbPath, key, root = process.cwd() } = {}) {
	let db = null;

	try {
		db = openSqlCipherDatabase({
			dbPath,
			key,
			readonly: true,
			root,
		});
		const integrityRows = db.prepare(`PRAGMA integrity_check`).all();
		const integrityProblems = integrityRows
			.map(row => Object.values(row)[0])
			.filter(value => value && value !== `ok`);

		if (integrityProblems.length) {
			throw new Error(`Encrypted database integrity check failed: ${integrityProblems.join(`; `)}`);
		}

		db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1`).get();

		return {
			ok: true,
			status: verifiedEncryptedDatabaseStatus(dbPath),
		};
	} finally {
		if (db) {
			db.close();
		}
	}
}

// Rekey is done in place by SQLCipher, then immediately verified by reopening
// with the new key. Callers create safety backups before invoking this.
function rekeyEncryptedDatabase({
	dbPath,
	newKey,
	oldKey,
	root = process.cwd(),
} = {}) {
	const normalizedOldKey = String(oldKey || ``).trim();
	const normalizedNewKey = String(newKey || ``).trim();

	if (!normalizedOldKey) {
		throw new Error(`No current database encryption key was provided.`);
	}

	if (!normalizedNewKey) {
		throw new Error(`No new database encryption key was provided.`);
	}

	if (normalizedOldKey === normalizedNewKey) {
		throw new Error(`New database key must differ from the current key.`);
	}

	let db = null;

	try {
		db = openSqlCipherDatabase({
			dbPath,
			key: normalizedOldKey,
			root,
		});
		db.pragma(`rekey=${quoteSqlString(normalizedNewKey)}`);
	} finally {
		if (db) {
			db.close();
		}
	}

	return verifyEncryptedDatabaseFile({
		dbPath,
		key: normalizedNewKey,
		root,
	});
}

function removeDatabaseSidecars(dbPath) {
	for (const filePath of [
		`${dbPath}-wal`,
		`${dbPath}-shm`,
		`${dbPath}-journal`,
	]) {
		try {
			if (fs.existsSync(filePath)) {
				fs.rmSync(filePath, { force: true });
			}
		} catch {
			// Sidecar cleanup should not hide the main database operation result.
		}
	}
}

function temporarySiblingPath(filePath, label) {
	const safeLabel = String(label || `tmp`).replace(/[^A-Za-z0-9_.-]/gu, `-`);
	return `${filePath}.${safeLabel}.${process.pid}.${Date.now()}.tmp`;
}

function replaceFileFromTemp(tempPath, targetPath) {
	fs.copyFileSync(tempPath, targetPath);
	fs.rmSync(tempPath, { force: true });
}

function encryptPlainDatabaseInPlace({
	dbPath,
	key,
	root = process.cwd(),
} = {}) {
	const tempPath = temporarySiblingPath(dbPath, `encrypted`);

	try {
		const result = convertPlainDatabaseToEncrypted({
			key,
			root,
			sourcePath: dbPath,
			targetPath: tempPath,
		});
		replaceFileFromTemp(tempPath, dbPath);
		removeDatabaseSidecars(dbPath);
		return result;
	} catch (error) {
		try {
			if (fs.existsSync(tempPath)) {
				fs.rmSync(tempPath, { force: true });
			}
		} catch {
			// Preserve the conversion failure.
		}

		throw error;
	}
}

function rotateDatabaseBackupKey({
	backupPath,
	includePlaintext = true,
	newKey,
	oldKey,
	root = process.cwd(),
	source = `local`,
} = {}) {
	const normalizedNewKey = String(newKey || ``).trim();
	const normalizedOldKey = String(oldKey || ``).trim();

	if (!backupPath) {
		throw new Error(`No database backup path was provided.`);
	}

	if (!normalizedNewKey) {
		throw new Error(`No target database key was provided.`);
	}

	if (!fs.existsSync(backupPath)) {
		throw new Error(`Database backup does not exist: ${backupPath}`);
	}

	const before = databaseFileStatus(backupPath);
	const safetyPath = temporarySiblingPath(backupPath, `before-rekey`);

	fs.copyFileSync(backupPath, safetyPath);

	try {
		if (before.status === `plaintext`) {
			if (!includePlaintext) {
				throw new Error(`Backup is plain SQLite and plaintext conversion is disabled.`);
			}

			encryptPlainDatabaseInPlace({
				dbPath: backupPath,
				key: normalizedNewKey,
				root,
			});

			const metadata = writeDatabaseBackupMetadata({
				backupPath,
				key: normalizedNewKey,
				reason: `backup-encrypted`,
				root,
				source,
			});

			return {
				backupPath,
				file: path.basename(backupPath),
				metadata,
				ok: true,
				status: `converted`,
			};
		}

		if (!before.encryptedLikely) {
			throw new Error(`Backup is not a recognizable SQLite database.`);
		}

		if (normalizedOldKey && normalizedOldKey !== normalizedNewKey) {
			rekeyEncryptedDatabase({
				dbPath: backupPath,
				newKey: normalizedNewKey,
				oldKey: normalizedOldKey,
				root,
			});
		} else {
			verifyEncryptedDatabaseFile({
				dbPath: backupPath,
				key: normalizedNewKey,
				root,
			});
		}

		removeDatabaseSidecars(backupPath);

		const metadata = writeDatabaseBackupMetadata({
			backupPath,
			key: normalizedNewKey,
			reason: normalizedOldKey && normalizedOldKey !== normalizedNewKey ? `backup-rekeyed` : `backup-verified`,
			root,
			source,
		});

		return {
			backupPath,
			file: path.basename(backupPath),
			metadata,
			ok: true,
			status: normalizedOldKey && normalizedOldKey !== normalizedNewKey ? `rekeyed` : `verified`,
		};
	} catch (error) {
		try {
			fs.copyFileSync(safetyPath, backupPath);
			removeDatabaseSidecars(backupPath);
		} catch {
			// Preserve the original backup rotation error.
		}

		throw error;
	} finally {
		try {
			fs.rmSync(safetyPath, { force: true });
		} catch {
			// Temporary safety files can be cleaned up by the OS if still locked.
		}
	}
}

// Backup rotation is best-effort across a directory: current-key encrypted
// backups are rekeyed, plaintext backups can be converted, and older-key backups
// are skipped because HachiGen cannot safely guess their missing key.
function rotateDatabaseBackups({
	backupDir = path.resolve(`manager`, `backups`, `database`),
	includePlaintext = true,
	newKey,
	oldKey,
	root = process.cwd(),
	source = `local`,
} = {}) {
	const result = {
		converted: 0,
		entries: [],
		ok: true,
		rekeyed: 0,
		skipped: 0,
		total: 0,
		verified: 0,
	};

	if (!fs.existsSync(backupDir)) {
		return result;
	}

	const files = fs.readdirSync(backupDir)
		.filter(file => /\.sqlite$/iu.test(file))
		.sort((left, right) => left.localeCompare(right));

	result.total = files.length;

	for (const file of files) {
		const backupPath = path.join(backupDir, file);

		try {
			const entry = rotateDatabaseBackupKey({
				backupPath,
				includePlaintext,
				newKey,
				oldKey,
				root,
				source,
			});

			result.entries.push(entry);

			if (entry.status === `converted`) {
				result.converted += 1;
			} else if (entry.status === `rekeyed`) {
				result.rekeyed += 1;
			} else if (entry.status === `verified`) {
				result.verified += 1;
			}
		} catch (error) {
			result.skipped += 1;
			result.entries.push({
				backupPath,
				error: error.message || String(error),
				file,
				ok: false,
				status: `skipped`,
			});
		}
	}

	return result;
}

function databaseBackupRotationSummary(rotation) {
	if (!rotation?.total) {
		return `No database backups found.`;
	}

	const parts = [];

	if (rotation.rekeyed) {
		parts.push(`${rotation.rekeyed} rekeyed`);
	}

	if (rotation.converted) {
		parts.push(`${rotation.converted} encrypted`);
	}

	if (rotation.verified) {
		parts.push(`${rotation.verified} verified`);
	}

	if (rotation.skipped) {
		parts.push(`${rotation.skipped} skipped`);
	}

	return parts.length ?
		`Backups checked: ${parts.join(`, `)}.` :
		`Backups checked: no changes needed.`;
}

// Conversion creates a separate encrypted target first. The caller swaps files
// only after this completes and the encrypted target verifies successfully.
function convertPlainDatabaseToEncrypted({
	key,
	root = process.cwd(),
	sourcePath = path.resolve(`database`, `database.sqlite`),
	targetPath,
} = {}) {
	const normalizedKey = String(key || ``).trim();

	if (!normalizedKey) {
		throw new Error(`No database encryption key is configured.`);
	}

	if (!targetPath) {
		throw new Error(`No encrypted database target path was provided.`);
	}

	const sourceStatus = databaseFileStatus(sourcePath);

	if (sourceStatus.status !== `plaintext`) {
		throw new Error(`Database conversion requires a plain SQLite source. Current status: ${sourceStatus.label}.`);
	}

	if (fs.existsSync(targetPath)) {
		throw new Error(`Encrypted database target already exists: ${targetPath}`);
	}

	const Database = loadCipherDriver(root);
	let sourceDb = null;
	let targetDb = null;
	let committed = false;
	const result = {
		objectsCopied: 0,
		rowsCopied: 0,
		tablesCopied: 0,
		userVersion: 0,
	};

	try {
		sourceDb = new Database(sourcePath, {
			fileMustExist: true,
			readonly: true,
		});
		targetDb = openSqlCipherDatabase({
			dbPath: targetPath,
			fileMustExist: false,
			key: normalizedKey,
			root,
		});
		result.userVersion = Number(sourceDb.pragma(`user_version`, { simple: true }) || 0);

		targetDb.exec(`PRAGMA foreign_keys = OFF`);
		targetDb.exec(`BEGIN IMMEDIATE TRANSACTION`);

		for (const table of getSqliteTables(sourceDb)) {
			targetDb.exec(table.sql);
			result.tablesCopied += 1;
		}

		for (const table of getSqliteTables(sourceDb)) {
			result.rowsCopied += copySqliteRows(sourceDb, targetDb, table.name);
		}

		copySqliteSequence(sourceDb, targetDb);

		for (const object of getSqliteObjects(sourceDb)) {
			targetDb.exec(object.sql);
			result.objectsCopied += 1;
		}

		targetDb.pragma(`user_version = ${Number.isFinite(result.userVersion) ? result.userVersion : 0}`);
		targetDb.exec(`COMMIT`);
		committed = true;
	} catch (err) {
		if (targetDb && !committed) {
			try {
				targetDb.exec(`ROLLBACK`);
			} catch {
				// Preserve the original conversion error.
			}
		}

		throw err;
	} finally {
		if (targetDb) {
			targetDb.close();
		}

		if (sourceDb) {
			sourceDb.close();
		}
	}

	const verification = verifyEncryptedDatabaseFile({
		dbPath: targetPath,
		key: normalizedKey,
		root,
	});

	return {
		...result,
		status: verification.status,
	};
}

function cleanupCipherTestFiles(testDir, dbPath) {
	for (const filePath of [
		dbPath,
		`${dbPath}-wal`,
		`${dbPath}-shm`,
		`${dbPath}-journal`,
	]) {
		try {
			if (fs.existsSync(filePath)) {
				fs.unlinkSync(filePath);
			}
		} catch {
			// Temporary test cleanup should not hide the verification result.
		}
	}

	try {
		fs.rmdirSync(testDir);
	} catch {
		// The OS temp folder can clean up leftovers if a handle is still open.
	}
}

// Driver status is used by HachiGen panels and configCheck messaging. It avoids
// loading the native module unless necessary, because native module mismatches
// are common during Node upgrades and should be reported clearly.
function cipherDriverStatus(root = process.cwd()) {
	try {
		const modulePath = require.resolve(CIPHER_DRIVER_PACKAGE, { paths: [root] });
		const packagePath = findPackageJson(modulePath, CIPHER_DRIVER_PACKAGE);
		const packageJson = packagePath ? JSON.parse(fs.readFileSync(packagePath, `utf8`)) : {};

		return {
			detail: `SQLCipher driver is installed and ready for encrypted database access.`,
			dot: `good`,
			installed: true,
			label: `Driver Installed`,
			modulePath,
			packageName: CIPHER_DRIVER_PACKAGE,
			status: `installed`,
			version: packageJson.version || ``,
		};
	} catch (err) {
		return {
			detail: `${CIPHER_DRIVER_PACKAGE} is not available in node_modules. Install / Validate installs Hachi dependencies normally.`,
			dot: `warn`,
			error: err.code || err.message || String(err),
			installed: false,
			label: `Driver Missing`,
			packageName: CIPHER_DRIVER_PACKAGE,
			status: `missing`,
			version: ``,
		};
	}
}

function verifyCipherDriverCanOpen({ key, root = process.cwd(), tempDir = os.tmpdir() } = {}) {
	const normalizedKey = String(key || ``).trim();
	const driver = cipherDriverStatus(root);

	if (!normalizedKey) {
		return {
			detail: `No database key is configured.`,
			dot: `bad`,
			ok: false,
			label: `Cipher Test Failed`,
			status: `missing-key`,
		};
	}

	if (!driver.installed) {
		return {
			...driver,
			dot: `warn`,
			ok: false,
			label: `Cipher Test Skipped`,
			status: `driver-missing`,
		};
	}

	const testDir = fs.mkdtempSync(path.join(tempDir, `hachi-cipher-test-`));
	const testDbPath = path.join(testDir, `cipher-test.sqlite`);
	let db = null;

	try {
		const Database = loadCipherDriver(root);
		db = new Database(testDbPath);
		applySqlCipherPragmas(db, normalizedKey);
		db.exec(`
			CREATE TABLE cipher_test (
				id INTEGER PRIMARY KEY,
				value TEXT NOT NULL
			);
			INSERT INTO cipher_test (value) VALUES ('ok');
		`);
		db.close();
		db = null;

		const testFileStatus = databaseFileStatus(testDbPath);

		if (!testFileStatus.encryptedLikely) {
			return {
				detail: `Temporary test database still has a plain SQLite header.`,
				dot: `bad`,
				ok: false,
				label: `Cipher Test Failed`,
				status: `plaintext-test-db`,
			};
		}

		db = new Database(testDbPath, {
			fileMustExist: true,
			readonly: true,
		});
		applySqlCipherPragmas(db, normalizedKey);
		const row = db.prepare(`SELECT value FROM cipher_test WHERE id = 1`).get();

		if (row?.value !== `ok`) {
			return {
				detail: `Temporary encrypted database reopened, but the verification row was not readable.`,
				dot: `bad`,
				ok: false,
				label: `Cipher Test Failed`,
				status: `verification-row-mismatch`,
			};
		}

		return {
			detail: `Created and reopened a temporary SQLCipher-compatible database with the configured key.`,
			dot: `good`,
			driverVersion: driver.version,
			ok: true,
			label: `Cipher Test Passed`,
			status: `passed`,
		};
	} catch (err) {
		return {
			detail: err.message || String(err),
			dot: `bad`,
			ok: false,
			label: `Cipher Test Failed`,
			status: `failed`,
		};
	} finally {
		if (db) {
			try {
				db.close();
			} catch {
				// The original verification result is more useful than a close failure.
			}
		}

		cleanupCipherTestFiles(testDir, testDbPath);
	}
}

module.exports = {
	databaseBackupMetadataPath,
	databaseBackupRotationSummary,
	databaseKeyFingerprint,
	databaseKeyFingerprintPreview,
	CIPHER_DRIVER_PACKAGE,
	cipherDriverStatus,
	convertPlainDatabaseToEncrypted,
	databaseAccessStatus,
	databaseFileStatus,
	describeDatabaseBackup,
	isDatabaseProtectionEnabled,
	isEncryptedDatabaseRuntimeEnabled,
	parseDotEnvContent,
	readDatabaseKeyFromEnv,
	readDatabaseBackupMetadata,
	readDatabaseKeyFromEnvFile,
	openSqlCipherDatabase,
	rekeyEncryptedDatabase,
	resolveKeyFilePath,
	rotateDatabaseBackupKey,
	rotateDatabaseBackups,
	verifyEncryptedDatabaseFile,
	verifyCipherDriverCanOpen,
	writeDatabaseBackupMetadata,
};
