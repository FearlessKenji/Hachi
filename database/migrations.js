const {
	ReactionRoleItems,
	ReactionRoleMessages,
	SchemaMigrations,
	sequelize,
} = require(`./dbObjects.js`);
const { info, warn } = require(`../utils/writeLog.js`);
const path = require(`node:path`);
const fs = require(`node:fs`);

function getModelAttributes(model) {
	return model.getAttributes ? model.getAttributes() : model.rawAttributes;
}

function getColumnName(attributeName, attribute) {
	return attribute.field || attribute.fieldName || attributeName;
}

function getColumnDefinition(attribute) {
	const definition = {
		allowNull: attribute.allowNull,
		autoIncrement: attribute.autoIncrement,
		defaultValue: attribute.defaultValue,
		onDelete: attribute.onDelete,
		onUpdate: attribute.onUpdate,
		primaryKey: attribute.primaryKey,
		references: attribute.references,
		type: attribute.type,
		unique: attribute.unique,
	};

	return Object.fromEntries(
		Object.entries(definition).filter(([, value]) => value !== undefined),
	);
}

function getQueryRows(queryResult) {
	const [rows] = queryResult;

	if (!rows) {
		return [];
	}

	return Array.isArray(rows) ? rows : [rows];
}

function columnsMatch(columns, expectedColumns) {
	return columns.length === expectedColumns.length &&
		columns.every((columnName, index) => columnName === expectedColumns[index]);
}

function getTimestamp() {
	return new Date()
		.toISOString()
		.replace(/\D/g, ``)
		.slice(0, 14);
}

function getBackupLabel(value) {
	return value
		.replace(/[^a-z0-9_-]/gi, `-`)
		.replace(/-+/g, `-`)
		.slice(0, 80);
}

async function backupDatabase(reason) {
	const dbPath = path.resolve(`database/database.sqlite`);

	if (!fs.existsSync(dbPath)) {
		return null;
	}

	await sequelize.query(`PRAGMA wal_checkpoint(FULL)`).catch(() => null);

	const backupPath = path.resolve(
		`database`,
		`database.sqlite.pre-${getBackupLabel(reason)}-${getTimestamp()}`,
	);

	await fs.promises.copyFile(dbPath, backupPath);
	info(`Created database backup ${backupPath}`);

	return backupPath;
}

async function getTableIndexes(tableName) {
	const indexes = getQueryRows(await sequelize.query(`PRAGMA index_list(${tableName})`));
	const details = [];

	for (const index of indexes) {
		const columns = getQueryRows(await sequelize.query(`PRAGMA index_info(${index.name})`))
			.map(column => column.name);

		details.push({
			columns,
			name: index.name,
			unique: Boolean(index.unique),
		});
	}

	return details;
}

async function warnForeignKeyViolations(context) {
	const violations = getQueryRows(await sequelize.query(`PRAGMA foreign_key_check`));

	if (violations.length) {
		warn(`${context} found ${violations.length} foreign key violation(s).`);
	}
}

async function reconcileModelTable(queryInterface, model, ensureBackup) {
	const tableName = model.getTableName();
	const tableLabel = typeof tableName === `string` ? tableName : tableName.tableName;
	const databaseColumns = await queryInterface.describeTable(tableName);
	const modelColumns = new Map(
		Object.entries(getModelAttributes(model))
			.map(([attributeName, attribute]) => [getColumnName(attributeName, attribute), attribute]),
	);

	for (const columnName of Object.keys(databaseColumns)) {
		if (modelColumns.has(columnName)) {
			continue;
		}

		await ensureBackup();
		await queryInterface.removeColumn(tableName, columnName);
		info(`Removed database column ${tableLabel}.${columnName} because it is not in the model schema`);
	}

	for (const [columnName, attribute] of modelColumns) {
		if (Object.prototype.hasOwnProperty.call(databaseColumns, columnName)) {
			continue;
		}

		await queryInterface.addColumn(tableName, columnName, getColumnDefinition(attribute));
		info(`Added missing database column ${tableLabel}.${columnName}`);
	}
}

async function reconcileModelSchemas() {
	const queryInterface = sequelize.getQueryInterface();
	let backedUp = false;
	const ensureBackup = async () => {
		if (backedUp) {
			return;
		}

		backedUp = true;
		await backupDatabase(`schema-reconciliation`);
	};

	await sequelize.query(`PRAGMA foreign_keys = OFF`);

	try {
		for (const model of Object.values(sequelize.models)) {
			await reconcileModelTable(queryInterface, model, ensureBackup);
		}
	} finally {
		await sequelize.query(`PRAGMA foreign_keys = ON`);
	}

	await warnForeignKeyViolations(`Database schema reconciliation`);
}

async function deleteReactionRolePanelRecords(panelIds) {
	if (!panelIds.length) {
		return;
	}

	await ReactionRoleItems.destroy({
		where: { reactionRoleMessageId: panelIds },
	});
	await ReactionRoleMessages.destroy({
		where: { id: panelIds },
	});
}

