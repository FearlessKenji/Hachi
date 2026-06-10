module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`schemaMigrations`, {
		id: {
			type: DataTypes.STRING,
			primaryKey: true,
		},
		description: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		appliedAt: {
			type: DataTypes.DATE,
			allowNull: false,
			defaultValue: DataTypes.NOW,
		},
	}, {
		timestamps: false,
	});
};
