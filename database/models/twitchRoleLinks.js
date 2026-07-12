// Member-to-Twitch account link.
//
// Verification stores which Discord member corresponds to which Twitch user so
// role sync can evaluate VIP/Moderator membership.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`twitchRoleLinks`, {
		id: {
			type: DataTypes.INTEGER,
			primaryKey: true,
			autoIncrement: true,
		},
		guildId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		discordUserId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		twitchUserId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		twitchLogin: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		twitchDisplayName: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		verifiedAt: {
			type: DataTypes.DATE,
			allowNull: false,
		},
	}, {
		timestamps: false,
		indexes: [
			{
				unique: true,
				fields: [`guildId`, `discordUserId`],
				name: `twitchRoleLinksGuildDiscord`,
			},
			{
				fields: [`guildId`, `twitchUserId`],
				name: `twitchRoleLinksGuildTwitch`,
			},
		],
	});
};
