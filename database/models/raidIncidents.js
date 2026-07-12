// Raid incident summary.
//
// A row is created when the raid detector decides a join spike crossed the
// configured threshold. Child rows store users, messages, and evidence files.
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
