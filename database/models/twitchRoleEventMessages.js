module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`twitchRoleEventMessages`, {
		messageId: {
			type: DataTypes.STRING,
			primaryKey: true,
		},
		subscriptionType: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		broadcasterTwitchUserId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		twitchUserId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		receivedAt: {
			type: DataTypes.DATE,
			allowNull: false,
		},
	}, {
		timestamps: false,
	});
};
