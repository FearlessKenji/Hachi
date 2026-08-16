// Canonical Twitch verification panel state for each server.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`twitchVerificationPanels`, {
		guildId: {
			type: DataTypes.STRING,
			primaryKey: true,
		},
		channelId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		messageId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		failureCode: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		lastRepairAt: {
			type: DataTypes.DATE,
			allowNull: true,
		},
		warningCount: {
			type: DataTypes.INTEGER,
			allowNull: false,
			defaultValue: 0,
		},
		warningWindowStartedAt: {
			type: DataTypes.DATE,
			allowNull: true,
		},
		warningLastSentAt: {
			type: DataTypes.DATE,
			allowNull: true,
		},
	}, {
		timestamps: false,
	});
};
