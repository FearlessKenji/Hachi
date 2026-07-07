const path = require("node:path");
const { createRequire } = require("node:module");

// This worker is run by the user's normal Node.js process, not Electron.
// That matters because sqlite3 is a native dependency installed for Node.js.
// HachiGen starts this file as a child process and reads one JSON result from
// stdout. Keeping database work here avoids native-module problems in Electron.

// Hachi databases are small, but the viewer still uses a limit so one large
// table cannot freeze the Electron window by returning thousands of rows.
const VIEW_ROW_LIMIT = 200;
const HIDDEN_VIEWER_TABLES = ["schemaMigrations"];
const CHANNEL_ID_GAP_COUNT_SQL = `
	SELECT MAX(
		COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'channels'), 0),
		COALESCE(MAX(id), 0)
	) - COUNT(*) AS count
	FROM channels
`;

// Clean actions are intentionally conservative. They remove or repair rows that
// are internally invalid without calling Discord or guessing at server state.
// Each action has:
// - countSql: a read-only query used for the review popup.
// - sql or apply: the cleanup that runs only after the user confirms it.
// - id: the stable value the renderer sends back when a checkbox is selected.
const CLEAN_ACTIONS = [
	{
		description: "Remove streamer notification rows whose guild no longer exists in the servers table.",
		id: "channels-orphan-guild",
		severity: "warning",
		title: "Streamer rows without a server",
		countSql: `
			SELECT COUNT(*) AS count
			FROM channels
			WHERE guildId IS NULL
				OR TRIM(guildId) = ''
				OR guildId NOT IN (SELECT guildId FROM servers)
		`,
		sql: `
			DELETE FROM channels
			WHERE guildId IS NULL
				OR TRIM(guildId) = ''
				OR guildId NOT IN (SELECT guildId FROM servers);
		`,
	},
	{
		apply: compactChannelIds,
		description: "Renumber streamer notification rows so internal channel IDs are sequential, then reset SQLite's next channel ID.",
		id: "channels-compact-ids",
		severity: "info",
		title: "Streamer row ID gaps",
		countSql: CHANNEL_ID_GAP_COUNT_SQL,
	},
	{
		description: "Remove reaction-role panels whose guild no longer exists, including their role items.",
		id: "reaction-panels-orphan-guild",
		severity: "warning",
		title: "Reaction-role panels without a server",
		countSql: `
			SELECT COUNT(*) AS count
			FROM reactionRoleMessages
			WHERE guildId IS NULL
				OR TRIM(guildId) = ''
				OR guildId NOT IN (SELECT guildId FROM servers)
		`,
		sql: `
			DELETE FROM reactionRoleItems
			WHERE reactionRoleMessageId IN (
				SELECT id FROM reactionRoleMessages
				WHERE guildId IS NULL
					OR TRIM(guildId) = ''
					OR guildId NOT IN (SELECT guildId FROM servers)
			);
			DELETE FROM reactionRoleMessages
			WHERE guildId IS NULL
				OR TRIM(guildId) = ''
				OR guildId NOT IN (SELECT guildId FROM servers);
		`,
	},
	{
		description: "Remove reaction-role items whose parent panel no longer exists.",
		id: "reaction-items-orphan-panel",
		severity: "warning",
		title: "Reaction-role items without a panel",
		countSql: `
			SELECT COUNT(*) AS count
			FROM reactionRoleItems
			WHERE reactionRoleMessageId IS NULL
				OR reactionRoleMessageId NOT IN (SELECT id FROM reactionRoleMessages)
		`,
		sql: `
			DELETE FROM reactionRoleItems
			WHERE reactionRoleMessageId IS NULL
				OR reactionRoleMessageId NOT IN (SELECT id FROM reactionRoleMessages);
		`,
	},
	{
		description: "Match reaction-role item guild IDs to their parent panel guild IDs.",
		id: "reaction-items-guild-mismatch",
		severity: "warning",
		title: "Reaction-role item guild mismatch",
		countSql: `
			SELECT COUNT(*) AS count
			FROM reactionRoleItems AS item
			INNER JOIN reactionRoleMessages AS panel
				ON panel.id = item.reactionRoleMessageId
			WHERE item.guildId IS NULL
				OR TRIM(item.guildId) = ''
				OR item.guildId <> panel.guildId
		`,
		sql: `
			UPDATE reactionRoleItems
			SET guildId = (
				SELECT panel.guildId
				FROM reactionRoleMessages AS panel
				WHERE panel.id = reactionRoleItems.reactionRoleMessageId
			)
			WHERE EXISTS (
				SELECT 1
				FROM reactionRoleMessages AS panel
				WHERE panel.id = reactionRoleItems.reactionRoleMessageId
					AND (
						reactionRoleItems.guildId IS NULL
						OR TRIM(reactionRoleItems.guildId) = ''
						OR reactionRoleItems.guildId <> panel.guildId
					)
			);
		`,
	},
	{
		description: "Disable reaction-role panels that have an invalid status value.",
		id: "reaction-panels-invalid-status",
		severity: "warning",
		title: "Reaction-role panels with invalid status",
		countSql: `
			SELECT COUNT(*) AS count
			FROM reactionRoleMessages
			WHERE status IS NULL
				OR TRIM(status) = ''
				OR status NOT IN ('active', 'disabled')
		`,
		sql: `
			UPDATE reactionRoleMessages
			SET status = 'disabled'
			WHERE status IS NULL
				OR TRIM(status) = ''
				OR status NOT IN ('active', 'disabled');
		`,
	},
	{
		description: "Remove incomplete reaction-role panels and their role items.",
		id: "reaction-panels-incomplete",
		severity: "warning",
		title: "Incomplete reaction-role panels",
		countSql: `
			SELECT COUNT(*) AS count
			FROM reactionRoleMessages
			WHERE guildId IS NULL OR TRIM(guildId) = ''
				OR channelId IS NULL OR TRIM(channelId) = ''
				OR messageId IS NULL OR TRIM(messageId) = ''
				OR title IS NULL OR TRIM(title) = ''
				OR description IS NULL
		`,
		sql: `
			DELETE FROM reactionRoleItems
			WHERE reactionRoleMessageId IN (
				SELECT id FROM reactionRoleMessages
				WHERE guildId IS NULL OR TRIM(guildId) = ''
					OR channelId IS NULL OR TRIM(channelId) = ''
					OR messageId IS NULL OR TRIM(messageId) = ''
					OR title IS NULL OR TRIM(title) = ''
					OR description IS NULL
			);
			DELETE FROM reactionRoleMessages
			WHERE guildId IS NULL OR TRIM(guildId) = ''
				OR channelId IS NULL OR TRIM(channelId) = ''
				OR messageId IS NULL OR TRIM(messageId) = ''
				OR title IS NULL OR TRIM(title) = ''
				OR description IS NULL;
		`,
	},
	{
		description: "Remove rules verification rows whose guild no longer exists.",
		id: "rules-verification-orphan-guild",
		severity: "warning",
		title: "Rules verification rows without a server",
		countSql: `
			SELECT COUNT(*) AS count
			FROM rulesVerificationMessages
			WHERE guildId IS NULL
				OR TRIM(guildId) = ''
				OR guildId NOT IN (SELECT guildId FROM servers)
		`,
		sql: `
			DELETE FROM rulesVerificationMessages
			WHERE guildId IS NULL
				OR TRIM(guildId) = ''
				OR guildId NOT IN (SELECT guildId FROM servers);
		`,
	},
	{
		description: "Remove incomplete rules verification rows that cannot grant roles correctly.",
		id: "rules-verification-incomplete",
		severity: "warning",
		title: "Incomplete rules verification rows",
		countSql: `
			SELECT COUNT(*) AS count
			FROM rulesVerificationMessages
			WHERE guildId IS NULL OR TRIM(guildId) = ''
				OR channelId IS NULL OR TRIM(channelId) = ''
				OR messageId IS NULL OR TRIM(messageId) = ''
				OR roleId IS NULL OR TRIM(roleId) = ''
				OR emoji IS NULL OR TRIM(emoji) = ''
		`,
		sql: `
			DELETE FROM rulesVerificationMessages
			WHERE guildId IS NULL OR TRIM(guildId) = ''
				OR channelId IS NULL OR TRIM(channelId) = ''
				OR messageId IS NULL OR TRIM(messageId) = ''
				OR roleId IS NULL OR TRIM(roleId) = ''
				OR emoji IS NULL OR TRIM(emoji) = '';
		`,
	},
	{
		description: "Remove birthday rows whose guild no longer exists.",
		id: "birthday-users-orphan-guild",
		severity: "warning",
		title: "Birthday users without a server",
		countSql: `
			SELECT COUNT(*) AS count
			FROM birthdayUsers
			WHERE guildId IS NULL
				OR TRIM(guildId) = ''
				OR guildId NOT IN (SELECT guildId FROM servers)
		`,
		sql: `
			DELETE FROM birthdayUsers
			WHERE guildId IS NULL
				OR TRIM(guildId) = ''
				OR guildId NOT IN (SELECT guildId FROM servers);
		`,
	},
	{
		description: "Remove birthday rows with impossible month or day values.",
		id: "birthday-users-invalid-date",
		severity: "warning",
		title: "Birthday users with invalid dates",
		countSql: `
			SELECT COUNT(*) AS count
			FROM birthdayUsers
			WHERE month < 1
				OR month > 12
				OR day < 1
				OR day > CASE month
					WHEN 1 THEN 31
					WHEN 2 THEN 29
					WHEN 3 THEN 31
					WHEN 4 THEN 30
					WHEN 5 THEN 31
					WHEN 6 THEN 30
					WHEN 7 THEN 31
					WHEN 8 THEN 31
					WHEN 9 THEN 30
					WHEN 10 THEN 31
					WHEN 11 THEN 30
					WHEN 12 THEN 31
					ELSE 0
				END
		`,
		sql: `
			DELETE FROM birthdayUsers
			WHERE month < 1
				OR month > 12
				OR day < 1
				OR day > CASE month
					WHEN 1 THEN 31
					WHEN 2 THEN 29
					WHEN 3 THEN 31
					WHEN 4 THEN 30
					WHEN 5 THEN 31
					WHEN 6 THEN 30
					WHEN 7 THEN 31
					WHEN 8 THEN 31
					WHEN 9 THEN 30
					WHEN 10 THEN 31
					WHEN 11 THEN 30
					WHEN 12 THEN 31
					ELSE 0
				END;
		`,
	},
	{
		description: "Remove birthday posting configs whose guild no longer exists.",
		id: "birthday-configs-orphan-guild",
		severity: "warning",
		title: "Birthday configs without a server",
		countSql: `
			SELECT COUNT(*) AS count
			FROM birthdayConfigs
			WHERE guildId IS NULL
				OR TRIM(guildId) = ''
				OR guildId NOT IN (SELECT guildId FROM servers)
		`,
		sql: `
			DELETE FROM birthdayConfigs
			WHERE guildId IS NULL
				OR TRIM(guildId) = ''
				OR guildId NOT IN (SELECT guildId FROM servers);
		`,
	},
	{
		description: "Remove birthday configs with invalid posting hour, timezone, or channel fields.",
		id: "birthday-configs-invalid",
		severity: "warning",
		title: "Invalid birthday configs",
		countSql: `
			SELECT COUNT(*) AS count
			FROM birthdayConfigs
			WHERE channelId IS NULL
				OR TRIM(channelId) = ''
				OR timezone IS NULL
				OR TRIM(timezone) = ''
				OR hour < 0
				OR hour > 23
		`,
		sql: `
			DELETE FROM birthdayConfigs
			WHERE channelId IS NULL
				OR TRIM(channelId) = ''
				OR timezone IS NULL
				OR TRIM(timezone) = ''
				OR hour < 0
				OR hour > 23;
		`,
	},
];

