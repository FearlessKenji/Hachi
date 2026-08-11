// Durable ticket state keeps close cleanup and stored transcripts restart-safe.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`modmailTickets`, {
		id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
		guildId: { type: DataTypes.STRING, allowNull: false },
		ticketNumber: { type: DataTypes.INTEGER, allowNull: false },
		channelId: { type: DataTypes.STRING, allowNull: true },
		openerId: { type: DataTypes.STRING, allowNull: false },
		status: { type: DataTypes.STRING, allowNull: false, defaultValue: `open` },
		openedAt: { type: DataTypes.DATE, allowNull: false },
		closedAt: { type: DataTypes.DATE, allowNull: true },
		closedBy: { type: DataTypes.STRING, allowNull: true },
		deleteAt: { type: DataTypes.DATE, allowNull: true },
		storedAt: { type: DataTypes.DATE, allowNull: true },
		storedBy: { type: DataTypes.STRING, allowNull: true },
		transcript: { type: DataTypes.TEXT, allowNull: true },
	}, {
		timestamps: false,
		indexes: [
			{ fields: [`guildId`, `ticketNumber`], name: `modmailTicketsGuildNumber`, unique: true },
			{ fields: [`guildId`, `openerId`, `status`], name: `modmailTicketsGuildOpenerStatus` },
			{ fields: [`channelId`], name: `modmailTicketsChannel`, unique: true },
			{ fields: [`status`, `deleteAt`], name: `modmailTicketsStatusDeleteAt` },
		],
	});
};
