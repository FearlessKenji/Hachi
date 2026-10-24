// Ended announcements wait here until the matching provider replay is available.
// Each message keeps its provider identity and detected end time separately,
// so a new stream cannot cancel its lookup and the six-hour cutoff survives restarts.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`pendingStreamVods`, {
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		channelId: { type: DataTypes.INTEGER, allowNull: false },
		provider: { type: DataTypes.STRING, allowNull: false },
		discordChannelId: { type: DataTypes.STRING, allowNull: false },
		messageId: { type: DataTypes.STRING, allowNull: false },
		streamId: { type: DataTypes.STRING, allowNull: true },
		providerUserId: { type: DataTypes.STRING, allowNull: true },
		providerName: { type: DataTypes.STRING, allowNull: true },
		startLabel: { type: DataTypes.STRING, allowNull: true },
		// Kick needs the precise provider start to distinguish rapid restarts.
		providerStartTime: { type: DataTypes.DATE, allowNull: true },
		endedAt: { type: DataTypes.DATE, allowNull: false },
	}, {
		timestamps: false,
		indexes: [
			{ fields: [`messageId`], name: `pendingStreamVodsMessageId`, unique: true },
			{ fields: [`provider`, `channelId`], name: `pendingStreamVodsProviderChannel` },
		],
	});
};
