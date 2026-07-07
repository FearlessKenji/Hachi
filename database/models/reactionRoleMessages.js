
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`reactionRoleMessages`, {
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
		title: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		description: {
			type: DataTypes.TEXT,
			allowNull: false,
		},
		status: {
			type: DataTypes.ENUM(`active`, `disabled`),
			allowNull: false,
			defaultValue: `active`,
		},
		groupKey: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		panelIndex: {
			type: DataTypes.INTEGER,
			allowNull: false,
			defaultValue: 0,
		},
		imageUrl: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
		thumbnailUrl: {
			type: DataTypes.TEXT,
			allowNull: true,
		},
	},
	{
		timestamps: false,
		indexes: [
			{
				fields: [`guildId`],
			},
			{
				unique: true,
				fields: [`messageId`],
			},
		],
	});
};
