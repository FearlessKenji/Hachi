// Discord server/guild record.
//
// Most feature tables key back to guildId. The leftAt field lets Hachi remember
// servers it has left without immediately deleting their configuration.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`servers`, {
		guildId: {
			type: DataTypes.STRING,
			primaryKey: true,
		},
		leftAt: {
			type: DataTypes.DATE,
			allowNull: true,
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
		hachiAnnouncementChannelId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		hachiAnnouncementLastId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
	},
	{
		timestamps: false,
	});
};
