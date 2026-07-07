module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`rulesVerificationMessages`, {
		id: {
			type: DataTypes.INTEGER,
			primaryKey: true,
			autoIncrement: true,
		},

		guildId: {
			type: DataTypes.STRING,
			allowNull: false,
		},

		channelId: {
			type: DataTypes.STRING,
			allowNull: false,
		},

		messageId: {
			type: DataTypes.STRING,
			allowNull: false,
		},

		roleId: {
			type: DataTypes.STRING,
			allowNull: false,
		},

		emoji: {
			type: DataTypes.STRING,
			allowNull: false,
		},
	}, {
		timestamps: false,
		indexes: [
			{
				fields: [`guildId`],
			},
			{
				fields: [`channelId`],
			},
			{
				unique: true,
				fields: [`messageId`],
			},
		],
	});
};