function output(result) {
	// The parent process expects valid JSON on stdout and nothing else.
	// If this worker ever logs plain text here, HachiGen cannot parse the result.
	process.stdout.write(JSON.stringify(result));
}

function quoteIdentifier(value) {
	// SQLite identifiers such as table names need double quotes. Any quote inside
	// the name must be doubled so it cannot break out of the quoted identifier.
	return `"${String(value).replace(/"/g, "\"\"")}"`;
}

function loadSqlite3(root) {
	// sqlite3 is installed in the Hachi root project, not inside HachiGen.
	// createRequire lets this worker load the dependency from that root package.
	const rootRequire = createRequire(path.join(root, "package.json"));
	return rootRequire("sqlite3").verbose();
}

function loadExpectedSchema(root) {
	// Use database/dbAudit.js as the schema source of truth. HachiGen only needs
	// table order and column names for its viewer/sanitize review.
	const rootRequire = createRequire(path.join(root, "package.json"));
	const { EXPECTED_SCHEMA } = rootRequire("./database/dbAudit.js");

	return Object.fromEntries(EXPECTED_SCHEMA.map(tableSpec => [
		tableSpec.name,
		tableSpec.columns.map(column => column.name),
	]));
}

function openDatabase(sqlite3, dbPath, mode = sqlite3.OPEN_READWRITE) {
	// The sqlite3 package uses callbacks, so helpers below wrap those callbacks
	// in Promises. That lets the review/cleanup flow read top-to-bottom.
	return new Promise((resolve, reject) => {
		const db = new sqlite3.Database(dbPath, mode, error => {
			if (error) {
				reject(error);
				return;
			}

			resolve(db);
		});
	});
}

