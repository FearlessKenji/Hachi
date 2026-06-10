const Sequelize = require(`sequelize`);
const path = require(`path`);

const dbPath = path.join(__dirname, `database.sqlite`);

const sequelize = new Sequelize(`database`, `username`, `password`, {
	host: `localhost`,
	dialect: `sqlite`,
	logging: false,
	storage: dbPath,
});

// =======================
// Models
// =======================
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

// =======================
// Live Notification Associations
// =======================

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

// =======================
// Reaction Role Associations
// =======================

// One guild has many reaction role messages
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

// One reaction role message has many role items
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

module.exports = {
	sequelize,
	Servers,
	Channels,
	SchemaMigrations,
	ReactionRoleMessages,
	ReactionRoleItems,
};
