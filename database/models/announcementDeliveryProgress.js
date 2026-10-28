// One durable outbound patch-note delivery checkpoint per Discord server.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`announcementDeliveryProgress`, {
		guildId: { type: DataTypes.STRING, primaryKey: true },
		progressJson: { type: DataTypes.TEXT, allowNull: false },
	}, {
		tableName: `announcementDeliveryProgress`,
		timestamps: false,
	});
};
