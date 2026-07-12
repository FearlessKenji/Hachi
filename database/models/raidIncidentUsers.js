// Member captured as part of a raid incident.
//
// This lets reports list who joined during the detection window and what action
// Hachi attempted for each member.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`raidIncidentUsers`, {
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
		userId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		displayName: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		username: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		joinedAt: {
			type: DataTypes.DATE,
			allowNull: true,
		},
		actionTaken: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		actionError: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		releasedAt: {
			type: DataTypes.DATE,
			allowNull: true,
		},
	}, {
		timestamps: false,
		indexes: [
			{
				fields: [`incidentId`],
			},
			{
				fields: [`guildId`, `userId`],
			},
		],
	});
};
