// Old birthday boards stay queued until Discord confirms their removal.
module.exports = (sequelize, DataTypes) => sequelize.define(`birthdayBoardRetiredMessages`, {
	messageId: { type: DataTypes.STRING, primaryKey: true },
	guildId: { type: DataTypes.STRING, allowNull: false },
	channelId: { type: DataTypes.STRING, allowNull: false },
}, {
	timestamps: false,
	indexes: [{ fields: [`guildId`], name: `birthdayBoardRetiredMessagesGuildId` }],
});