async function migrateLegacyReactionRoleStates() {
	const deletedPanels = await ReactionRoleMessages.findAll({
		attributes: [`id`],
		raw: true,
		where: { status: `deleted_pending` },
	});
	const deletedPanelIds = deletedPanels.map(panel => panel.id);

	await deleteReactionRolePanelRecords(deletedPanelIds);

	if (deletedPanelIds.length) {
		info(`Deleted ${deletedPanelIds.length} legacy deleted reaction-role panel record(s)`);
	}

	const [updatedCount] = await ReactionRoleMessages.update(
		{ status: `disabled` },
		{ where: { status: `channel_deleted_pending` } },
	);

	if (updatedCount) {
		info(`Marked ${updatedCount} legacy channel-deleted reaction-role panel(s) disabled`);
	}
}

async function migrateChannelsSchema() {
	const foreignKeys = getQueryRows(await sequelize.query(`PRAGMA foreign_key_list(channels)`));
	const serverForeignKey = foreignKeys.find(foreignKey =>
		foreignKey.table === `servers` &&
		foreignKey.from === `guildId`,
	);
	const columns = new Map(
		getQueryRows(await sequelize.query(`PRAGMA table_info(channels)`))
			.map(column => [column.name, column]),
	);
	const notificationDefaultColumns = [`twitchNotif`, `kickNotif`]
		.filter(columnName => columns.has(columnName) && columns.get(columnName).dflt_value !== null);
	const hasCascadingServerDelete = serverForeignKey?.on_delete === `CASCADE`;

	if (!hasCascadingServerDelete && !notificationDefaultColumns.length) {
		return;
	}

	const reasons = [];

	if (hasCascadingServerDelete) {
		reasons.push(`remove cascading server deletes`);
	}

	if (notificationDefaultColumns.length) {
		reasons.push(`remove notification boolean defaults`);
	}

	await backupDatabase(`channels-schema`);
	info(`Rebuilding channels table to ${reasons.join(` and `)}`);
	await sequelize.query(`PRAGMA foreign_keys = OFF`);

	try {
		await sequelize.transaction(async transaction => {
			await sequelize.query(`DROP TABLE IF EXISTS channels_rebuild`, { transaction });
			await sequelize.query(`
				CREATE TABLE channels_rebuild (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					channelName VARCHAR(255) NOT NULL,
					discordUrl VARCHAR(255),
					isSelf TINYINT(1) NOT NULL DEFAULT 0,
					twitchStreamId VARCHAR(255),
					twitchMessageId VARCHAR(255) UNIQUE,
					twitchNotif TINYINT(1) NOT NULL,
					kickMessageId VARCHAR(255) UNIQUE,
					kickIsLive TINYINT(1) NOT NULL DEFAULT 0,
					kickNotif TINYINT(1) NOT NULL,
					guildId VARCHAR(255) NOT NULL REFERENCES servers (guildId) ON DELETE RESTRICT ON UPDATE CASCADE
				)
			`, { transaction });
			await sequelize.query(`
				INSERT INTO channels_rebuild (
					id,
					channelName,
					discordUrl,
					isSelf,
					twitchStreamId,
					twitchMessageId,
					twitchNotif,
					kickMessageId,
					kickIsLive,
					kickNotif,
					guildId
				)
				SELECT
					id,
					channelName,
					discordUrl,
					isSelf,
					twitchStreamId,
					twitchMessageId,
					COALESCE(twitchNotif, 0),
					kickMessageId,
					kickIsLive,
					COALESCE(kickNotif, 0),
					guildId
				FROM channels
			`, { transaction });
			await sequelize.query(`DROP TABLE channels`, { transaction });
			await sequelize.query(`ALTER TABLE channels_rebuild RENAME TO channels`, { transaction });
			await sequelize.query(`
				CREATE UNIQUE INDEX compositeIndex ON channels (channelName, guildId)
			`, { transaction });
			await sequelize.query(`
				UPDATE sqlite_sequence
				SET seq = COALESCE((SELECT MAX(id) FROM channels), 0)
				WHERE name = 'channels'
			`, { transaction });
			await sequelize.query(`
				INSERT OR IGNORE INTO sqlite_sequence (name, seq)
				SELECT 'channels', COALESCE((SELECT MAX(id) FROM channels), 0)
			`, { transaction });
		});
	} finally {
		await sequelize.query(`PRAGMA foreign_keys = ON`);
	}
}

