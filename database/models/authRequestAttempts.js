// Durable app-token request history enforces the provider retry budget across
// process restarts without storing an access token or client secret.
module.exports = (sequelize, DataTypes) => sequelize.define(`authRequestAttempts`, {
	id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
	provider: { type: DataTypes.STRING, allowNull: false },
	attemptedAt: { type: DataTypes.DATE, allowNull: false },
}, {
	timestamps: false,
	indexes: [
		{ fields: [`provider`, `attemptedAt`], name: `authRequestAttemptsProviderTime` },
	],
});
