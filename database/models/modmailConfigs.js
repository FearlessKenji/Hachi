// Per-server Modmail configuration and ticket-number allocator.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`modmailConfigs`, {
		guildId: { type: DataTypes.STRING, primaryKey: true },
		entryChannelId: { type: DataTypes.STRING, allowNull: true },
		panelMessageId: { type: DataTypes.STRING, allowNull: true },
		ticketCategoryId: { type: DataTypes.STRING, allowNull: true },
		pingRoleIdsJson: { type: DataTypes.TEXT, allowNull: false, defaultValue: `[]` },
		allowedRoleIdsJson: { type: DataTypes.TEXT, allowNull: false, defaultValue: `[]` },
		maxStoredTickets: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 50 },
		nextTicketNumber: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
	}, { timestamps: false });
};