function all(db, sql, params = []) {
	// Run a SELECT query that returns many rows.
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
	// Run a SELECT query that returns a single row.
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
	// Run SQL that does not need returned rows, including multi-statement fixes.
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

function closeDatabase(db) {
	// Always close SQLite cleanly so Windows releases the database file handle.
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

async function countRows(db, sql) {
	// Most review checks return "COUNT(*) AS count"; normalize that value here.
	const row = await get(db, sql);
	return Number(row?.count || 0);
}

async function compactChannelIds(db) {
	// channels.id is an internal SQLite key; the bot relates stream rows by
	// streamer/guild fields, so compacting these IDs does not affect Discord IDs.
	await exec(db, `
		DROP TABLE IF EXISTS temp.channel_id_compaction;
		CREATE TEMP TABLE channel_id_compaction (
			old_id INTEGER PRIMARY KEY,
			new_id INTEGER NOT NULL UNIQUE
		);
		INSERT INTO channel_id_compaction (old_id, new_id)
		SELECT id, ROW_NUMBER() OVER (ORDER BY id)
		FROM channels;

		UPDATE channels
		SET id = -(
			SELECT new_id
			FROM channel_id_compaction
			WHERE old_id = channels.id
		)
		WHERE EXISTS (
			SELECT 1
			FROM channel_id_compaction
			WHERE old_id = channels.id
		);

		UPDATE channels
		SET id = -id
		WHERE id < 0;

		DELETE FROM sqlite_sequence
		WHERE name = 'channels';

		INSERT INTO sqlite_sequence (name, seq)
		SELECT 'channels', COALESCE(MAX(id), 0)
		FROM channels;

		DROP TABLE temp.channel_id_compaction;
	`);
}

async function tableColumns(db, tableName) {
	// PRAGMA table_info returns column metadata in the same order SQLite stores
	// the columns, which is the order the viewer should use for table headers.
	const columns = await all(db, `PRAGMA table_info(${quoteIdentifier(tableName)})`);
	return columns.map(column => column.name);
}

async function tableRowCount(db, tableName) {
	// tableName is quoted as an identifier because SQLite cannot use parameters
	// for table or column names.
	return countRows(db, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(tableName)}`);
}

async function listViewerTables(db, expectedSchema) {
	// Show normal user tables only. Internal sqlite_* tables are implementation
	// details and are not useful in the HachiGen viewer.
	const rows = await all(db, `
		SELECT name
		FROM sqlite_master
		WHERE type = 'table'
			AND name NOT LIKE 'sqlite_%'
	`);
	const expectedOrder = Object.keys(expectedSchema);
	const names = rows
		.map(row => row.name)
		.filter(name => !HIDDEN_VIEWER_TABLES.includes(name));

	names.sort((left, right) => {
		const leftIndex = expectedOrder.indexOf(left);
		const rightIndex = expectedOrder.indexOf(right);

		if (leftIndex !== -1 || rightIndex !== -1) {
			return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
				(rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
		}

		return left.localeCompare(right);
	});

	return Promise.all(names.map(async name => ({
		columns: await tableColumns(db, name),
		name,
		rowCount: await tableRowCount(db, name),
	})));
}

async function readTablePreview(db, requestedTable, sort = {}, expectedSchema) {
	// This is the read-only data viewer used by the Database tab. The selected
	// table and sort column must come from sqlite_master, then they are quoted
	// before querying. User-provided names are never placed directly into SQL.
	const tables = await listViewerTables(db, expectedSchema);
	const tableNames = tables.map(table => table.name);
	const selectedTable = tableNames.includes(requestedTable) ?
		requestedTable :
		tableNames[0] || "";
	const selectedMeta = tables.find(table => table.name === selectedTable) || null;
	const columns = selectedMeta?.columns || [];
	const sortColumn = columns.includes(sort.column) ? sort.column : "";
	const sortDirection = sort.direction === "desc" ? "desc" : sort.direction === "asc" ? "asc" : "";
	const orderClause = sortColumn && sortDirection ?
		` ORDER BY ${quoteIdentifier(sortColumn)} ${sortDirection.toUpperCase()}` :
		"";
	const rows = selectedTable ?
		await all(
			db,
			`SELECT * FROM ${quoteIdentifier(selectedTable)}${orderClause} LIMIT ?`,
			[VIEW_ROW_LIMIT],
		) :
		[];

	return {
		columns,
		limit: VIEW_ROW_LIMIT,
		ok: true,
		rows,
		selectedTable,
		sortColumn,
		sortDirection,
		tables,
		totalRows: selectedMeta?.rowCount || 0,
	};
}

function makeFinding({ cleanable = false, count = 1, description, id, severity, title }) {
	// A finding is what the renderer displays in the Sanitize popup.
	// cleanable=false means "show this to the user, but do not offer a checkbox."
	return {
		cleanable,
		count,
		description,
		id,
		severity,
		title,
	};
}

async function validateSchema(db, findings, expectedSchema) {
	// Compare the current database tables against dbAudit's expected schema. Missing
	// tables/columns are critical because cleanup SQL may not be safe to run.
	for (const [tableName, expectedColumns] of Object.entries(expectedSchema)) {
		const tableRows = await all(
			db,
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
			[tableName],
		);

		if (!tableRows.length) {
			findings.push(makeFinding({
				description: `The ${tableName} table is missing from the database.`,
				id: `schema-missing-table-${tableName}`,
				severity: "critical",
				title: `Missing table: ${tableName}`,
			}));
			continue;
		}

		const columns = await all(db, `PRAGMA table_info(${quoteIdentifier(tableName)})`);
		const columnNames = columns.map(column => column.name);
		const missingColumns = expectedColumns.filter(column => !columnNames.includes(column));
		const extraColumns = columnNames.filter(column => !expectedColumns.includes(column));

		if (missingColumns.length) {
			findings.push(makeFinding({
				count: missingColumns.length,
				description: `Missing columns: ${missingColumns.join(", ")}`,
				id: `schema-missing-columns-${tableName}`,
				severity: "critical",
				title: `Missing columns in ${tableName}`,
			}));
		}

		if (extraColumns.length) {
			findings.push(makeFinding({
				count: extraColumns.length,
				description: `Extra columns: ${extraColumns.join(", ")}`,
				id: `schema-extra-columns-${tableName}`,
				severity: "info",
				title: `Extra columns in ${tableName}`,
			}));
		}
	}
}

async function validateIntegrity(db, findings) {
	// SQLite's built-in checks catch file corruption and broken foreign keys.
	// These are reported before HachiGen looks for higher-level data cleanup.
	const integrityRows = await all(db, "PRAGMA integrity_check");
	const integrityProblems = integrityRows
		.map(row => Object.values(row)[0])
		.filter(value => value && value !== "ok");

	if (integrityProblems.length) {
		findings.push(makeFinding({
			count: integrityProblems.length,
			description: integrityProblems.join("; "),
			id: "integrity-check",
			severity: "critical",
			title: "SQLite integrity check failed",
		}));
	}

	const foreignKeyRows = await all(db, "PRAGMA foreign_key_check");

	if (foreignKeyRows.length) {
		findings.push(makeFinding({
			count: foreignKeyRows.length,
			description: "Foreign key violations were found. Cleanable orphan checks may resolve some of these.",
			id: "foreign-key-check",
			severity: "warning",
			title: "Foreign key violations",
		}));
	}
}

async function addCleanableFindings(db, findings) {
	// Review every conservative cleanup action. At this stage nothing changes;
	// each action is just counted so the user can decide what to clean.
	for (const action of CLEAN_ACTIONS) {
		const count = await countRows(db, action.countSql);

		if (!count) {
			continue;
		}

		findings.push(makeFinding({
			cleanable: true,
			count,
			description: action.description,
			id: action.id,
			severity: action.severity,
			title: action.title,
		}));
	}
}

async function addReviewOnlyFindings(db, findings) {
	// These checks may be useful, but HachiGen should not decide how to fix them.
	// Example: duplicate streamer rows need human judgment about which row wins.
	const notificationlessRows = await countRows(db, `
		SELECT COUNT(*) AS count
		FROM channels
		WHERE COALESCE(twitchNotif, 0) = 0
			AND COALESCE(kickNotif, 0) = 0
	`);

	if (notificationlessRows) {
		findings.push(makeFinding({
			count: notificationlessRows,
			description: "These streamer rows have both Twitch and Kick notifications disabled. Review them in Discord before deciding whether they should stay.",
			id: "channels-no-notifications",
			severity: "info",
			title: "Streamers with no notifications enabled",
		}));
	}

	const duplicateChannels = await countRows(db, `
		SELECT COUNT(*) AS count
		FROM (
			SELECT LOWER(channelName) AS channelKey, guildId
			FROM channels
			GROUP BY LOWER(channelName), guildId
			HAVING COUNT(*) > 1
		)
	`);

	if (duplicateChannels) {
		findings.push(makeFinding({
			count: duplicateChannels,
			description: "Duplicate streamer names were found within the same guild. Review these manually because the correct row to keep depends on notification settings.",
			id: "channels-duplicates",
			severity: "warning",
			title: "Possible duplicate streamers",
		}));
	}
}

function summarizeFindings(findings) {
	// The summary drives the short text shown on the Database tab and modal.
	const cleanableCount = findings.filter(finding => finding.cleanable).length;
	const criticalCount = findings.filter(finding => finding.severity === "critical").length;
	const warningCount = findings.filter(finding => finding.severity === "warning").length;

	return {
		cleanableCount,
		criticalCount,
		findingCount: findings.length,
		status: criticalCount ? "critical" : cleanableCount ? "cleanable" : findings.length ? "review" : "clean",
		warningCount,
	};
}

async function reviewDatabase(db, expectedSchema) {
	// Full review order:
	// 1. Check SQLite integrity.
	// 2. Confirm the schema shape HachiGen expects.
	// 3. If schema is safe, count cleanable and review-only data issues.
	const findings = [];

	await validateIntegrity(db, findings);
	await validateSchema(db, findings, expectedSchema);

	const hasCriticalSchemaProblem = findings.some(finding =>
		finding.severity === "critical" &&
		finding.id.startsWith("schema-"),
	);

	if (!hasCriticalSchemaProblem) {
		// Critical schema problems can make cleanup SQL unsafe. In that case the
		// user sees the schema problem, but HachiGen skips row cleanup suggestions.
		await addCleanableFindings(db, findings);
		await addReviewOnlyFindings(db, findings);
	}

	return {
		findings,
		ok: true,
		reviewedAt: new Date().toISOString(),
		summary: summarizeFindings(findings),
	};
}

async function applyCleanActions(db, actionIds) {
	// Run only the cleanup actions selected in the modal. The caller creates a
	// database backup before this function is reached.
	const actions = CLEAN_ACTIONS.filter(action => actionIds.includes(action.id));
	const applied = [];

	// Some cleanup deletes parent/child rows in deliberate order. Temporarily
	// disabling FK enforcement lets the transaction repair related rows together.
	await exec(db, "PRAGMA foreign_keys = OFF");
	await exec(db, "BEGIN IMMEDIATE TRANSACTION");

	try {
		for (const action of actions) {
			// Count before and after each action so the result can say what changed.
			const before = await countRows(db, action.countSql);
			if (action.apply) {
				await action.apply(db);
			} else {
				await exec(db, action.sql);
			}
			const after = await countRows(db, action.countSql);

			applied.push({
				after,
				before,
				changed: Math.max(0, before - after),
				id: action.id,
				title: action.title,
			});
		}

		await exec(db, "COMMIT");
	} catch (error) {
		await exec(db, "ROLLBACK").catch(() => null);
		throw error;
	} finally {
		await exec(db, "PRAGMA foreign_keys = ON").catch(() => null);
	}

	return applied;
}

async function main() {
	// manager.js passes one JSON argument with action, dbPath, root, and optional
	// actionIds. All success and failure responses are returned through output().
	const request = JSON.parse(process.argv[2] || "{}");
	const sqlite3 = loadSqlite3(request.root);
	const expectedSchema = loadExpectedSchema(request.root);
	const openMode = request.action === "view" ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE;
	const db = await openDatabase(sqlite3, request.dbPath, openMode);

	try {
		if (request.action === "checkpoint") {
			// Flush any WAL sidecar data into the main database file before backup.
			await exec(db, "PRAGMA wal_checkpoint(FULL)");
			output({ ok: true });
			return;
		}

		if (request.action === "review") {
			output(await reviewDatabase(db, expectedSchema));
			return;
		}

		if (request.action === "view") {
			// Return real table data for the read-only Database tab viewer.
			output(await readTablePreview(db, request.table, request.sort, expectedSchema));
			return;
		}

		if (request.action === "apply") {
			// Apply selected fixes, then immediately run a new review so the UI can
			// show the post-cleanup state without needing a second button click.
			const applied = await applyCleanActions(db, request.actionIds || []);
			const review = await reviewDatabase(db, expectedSchema);
			output({
				...review,
				applied,
				message: `Cleaned ${applied.length} database issue group${applied.length === 1 ? "" : "s"}.`,
			});
			return;
		}

		throw new Error(`Unknown database worker action: ${request.action || "none"}`);
	} finally {
		await closeDatabase(db);
	}
}

main().catch(error => {
	// Returning JSON on failure keeps the parent process error handling simple.
	output({
		error: error.message || String(error),
		ok: false,
	});
});
