module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`raidIncidents`, {
		id: {
			type: DataTypes.INTEGER,
			primaryKey: true,
			autoIncrement: true,
		},
		guildId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		triggerType: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		status: {
			type: DataTypes.STRING,
			allowNull: false,
			defaultValue: `open`,
		},
		startedAt: {
			type: DataTypes.DATE,
			allowNull: false,
		},
		endedAt: {
			type: DataTypes.DATE,
			allowNull: true,
		},
		summary: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
	}, {
		timestamps: false,
		indexes: [
			{
				fields: [`guildId`, `startedAt`],
			},
			{
				fields: [`guildId`, `status`],
			},
		],
	});
};
