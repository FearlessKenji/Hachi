// Keep Kick's exact live start time beside its active Discord announcement.
// The formatted embed footer only records a minute and can hide quick restarts.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`kickLiveSessions`, {
		channelId: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false },
		messageId: { type: DataTypes.STRING, allowNull: false },
		startTime: { type: DataTypes.DATE, allowNull: false },
	}, {
		timestamps: false,
	});
};
