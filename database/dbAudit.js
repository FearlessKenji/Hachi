const fs = require(`node:fs`);
const path = require(`node:path`);
const sqlite3 = require(`sqlite3`).verbose();

// dbAudit.js is the single database schema audit/migration entry point.
// It can be run by a person from the console and by HachiGen through --json.
// Default mode audits only; --migrate repairs safe drift; --force may drop
// extra columns while preserving as much row data as SQLite constraints allow.

const DB_PATH = path.resolve(`database`, `database.sqlite`);
const MAX_MIGRATION_BACKUPS = 5;

const EXPECTED_SCHEMA = [
	{
		name: `servers`,
		columns: [
			column(`guildId`, `VARCHAR(255)`, { primaryKey: true }),
			column(`selfTwitchChannelId`, `VARCHAR(255)`, { nullable: true }),
			column(`selfKickChannelId`, `VARCHAR(255)`, { nullable: true }),
			column(`affiliateChannelId`, `VARCHAR(255)`, { nullable: true }),
			column(`selfTwitchRoleId`, `VARCHAR(255)`, { nullable: true }),
			column(`selfKickRoleId`, `VARCHAR(255)`, { nullable: true }),
			column(`affiliateRoleId`, `VARCHAR(255)`, { nullable: true }),
			column(`commandMonitoringEnabled`, `TINYINT(1)`, { defaultValue: `0` }),
			column(`commandMonitoringChannelId`, `VARCHAR(255)`, { nullable: true }),
		],
		indexes: [],
	},
	{
		name: `channels`,
		columns: [
			column(`id`, `INTEGER`, { autoIncrement: true, primaryKey: true }),
			column(`channelName`, `VARCHAR(255)`),
			column(`discordUrl`, `VARCHAR(255)`, { nullable: true }),
			column(`isSelf`, `TINYINT(1)`, { defaultValue: `0` }),
			column(`twitchStreamId`, `VARCHAR(255)`, { nullable: true }),
			column(`twitchMessageId`, `VARCHAR(255)`, { nullable: true }),
			column(`twitchNotif`, `TINYINT(1)`),
			column(`kickMessageId`, `VARCHAR(255)`, { nullable: true }),
			column(`kickIsLive`, `TINYINT(1)`, { defaultValue: `0` }),
			column(`kickNotif`, `TINYINT(1)`),
			column(`guildId`, `VARCHAR(255)`, { references: `servers (guildId) ON DELETE RESTRICT ON UPDATE CASCADE` }),
		],
		indexes: [
			index(`compositeIndex`, [`channelName`, `guildId`], { unique: true }),
		],
	},
	{
		name: `reactionRoleMessages`,
		columns: [
			column(`id`, `INTEGER`, { autoIncrement: true, primaryKey: true }),
			column(`guildId`, `VARCHAR(255)`, { references: `servers (guildId) ON DELETE RESTRICT ON UPDATE CASCADE` }),
			column(`channelId`, `VARCHAR(255)`),
			column(`messageId`, `VARCHAR(255)`),
			column(`title`, `VARCHAR(255)`),
			column(`description`, `TEXT`),
			column(`status`, `TEXT`, { defaultValue: `'active'`, expression: `CASE WHEN "status" IN ('active', 'disabled') THEN "status" ELSE 'disabled' END` }),
			column(`groupKey`, `VARCHAR(255)`, { nullable: true }),
			column(`panelIndex`, `INTEGER`, { defaultValue: `0` }),
			column(`imageUrl`, `TEXT`, { nullable: true }),
			column(`thumbnailUrl`, `TEXT`, { nullable: true }),
		],
		indexes: [
			index(`reactionRoleMessagesGuildId`, [`guildId`]),
			index(`reactionRoleMessagesMessageId`, [`messageId`], { unique: true }),
		],
	},
	{
		name: `reactionRoleItems`,
		columns: [
			column(`id`, `INTEGER`, { autoIncrement: true, primaryKey: true }),
			column(`guildId`, `VARCHAR(255)`),
			column(`reactionRoleMessageId`, `INTEGER`, { references: `reactionRoleMessages (id) ON DELETE CASCADE ON UPDATE CASCADE` }),
			column(`messageId`, `VARCHAR(255)`, { nullable: true }),
			column(`roleId`, `VARCHAR(255)`),
			column(`label`, `VARCHAR(255)`),
			column(`emoji`, `VARCHAR(255)`, { nullable: true }),
			column(`sortOrder`, `INTEGER`, { defaultValue: `0` }),
			column(`category`, `VARCHAR(255)`, { nullable: true }),
		],
		indexes: [
			index(`reactionRoleItemsGuildId`, [`guildId`]),
			index(`reactionRoleItemsPanelId`, [`reactionRoleMessageId`]),
			index(`reactionRoleItemsMessageEmoji`, [`messageId`, `emoji`]),
			index(`reactionRoleItemsPanelEmoji`, [`reactionRoleMessageId`, `emoji`], { unique: true }),
		],
	},
	{
		name: `rulesVerificationMessages`,
		columns: [
			column(`id`, `INTEGER`, { autoIncrement: true, primaryKey: true }),
			column(`guildId`, `VARCHAR(255)`, { references: `servers (guildId) ON DELETE RESTRICT ON UPDATE CASCADE` }),
			column(`channelId`, `VARCHAR(255)`),
			column(`messageId`, `VARCHAR(255)`),
			column(`roleId`, `VARCHAR(255)`),
			column(`emoji`, `VARCHAR(255)`),
		],
		indexes: [
			index(`rulesVerificationMessagesGuildId`, [`guildId`]),
			index(`rulesVerificationMessagesChannelId`, [`channelId`]),
			index(`rulesVerificationMessagesMessageId`, [`messageId`], { unique: true }),
		],
	},
	{
		name: `birthdayUsers`,
		columns: [
			column(`id`, `INTEGER`, { autoIncrement: true, primaryKey: true }),
			column(`guildId`, `VARCHAR(255)`, { references: `servers (guildId) ON DELETE RESTRICT ON UPDATE CASCADE` }),
			column(`userId`, `VARCHAR(255)`),
			column(`month`, `INTEGER`),
			column(`day`, `INTEGER`),
		],
		indexes: [
			index(`birthdayUsersGuildUser`, [`guildId`, `userId`], { unique: true }),
			index(`birthdayUsersGuildDate`, [`guildId`, `month`, `day`]),
		],
	},
	{
		name: `birthdayConfigs`,
		columns: [
			column(`guildId`, `VARCHAR(255)`, { primaryKey: true, references: `servers (guildId) ON DELETE RESTRICT ON UPDATE CASCADE` }),
			column(`channelId`, `VARCHAR(255)`),
			column(`weekRoleId`, `VARCHAR(255)`, { nullable: true }),
			column(`dayRoleId`, `VARCHAR(255)`, { nullable: true }),
			column(`hour`, `INTEGER`),
			column(`timezone`, `VARCHAR(255)`),
			column(`lastWeekPostDate`, `VARCHAR(255)`, { nullable: true }),
			column(`lastDayPostDate`, `VARCHAR(255)`, { nullable: true }),
		],
		indexes: [],
	},
];

