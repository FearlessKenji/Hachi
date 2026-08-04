// Domains synchronized into Hachi's guild AutoMod rule.
module.exports = (sequelize, DataTypes) => sequelize.define(`linkBlockRules`, {
	id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
	guildId: { type: DataTypes.STRING, allowNull: false },
	domain: { type: DataTypes.STRING, allowNull: false },
	createdBy: { type: DataTypes.STRING, allowNull: true },
	createdAt: { type: DataTypes.DATE, allowNull: false },
}, {
	timestamps: false,
	indexes: [{ unique: true, fields: [`guildId`, `domain`], name: `linkBlockRulesGuildDomain` }],
});
