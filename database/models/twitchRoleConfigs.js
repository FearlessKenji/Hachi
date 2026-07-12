// Per-server Twitch role-sync configuration.
//
// Stores broadcaster authorization and Discord role mappings for Twitch VIP and
// Moderator synchronization.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`twitchRoleConfigs`, {
		guildId: {
			type: DataTypes.STRING,
			primaryKey: true,
		},
		broadcasterTwitchUserId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		broadcasterLogin: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		broadcasterDisplayName: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		accessToken: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		refreshToken: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		tokenExpiresAt: {
			type: DataTypes.DATE,
			allowNull: true,
		},
		scopes: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		vipRoleId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		moderatorRoleId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		connectedBy: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		connectedAt: {
			type: DataTypes.DATE,
			allowNull: true,
		},
		lastSyncAt: {
			type: DataTypes.DATE,
			allowNull: true,
		},
	}, {
		timestamps: false,
	});
};