async function migrateReactionRoleItemsSchema() {
	const foreignKeys = getQueryRows(await sequelize.query(`PRAGMA foreign_key_list(reactionRoleItems)`));
	const panelForeignKey = foreignKeys.find(foreignKey =>
		foreignKey.table === `reactionRoleMessages` &&
		foreignKey.from === `reactionRoleMessageId` &&
		foreignKey.to === `id`,
	);
	const indexes = await getTableIndexes(`reactionRoleItems`);
	const hasPanelEmojiUnique = indexes.some(index =>
		index.unique &&
		columnsMatch(index.columns, [`reactionRoleMessageId`, `emoji`]),
	);
	const hasSplitReactionUnique = indexes.some(index =>
		index.unique &&
		(columnsMatch(index.columns, [`reactionRoleMessageId`]) || columnsMatch(index.columns, [`emoji`])),
	);
	const hasMessageEmojiIndex = indexes.some(index =>
		columnsMatch(index.columns, [`messageId`, `emoji`]),
	);
	const hasMessageIdForeignKey = foreignKeys.some(foreignKey => foreignKey.from === `messageId`);

	if (
		panelForeignKey?.on_delete === `CASCADE` &&
		hasPanelEmojiUnique &&
		hasMessageEmojiIndex &&
		!hasSplitReactionUnique &&
		!hasMessageIdForeignKey
	) {
		return;
	}

	await backupDatabase(`reaction-role-items-schema`);
	info(`Rebuilding reactionRoleItems table to repair reaction item constraints and indexes`);
	await sequelize.query(`PRAGMA foreign_keys = OFF`);

	try {
		await sequelize.transaction(async transaction => {
			await sequelize.query(`DROP TABLE IF EXISTS reactionRoleItems_rebuild`, { transaction });
			await sequelize.query(`
				CREATE TABLE reactionRoleItems_rebuild (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					guildId VARCHAR(255) NOT NULL,
					reactionRoleMessageId INTEGER NOT NULL REFERENCES reactionRoleMessages (id) ON DELETE CASCADE ON UPDATE CASCADE,
					roleId VARCHAR(255) NOT NULL,
					label VARCHAR(255) NOT NULL,
					emoji VARCHAR(255),
					messageId VARCHAR(255),
					sortOrder INTEGER NOT NULL DEFAULT 0,
					description VARCHAR(255),
					category VARCHAR(255)
				)
			`, { transaction });
			await sequelize.query(`
				INSERT INTO reactionRoleItems_rebuild (
					id,
					guildId,
					reactionRoleMessageId,
					roleId,
					label,
					emoji,
					messageId,
					sortOrder,
					description,
					category
				)
				SELECT
					id,
					guildId,
					reactionRoleMessageId,
					roleId,
					label,
					emoji,
					messageId,
					sortOrder,
					description,
					category
				FROM reactionRoleItems
			`, { transaction });
			await sequelize.query(`DROP TABLE reactionRoleItems`, { transaction });
			await sequelize.query(`ALTER TABLE reactionRoleItems_rebuild RENAME TO reactionRoleItems`, { transaction });
			await sequelize.query(`
				CREATE INDEX reactionRoleItemsGuildId ON reactionRoleItems (guildId)
			`, { transaction });
			await sequelize.query(`
				CREATE INDEX reactionRoleItemsPanelId ON reactionRoleItems (reactionRoleMessageId)
			`, { transaction });
			await sequelize.query(`
				CREATE INDEX reactionRoleItemsMessageEmoji ON reactionRoleItems (messageId, emoji)
			`, { transaction });
			await sequelize.query(`
				CREATE UNIQUE INDEX reactionRoleItemsPanelEmoji ON reactionRoleItems (reactionRoleMessageId, emoji)
			`, { transaction });
			await sequelize.query(`
				UPDATE sqlite_sequence
				SET seq = COALESCE((SELECT MAX(id) FROM reactionRoleItems), 0)
				WHERE name = 'reactionRoleItems'
			`, { transaction });
			await sequelize.query(`
				INSERT OR IGNORE INTO sqlite_sequence (name, seq)
				SELECT 'reactionRoleItems', COALESCE((SELECT MAX(id) FROM reactionRoleItems), 0)
			`, { transaction });
		});
	} finally {
		await sequelize.query(`PRAGMA foreign_keys = ON`);
	}
}

const migrations = [
	{
		description: `Clean up legacy reaction-role deletion states.`,
		id: `20260609_legacy_reaction_role_state_cleanup`,
		run: migrateLegacyReactionRoleStates,
	},
	{
		description: `Repair channels foreign keys and notification boolean defaults.`,
		id: `20260609_channels_constraints_and_notification_defaults`,
		run: migrateChannelsSchema,
	},
	{
		description: `Repair reaction-role item foreign keys and indexes.`,
		id: `20260609_reaction_role_item_constraints`,
		run: migrateReactionRoleItemsSchema,
	},
];

async function runTrackedMigration(migration) {
	const existingMigration = await SchemaMigrations.findByPk(migration.id);

	if (existingMigration) {
		return;
	}

	await migration.run();
	await SchemaMigrations.create({
		appliedAt: new Date(),
		description: migration.description,
		id: migration.id,
	});
	info(`Recorded database migration ${migration.id}`);
}

async function runMigrations() {
	for (const migration of migrations) {
		await runTrackedMigration(migration);
	}

	await reconcileModelSchemas();
	await warnForeignKeyViolations(`Database migration`);
}

module.exports = {
	runMigrations,
};
