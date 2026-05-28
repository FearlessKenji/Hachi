/*
 * equivalent to: CREATE TABLE servers (
 * guildId VARCHAR(255) PRIMARY KEY,
 * selfChannelId VARCHAR(255),
 * affiliateChannelId VARCHAR(255),
 * selfRoleId VARCHAR(255),
 * affiliateRoleId VARCHAR(255)
 * );
 */
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
	},
	{
		timestamps: false,
	});
};