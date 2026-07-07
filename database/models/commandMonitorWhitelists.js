module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`commandMonitorWhitelists`, {
		id: {
			type: DataTypes.INTEGER,
			primaryKey: true,
			autoIncrement: true,
		},
		guildId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		type: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		targetId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		label: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		createdBy: {
			type: DataTypes.STRING,
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
				unique: true,
				fields: [`guildId`, `type`, `targetId`],
				name: `commandMonitorWhitelistsGuildTypeTarget`,
			},
			{
				fields: [`guildId`, `type`],
				name: `commandMonitorWhitelistsGuildType`,
			},
		],
	});
};
