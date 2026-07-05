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
const CommandMonitorWhitelists = require(`./models/commandMonitorWhitelists.js`)(
	sequelize,
	Sequelize.DataTypes,
);
const RaidConfigs = require(`./models/raidConfigs.js`)(
	sequelize,
	Sequelize.DataTypes,
);
const RaidIncidents = require(`./models/raidIncidents.js`)(
	sequelize,
	Sequelize.DataTypes,
);
const RaidIncidentUsers = require(`./models/raidIncidentUsers.js`)(
	sequelize,
	Sequelize.DataTypes,
);
const RaidIncidentMessages = require(`./models/raidIncidentMessages.js`)(
	sequelize,
	Sequelize.DataTypes,
);
const RaidIncidentFiles = require(`./models/raidIncidentFiles.js`)(
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

// Command Monitoring Associations
// Whitelist rows are guild-scoped and suppress only command-monitoring reports.
Servers.hasMany(CommandMonitorWhitelists, {
	foreignKey: `guildId`,
	sourceKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

CommandMonitorWhitelists.belongsTo(Servers, {
	foreignKey: `guildId`,
	targetKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

// Raid Protection Associations
// Configuration is guild-scoped, while incidents own their captured users,
// messages, and archived attachment records.
Servers.hasOne(RaidConfigs, {
	foreignKey: `guildId`,
	sourceKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

RaidConfigs.belongsTo(Servers, {
	foreignKey: `guildId`,
	targetKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

Servers.hasMany(RaidIncidents, {
	foreignKey: `guildId`,
	sourceKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

RaidIncidents.belongsTo(Servers, {
	foreignKey: `guildId`,
	targetKey: `guildId`,
	onDelete: `RESTRICT`,
	onUpdate: `CASCADE`,
});

RaidIncidents.hasMany(RaidIncidentUsers, {
	foreignKey: `incidentId`,
	sourceKey: `id`,
	onDelete: `CASCADE`,
	onUpdate: `CASCADE`,
});

RaidIncidentUsers.belongsTo(RaidIncidents, {
	foreignKey: `incidentId`,
	targetKey: `id`,
	onDelete: `CASCADE`,
	onUpdate: `CASCADE`,
});

RaidIncidents.hasMany(RaidIncidentMessages, {
	foreignKey: `incidentId`,
	sourceKey: `id`,
	onDelete: `CASCADE`,
	onUpdate: `CASCADE`,
});

RaidIncidentMessages.belongsTo(RaidIncidents, {
	foreignKey: `incidentId`,
	targetKey: `id`,
	onDelete: `CASCADE`,
	onUpdate: `CASCADE`,
});

RaidIncidents.hasMany(RaidIncidentFiles, {
	foreignKey: `incidentId`,
	sourceKey: `id`,
	onDelete: `CASCADE`,
	onUpdate: `CASCADE`,
});

RaidIncidentFiles.belongsTo(RaidIncidents, {
	foreignKey: `incidentId`,
	targetKey: `id`,
	onDelete: `CASCADE`,
	onUpdate: `CASCADE`,
});

module.exports = {
	sequelize,
	Servers,
	Channels,
	ReactionRoleMessages,
	ReactionRoleItems,
	RulesVerificationMessages,
	BirthdayUsers,
	BirthdayConfigs,
	CommandMonitorWhitelists,
	RaidConfigs,
	RaidIncidents,
	RaidIncidentUsers,
	RaidIncidentMessages,
	RaidIncidentFiles,
};
