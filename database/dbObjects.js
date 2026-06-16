const Sequelize = require(`sequelize`);
const path = require(`path`);

const dbPath = path.join(__dirname, `database.sqlite`);

const sequelize = new Sequelize(`database`, `username`, `password`, {
	host: `localhost`,
	dialect: `sqlite`,
	logging: false,
	storage: dbPath,
});

// Models
// Every model is registered against the shared Sequelize instance before any
// associations are declared. This keeps sequelize.sync and schema reconciliation
// aware of the full table set on startup.
const Servers = require(`./models/servers.js`)(sequelize, Sequelize.DataTypes);
const Channels = require(`./models/channels.js`)(sequelize, Sequelize.DataTypes);
const SchemaMigrations = require(`./models/schemaMigrations.js`)(
	sequelize,
	Sequelize.DataTypes,
);

const ReactionRoleMessages = require(`./models/reactionRoleMessages.js`)(
	sequelize,
	Sequelize.DataTypes,
);

const ReactionRoleItems = require(`./models/reactionRoleItems.js`)(
	sequelize,
	Sequelize.DataTypes,
);
const RulesVerificationMessages = require(`./models/rulesVerificationMessages.js`)(
	sequelize,
	Sequelize.DataTypes,
);
const BirthdayUsers = require(`./models/birthdayUsers.js`)(
	sequelize,
	Sequelize.DataTypes,
);
const BirthdayConfigs = require(`./models/birthdayConfigs.js`)(
	sequelize,
	Sequelize.DataTypes,
);

// Live Notification Associations
// Channel rows are tied to a server record, but server deletion is restricted so
// notification settings cannot disappear through an accidental cascading delete.
Channels.belongsTo(Servers, {
	foreignKey: `guildId`,
	targetKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

Servers.hasMany(Channels, {
	foreignKey: `guildId`,
	sourceKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

// Reaction Role Associations
// Reaction-role panels own their role items. Deleting a panel cascades to its
// items, while server deletion remains restricted like the notification tables.
Servers.hasMany(ReactionRoleMessages, {
	foreignKey: `guildId`,
	sourceKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

ReactionRoleMessages.belongsTo(Servers, {
	foreignKey: `guildId`,
	targetKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

ReactionRoleMessages.hasMany(ReactionRoleItems, {
	foreignKey: `reactionRoleMessageId`,
	sourceKey: `id`,
	onDelete: `CASCADE`,
	onUpdate: `CASCADE`,
});

ReactionRoleItems.belongsTo(ReactionRoleMessages, {
	foreignKey: `reactionRoleMessageId`,
	targetKey: `id`,
	onDelete: `CASCADE`,
	onUpdate: `CASCADE`,
});

// Rules Verification Associations
// Rules verification rows are lightweight reaction gates for a guild's rules
// message. They are deleted when no longer valid rather than soft-disabled.
Servers.hasMany(RulesVerificationMessages, {
	foreignKey: `guildId`,
	sourceKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

RulesVerificationMessages.belongsTo(Servers, {
	foreignKey: `guildId`,
	targetKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

// Birthday Associations
// Birthday user rows and posting config are guild-scoped. They intentionally
// share the same restricted server relationship used by the other guild data.
Servers.hasMany(BirthdayUsers, {
	foreignKey: `guildId`,
	sourceKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

BirthdayUsers.belongsTo(Servers, {
	foreignKey: `guildId`,
	targetKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

Servers.hasOne(BirthdayConfigs, {
	foreignKey: `guildId`,
	sourceKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

BirthdayConfigs.belongsTo(Servers, {
	foreignKey: `guildId`,
	targetKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

module.exports = {
	sequelize,
	Servers,
	Channels,
	SchemaMigrations,
	ReactionRoleMessages,
	ReactionRoleItems,
	RulesVerificationMessages,
	BirthdayUsers,
	BirthdayConfigs,
};
