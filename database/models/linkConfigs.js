// Guild-wide switches and Discord AutoMod ownership metadata for link tools.
module.exports = (sequelize, DataTypes) => sequelize.define(`linkConfigs`, {
	guildId: { type: DataTypes.STRING, primaryKey: true },
	fixingEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
	blockingEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
	autoModRuleId: { type: DataTypes.STRING, allowNull: true },
}, { timestamps: false });
