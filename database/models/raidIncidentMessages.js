module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`raidIncidentMessages`, {
		id: {
			type: DataTypes.INTEGER,
			primaryKey: true,
			autoIncrement: true,
		},
		incidentId: {
			type: DataTypes.INTEGER,
			allowNull: false,
		},
		guildId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		messageId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		channelId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		userId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		content: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		contentHash: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		attachmentsJson: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		embedsJson: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		linksJson: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		deletedAt: {
			type: DataTypes.DATE,
			allowNull: true,
		},
		createdAt: {
			type: DataTypes.DATE,
			allowNull: false,
		},
	}, {
		timestamps: false,
		indexes: [
			{
				fields: [`incidentId`],
			},
			{
				unique: true,
				fields: [`incidentId`, `messageId`],
				name: `raidIncidentMessagesIncidentMessage`,
			},
			{
				fields: [`guildId`, `userId`],
			},
		],
	});
};
