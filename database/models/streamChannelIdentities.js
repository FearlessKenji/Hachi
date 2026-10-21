// Stable provider IDs let Hachi recognize a renamed stream account even when
// the saved login or slug no longer resolves.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`streamChannelIdentities`, {
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		channelId: { type: DataTypes.INTEGER, allowNull: false },
		provider: { type: DataTypes.STRING, allowNull: false },
		providerUserId: { type: DataTypes.STRING, allowNull: false },
		currentName: { type: DataTypes.STRING, allowNull: false },
	}, {
		timestamps: false,
		indexes: [
			{ fields: [`channelId`, `provider`], name: `streamChannelIdentitiesChannelProvider`, unique: true },
		],
	});
};