const LEGACY_INTERNAL_TABLES = [`schemaMigrations`];

function column(name, type, options = {}) {
	return {
		autoIncrement: false,
		defaultValue: null,
		expression: null,
		nullable: false,
		primaryKey: false,
		references: null,
		type,
		...options,
		name,
	};
}

function index(name, columns, options = {}) {
	return {
		columns,
		name,
		unique: false,
		...options,
	};
}

function quoteIdentifier(value) {
	return `"${String(value).replace(/"/g, `""`)}"`;
}

function openDatabase(dbPath = DB_PATH) {
	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, error => {
			if (error) {
				reject(error);
				return;
			}

			resolve(db);
		});
	});
}

function closeDatabase(db) {
	return new Promise((resolve, reject) => {
		db.close(error => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}

function all(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (error, rows) => {
			if (error) {
				reject(error);
				return;
			}

			resolve(rows || []);
		});
	});
}

function get(db, sql, params = []) {
	return new Promise((resolve, reject) => {
		db.get(sql, params, (error, row) => {
			if (error) {
				reject(error);
				return;
			}

			resolve(row || null);
		});
	});
}

function exec(db, sql) {
	return new Promise((resolve, reject) => {
		db.exec(sql, error => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}

async function rowCount(db, tableName) {
	const row = await get(db, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`);
	return Number(row?.count || 0);
}

async function nullCount(db, tableName, columnName) {
	const row = await get(db, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(columnName)} IS NULL`);
	return Number(row?.count || 0);
}

function backupTimestamp() {
	return new Date()
		.toISOString()
		.replace(/\D/g, ``)
		.slice(0, 14);
}

function migrationBackupName() {
	return `migration-${backupTimestamp()}.sqlite`;
}

async function backupDatabase(dbPath = DB_PATH) {
	if (!fs.existsSync(dbPath)) {
		return null;
	}

	const backupDir = path.join(path.dirname(dbPath), `backups`, `migrations`);
	fs.mkdirSync(backupDir, { recursive: true });

	const backupPath = path.join(backupDir, migrationBackupName());
	await fs.promises.copyFile(dbPath, backupPath);
	await rotateMigrationBackups(backupDir);
	return backupPath;
}

async function rotateMigrationBackups(backupDir) {
	if (!fs.existsSync(backupDir)) {
		return;
	}

	const backups = fs.readdirSync(backupDir)
		.filter(file => /^migration-\d{14}\.sqlite$/u.test(file))
		.map(file => {
			const fullPath = path.join(backupDir, file);
			return {
				file,
				fullPath,
				mtimeMs: fs.statSync(fullPath).mtimeMs,
			};
		})
		.sort((left, right) => right.mtimeMs - left.mtimeMs);

	for (const backup of backups.slice(MAX_MIGRATION_BACKUPS)) {
		fs.rmSync(backup.fullPath, { force: true });
	}
}

function createColumnSql(spec) {
	const parts = [quoteIdentifier(spec.name), spec.type];

	if (spec.primaryKey) {
		parts.push(`PRIMARY KEY`);
	}

	if (spec.autoIncrement) {
		parts.push(`AUTOINCREMENT`);
	}

	if (!spec.primaryKey && !spec.nullable) {
		parts.push(`NOT NULL`);
	}

	if (spec.defaultValue !== null) {
		parts.push(`DEFAULT ${spec.defaultValue}`);
	}

	if (spec.references) {
		parts.push(`REFERENCES ${spec.references}`);
	}

	return parts.join(` `);
}

function createTableSql(tableSpec, extraColumns = []) {
	const columnSql = [
		...tableSpec.columns.map(createColumnSql),
		...extraColumns.map(createPreservedColumnSql),
	];

	return `CREATE TABLE ${quoteIdentifier(tableSpec.name)} (${columnSql.join(`, `)})`;
}

function createPreservedColumnSql(columnInfo) {
	const parts = [quoteIdentifier(columnInfo.name), columnInfo.type || `TEXT`];

	if (columnInfo.notnull) {
		parts.push(`NOT NULL`);
	}

	if (columnInfo.dflt_value !== null && columnInfo.dflt_value !== undefined) {
		parts.push(`DEFAULT ${columnInfo.dflt_value}`);
	}

	return parts.join(` `);
}

function createIndexSql(tableName, indexSpec) {
	const unique = indexSpec.unique ? `UNIQUE ` : ``;
	const columns = indexSpec.columns.map(quoteIdentifier).join(`, `);
	return `CREATE ${unique}INDEX IF NOT EXISTS ${quoteIdentifier(indexSpec.name)} ON ${quoteIdentifier(tableName)} (${columns})`;
}

function fallbackExpression(spec) {
	if (spec.defaultValue !== null) {
		return spec.defaultValue;
	}

	if (spec.nullable) {
		return `NULL`;
	}

	if (/INT|REAL|NUM|BOOL|TINYINT/iu.test(spec.type)) {
		return `0`;
	}

	return `''`;
}

function copyExpression(spec, existingColumnNames, force) {
	if (!existingColumnNames.includes(spec.name)) {
		return `${fallbackExpression(spec)} AS ${quoteIdentifier(spec.name)}`;
	}

	if (spec.expression) {
		return `${spec.expression} AS ${quoteIdentifier(spec.name)}`;
	}

	if (force && !spec.nullable && !spec.primaryKey) {
		return `COALESCE(${quoteIdentifier(spec.name)}, ${fallbackExpression(spec)}) AS ${quoteIdentifier(spec.name)}`;
	}

	return quoteIdentifier(spec.name);
}

function columnsByName(columns) {
	return new Map(columns.map(currentColumn => [currentColumn.name, currentColumn]));
}

async function tableInfo(db, tableName) {
	return all(db, `PRAGMA table_info(${quoteIdentifier(tableName)})`);
}

async function tableExists(db, tableName) {
	const row = await get(
		db,
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
		[tableName],
	);

	return Boolean(row);
}

async function listTables(db) {
	const rows = await all(db, `
		SELECT name
		FROM sqlite_master
		WHERE type = 'table'
			AND name NOT LIKE 'sqlite_%'
	`);

	return rows.map(row => row.name);
}

async function getIndexes(db, tableName) {
	const indexes = await all(db, `PRAGMA index_list(${quoteIdentifier(tableName)})`);
	const details = [];

	for (const currentIndex of indexes) {
		const columns = await all(db, `PRAGMA index_info(${quoteIdentifier(currentIndex.name)})`);

		details.push({
			columns: columns.map(columnInfo => columnInfo.name),
			name: currentIndex.name,
			unique: Boolean(currentIndex.unique),
		});
	}

	return details;
}

async function uniqueConflictCount(db, tableName, columns) {
	const where = columns
		.map(columnName => `${quoteIdentifier(columnName)} IS NOT NULL`)
		.join(` AND `);
	const groupedColumns = columns.map(quoteIdentifier).join(`, `);
	const row = await get(db, `
		SELECT COUNT(*) AS count
		FROM (
			SELECT ${groupedColumns}
			FROM ${quoteIdentifier(tableName)}
			WHERE ${where}
			GROUP BY ${groupedColumns}
			HAVING COUNT(*) > 1
		)
	`);

	return Number(row?.count || 0);
}

function hasMatchingIndex(indexes, expectedIndex) {
	return indexes.some(currentIndex =>
		currentIndex.unique === expectedIndex.unique &&
		currentIndex.columns.length === expectedIndex.columns.length &&
		currentIndex.columns.every((columnName, position) => columnName === expectedIndex.columns[position]),
	);
}

async function getForeignKeys(db, tableName) {
	return all(db, `PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`);
}

function expectedForeignKey(columnSpec) {
	if (!columnSpec.references) {
		return null;
	}

	const match = columnSpec.references.match(/^(\w+)\s+\((\w+)\)\s+ON DELETE\s+(\w+)\s+ON UPDATE\s+(\w+)$/iu);

	if (!match) {
		return null;
	}

	return {
		from: columnSpec.name,
		onDelete: match[3].toUpperCase(),
		onUpdate: match[4].toUpperCase(),
		table: match[1],
		to: match[2],
	};
}

function hasExpectedForeignKey(foreignKeys, columnSpec) {
	const expected = expectedForeignKey(columnSpec);

	if (!expected) {
		return true;
	}

	return foreignKeys.some(currentForeignKey =>
		currentForeignKey.from === expected.from &&
		currentForeignKey.table === expected.table &&
		currentForeignKey.to === expected.to &&
		String(currentForeignKey.on_delete || ``).toUpperCase() === expected.onDelete &&
		String(currentForeignKey.on_update || ``).toUpperCase() === expected.onUpdate,
	);
}

function addIssue(collection, issue) {
	collection.push({
		count: 1,
		...issue,
	});
}

async function auditTable(db, tableSpec, report) {
	if (!await tableExists(db, tableSpec.name)) {
		addIssue(report.safeIssues, {
			id: `${tableSpec.name}:missing-table`,
			message: `Missing table ${tableSpec.name}.`,
			table: tableSpec.name,
			type: `missing-table`,
		});
		return;
	}

	const currentColumns = await tableInfo(db, tableSpec.name);
	const currentColumnNames = currentColumns.map(currentColumn => currentColumn.name);
	const currentColumnMap = columnsByName(currentColumns);
	const count = await rowCount(db, tableSpec.name);

	for (const expectedColumn of tableSpec.columns) {
		const currentColumn = currentColumnMap.get(expectedColumn.name);

		if (!currentColumn) {
			const safe = expectedColumn.nullable || expectedColumn.defaultValue !== null || count === 0;
			addIssue(safe ? report.safeIssues : report.forceIssues, {
				id: `${tableSpec.name}:${expectedColumn.name}:missing-column`,
				message: `Missing column ${tableSpec.name}.${expectedColumn.name}.`,
				table: tableSpec.name,
				type: `missing-column`,
			});
			continue;
		}

		if (!expectedColumn.nullable && !expectedColumn.primaryKey && !currentColumn.notnull) {
			const nulls = await nullCount(db, tableSpec.name, expectedColumn.name);
			addIssue(nulls ? report.forceIssues : report.safeIssues, {
				count: Math.max(1, nulls),
				id: `${tableSpec.name}:${expectedColumn.name}:nullable-column`,
				message: `${tableSpec.name}.${expectedColumn.name} should be NOT NULL.`,
				table: tableSpec.name,
				type: `nullable-column`,
			});
		}

		const currentDefault = currentColumn.dflt_value === null || currentColumn.dflt_value === undefined ?
			null :
			String(currentColumn.dflt_value);

		if (currentDefault !== expectedColumn.defaultValue) {
			addIssue(report.safeIssues, {
				id: `${tableSpec.name}:${expectedColumn.name}:default-mismatch`,
				message: `${tableSpec.name}.${expectedColumn.name} default does not match the expected schema.`,
				table: tableSpec.name,
				type: `default-mismatch`,
			});
		}
	}

	for (const columnName of currentColumnNames) {
		if (!tableSpec.columns.some(expectedColumn => expectedColumn.name === columnName)) {
			addIssue(report.driftIssues, {
				id: `${tableSpec.name}:${columnName}:extra-column`,
				message: `Extra column ${tableSpec.name}.${columnName} will be left alone unless force migration is used.`,
				table: tableSpec.name,
				type: `extra-column`,
			});
		}
	}

	const indexes = await getIndexes(db, tableSpec.name);

	for (const expectedIndex of tableSpec.indexes) {
		if (hasMatchingIndex(indexes, expectedIndex)) {
			continue;
		}

		const conflicts = expectedIndex.unique ?
			await uniqueConflictCount(db, tableSpec.name, expectedIndex.columns) :
			0;

		addIssue(conflicts ? report.forceIssues : report.safeIssues, {
			count: Math.max(1, conflicts),
			id: `${tableSpec.name}:${expectedIndex.name}:index-mismatch`,
			message: `Missing or incorrect index ${expectedIndex.name} on ${tableSpec.name}.`,
			table: tableSpec.name,
			type: `index-mismatch`,
		});
	}

	const foreignKeys = await getForeignKeys(db, tableSpec.name);

	for (const expectedColumn of tableSpec.columns) {
		if (!hasExpectedForeignKey(foreignKeys, expectedColumn)) {
			addIssue(report.safeIssues, {
				id: `${tableSpec.name}:${expectedColumn.name}:foreign-key-mismatch`,
				message: `${tableSpec.name}.${expectedColumn.name} foreign key does not match the expected schema.`,
				table: tableSpec.name,
				type: `foreign-key-mismatch`,
			});
		}
	}
}

function summarizeReport(report) {
	if (report.errorIssues.length) {
		return {
			detail: `${report.errorIssues.length} database error issue(s).`,
			dot: `bad`,
			label: `Error`,
			status: `error`,
		};
	}

	if (!report.exists) {
		return {
			detail: `No database file found.`,
			dot: `muted`,
			label: `Not Created`,
			status: `missing`,
		};
	}

	if (report.forceIssues.length) {
		return {
			detail: `${report.forceIssues.length} destructive migration issue(s).`,
			dot: `bad`,
			label: `Force Needed`,
			status: `force-required`,
		};
	}

	if (report.safeIssues.length) {
		return {
			detail: `${report.safeIssues.length} safe migration issue(s).`,
			dot: `warn`,
			label: `Needs Migration`,
			status: `migration-required`,
		};
	}

	if (report.driftIssues.length) {
		return {
			detail: `Compatible extra schema ignored.`,
			dot: `good`,
			label: `Ready`,
			status: `compatible-drift`,
		};
	}

	return {
		detail: `Schema compatible.`,
		dot: `good`,
		label: `Ready`,
		status: `ok`,
	};
}

async function auditDatabase({ dbPath = DB_PATH } = {}) {
	const report = {
		backupPath: null,
		checkedAt: new Date().toISOString(),
		dbPath,
		driftIssues: [],
		errorIssues: [],
		exists: fs.existsSync(dbPath),
		forceIssues: [],
		ok: true,
		safeIssues: [],
	};

	if (!report.exists) {
		return {
			...report,
			...summarizeReport(report),
			forceMigrationAvailable: false,
			migrationAvailable: false,
		};
	}

	const db = await openDatabase(dbPath);

	try {
		const integrityRows = await all(db, `PRAGMA integrity_check`);
		const integrityProblems = integrityRows
			.map(row => Object.values(row)[0])
			.filter(value => value && value !== `ok`);

		for (const problem of integrityProblems) {
			addIssue(report.errorIssues, {
				id: `integrity-check`,
				message: `SQLite integrity check failed: ${problem}`,
				type: `integrity`,
			});
		}

		for (const tableSpec of EXPECTED_SCHEMA) {
			await auditTable(db, tableSpec, report);
		}

		const tables = await listTables(db);

		for (const legacyTable of LEGACY_INTERNAL_TABLES) {
			if (tables.includes(legacyTable)) {
				addIssue(report.safeIssues, {
					id: `${legacyTable}:legacy-internal-table`,
					message: `Legacy internal table ${legacyTable} can be removed.`,
					table: legacyTable,
					type: `legacy-internal-table`,
				});
			}
		}
	} finally {
		await closeDatabase(db);
	}

	const summary = summarizeReport(report);

	return {
		...report,
		...summary,
		forceMigrationAvailable: report.forceIssues.length > 0,
		migrationAvailable: report.safeIssues.length > 0 && report.errorIssues.length === 0 && report.forceIssues.length === 0,
	};
}

function needsTableRebuild(report, tableSpec, force) {
	if (force) {
		return true;
	}

	return report.safeIssues.some(issue => {
		if (issue.table !== tableSpec.name) {
			return false;
		}

		if ([`nullable-column`, `default-mismatch`, `foreign-key-mismatch`, `index-mismatch`].includes(issue.type)) {
			return true;
		}

		if (issue.type !== `missing-column`) {
			return false;
		}

		const expectedColumn = tableSpec.columns.find(columnSpec => issue.id === `${tableSpec.name}:${columnSpec.name}:missing-column`);
		return Boolean(expectedColumn && !expectedColumn.nullable && expectedColumn.defaultValue === null);
	});
}

async function createMissingTable(db, tableSpec) {
	await exec(db, createTableSql(tableSpec));

	for (const expectedIndex of tableSpec.indexes) {
		await exec(db, createIndexSql(tableSpec.name, expectedIndex));
	}
}

async function addMissingColumns(db, tableSpec, report) {
	const missingColumnIssues = report.safeIssues.filter(issue =>
		issue.table === tableSpec.name &&
		issue.type === `missing-column`,
	);

	if (!missingColumnIssues.length) {
		return;
	}

	const columns = await tableInfo(db, tableSpec.name);
	const existingColumnNames = columns.map(currentColumn => currentColumn.name);

	for (const issue of missingColumnIssues) {
		const expectedColumn = tableSpec.columns.find(columnSpec => issue.id === `${tableSpec.name}:${columnSpec.name}:missing-column`);

		if (!expectedColumn || existingColumnNames.includes(expectedColumn.name)) {
			continue;
		}

		if (!expectedColumn.nullable && expectedColumn.defaultValue === null) {
			continue;
		}

		await exec(db, `ALTER TABLE ${quoteIdentifier(tableSpec.name)} ADD COLUMN ${createColumnSql(expectedColumn)}`);
	}
}

async function rebuildTable(db, tableSpec, { force = false } = {}) {
	const rebuildName = `${tableSpec.name}_audit_rebuild`;
	const currentColumns = await tableInfo(db, tableSpec.name);
	const existingColumnNames = currentColumns.map(currentColumn => currentColumn.name);
	const expectedColumnNames = tableSpec.columns.map(columnSpec => columnSpec.name);
	const extraColumns = force ?
		[] :
		currentColumns.filter(currentColumn => !expectedColumnNames.includes(currentColumn.name));
	const insertColumns = [
		...expectedColumnNames,
		...extraColumns.map(currentColumn => currentColumn.name),
	];
	const selectColumns = [
		...tableSpec.columns.map(columnSpec => copyExpression(columnSpec, existingColumnNames, force)),
		...extraColumns.map(currentColumn => quoteIdentifier(currentColumn.name)),
	];

	await exec(db, `DROP TABLE IF EXISTS ${quoteIdentifier(rebuildName)}`);
	await exec(db, createTableSql({ ...tableSpec, name: rebuildName }, extraColumns));

	if (existingColumnNames.length) {
		await exec(db, `
			INSERT OR ${force ? `IGNORE` : `ABORT`} INTO ${quoteIdentifier(rebuildName)} (${insertColumns.map(quoteIdentifier).join(`, `)})
			SELECT ${selectColumns.join(`, `)}
			FROM ${quoteIdentifier(tableSpec.name)}
		`);
	}

	await exec(db, `DROP TABLE ${quoteIdentifier(tableSpec.name)}`);
	await exec(db, `ALTER TABLE ${quoteIdentifier(rebuildName)} RENAME TO ${quoteIdentifier(tableSpec.name)}`);

	for (const expectedIndex of tableSpec.indexes) {
		await exec(db, createIndexSql(tableSpec.name, expectedIndex));
	}
}

async function applyMigration({ force = false, dbPath = DB_PATH } = {}) {
	const report = await auditDatabase({ dbPath });

	if (!report.exists) {
		return {
			...report,
			message: `No database exists to migrate.`,
			ok: false,
		};
	}

	if (report.errorIssues.length) {
		return {
			...report,
			message: `Database errors must be repaired before migration.`,
			ok: false,
		};
	}

	if (report.forceIssues.length && !force) {
		return {
			...report,
			forceMigrationAvailable: true,
			message: `Safe migration cannot continue because destructive changes are required. Run npm run db:migrate:force to force migration.`,
			ok: false,
		};
	}

	if (!force && !report.safeIssues.length) {
		return {
			...report,
			message: report.driftIssues.length ?
				`Database is functionally compatible. Extra schema was left alone.` :
				`Database schema is already compatible.`,
			ok: true,
		};
	}

	const backupPath = await backupDatabase(dbPath);
	const db = await openDatabase(dbPath);

	try {
		await exec(db, `PRAGMA foreign_keys = OFF`);
		await exec(db, `BEGIN IMMEDIATE TRANSACTION`);

		for (const tableSpec of EXPECTED_SCHEMA) {
			if (!await tableExists(db, tableSpec.name)) {
				await createMissingTable(db, tableSpec);
				continue;
			}

			if (needsTableRebuild(report, tableSpec, force)) {
				await rebuildTable(db, tableSpec, { force });
			} else {
				await addMissingColumns(db, tableSpec, report);

				for (const expectedIndex of tableSpec.indexes) {
					await exec(db, createIndexSql(tableSpec.name, expectedIndex));
				}
			}
		}

		for (const legacyTable of LEGACY_INTERNAL_TABLES) {
			if (await tableExists(db, legacyTable)) {
				await exec(db, `DROP TABLE ${quoteIdentifier(legacyTable)}`);
			}
		}

		await exec(db, `COMMIT`);
	} catch (error) {
		await exec(db, `ROLLBACK`).catch(() => null);
		throw error;
	} finally {
		await exec(db, `PRAGMA foreign_keys = ON`).catch(() => null);
		await closeDatabase(db);
	}

	const updatedReport = await auditDatabase({ dbPath });

	return {
		...updatedReport,
		backupPath,
		message: force ?
			`Force migration complete. Backup created at ${backupPath}.` :
			`Safe migration complete. Backup created at ${backupPath}.`,
		ok: true,
	};
}

async function auditDatabaseStartup({ dbPath = DB_PATH } = {}) {
	const report = await auditDatabase({ dbPath });

	if ([`migration-required`, `force-required`, `error`].includes(report.status)) {
		console.warn(`[Warning] Database schema mismatch. Run npm run db:migrate to migrate.`);
	}

	return report;
}

function cliArgs(argv) {
	return {
		force: argv.includes(`--force`),
		json: argv.includes(`--json`),
		migrate: argv.includes(`--migrate`) || argv.includes(`--force`),
	};
}

function humanIssueList(title, issues) {
	if (!issues.length) {
		return [];
	}

	return [
		`${title}:`,
		...issues.map(issue => `- ${issue.message}`),
	];
}

function printHumanResult(result) {
	const lines = [
		`Database audit: ${result.label}`,
		result.detail,
		...humanIssueList(`Safe migration issues`, result.safeIssues || []),
		...humanIssueList(`Force migration issues`, result.forceIssues || []),
		...humanIssueList(`Compatible drift`, result.driftIssues || []),
		...humanIssueList(`Errors`, result.errorIssues || []),
		result.backupPath ? `Backup: ${result.backupPath}` : null,
		result.message || null,
	].filter(Boolean);

	console.log(lines.join(`\n`));
}

function setFailureExitCode() {
	process.exitCode = 1;
}

async function runCli() {
	const args = cliArgs(process.argv.slice(2));
	let result = null;

	try {
		result = args.migrate ?
			await applyMigration({ force: args.force }) :
			await auditDatabase();
	} catch (error) {
		result = {
			error: error.message || String(error),
			ok: false,
		};
	}

	if (args.json) {
		process.stdout.write(JSON.stringify(result));
	} else {
		printHumanResult(result);
	}

	if (result?.ok === false) {
		setFailureExitCode();
	}
}

if (require.main === module) {
	runCli();
}

module.exports = {
	auditDatabase,
	auditDatabaseStartup,
	applyMigration,
	EXPECTED_SCHEMA,
};
