module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`raidIncidentFiles`, {
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
		attachmentId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		filename: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		contentType: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		size: {
			type: DataTypes.INTEGER,
			allowNull: false,
			defaultValue: 0,
		},
		hash: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		localPath: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		originalUrl: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		seenCount: {
			type: DataTypes.INTEGER,
			allowNull: false,
			defaultValue: 1,
		},
	}, {
		timestamps: false,
		indexes: [
			{
				fields: [`incidentId`],
			},
			{
				fields: [`guildId`, `hash`],
			},
			{
				fields: [`messageId`],
			},
		],
	});
};
