module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`servers`, {
		guildId: {
			type: DataTypes.STRING,
			primaryKey: true,
		},
		selfTwitchChannelId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		selfKickChannelId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		affiliateChannelId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		selfTwitchRoleId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		selfKickRoleId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		affiliateRoleId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		commandMonitoringEnabled: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: false,
		},
		commandMonitoringChannelId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
	},
	{
		timestamps: false,
	});
};
