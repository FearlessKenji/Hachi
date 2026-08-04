// Configurable source-to-embed-provider hostname mappings for one guild.
module.exports = (sequelize, DataTypes) => sequelize.define(`linkFixRules`, {
	id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
	guildId: { type: DataTypes.STRING, allowNull: false },
	sourceDomain: { type: DataTypes.STRING, allowNull: false },
	targetDomain: { type: DataTypes.STRING, allowNull: false },
	createdBy: { type: DataTypes.STRING, allowNull: true },
	createdAt: { type: DataTypes.DATE, allowNull: false },
}, {
	timestamps: false,
	indexes: [{ unique: true, fields: [`guildId`, `sourceDomain`], name: `linkFixRulesGuildSource` }],
});
