module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`reactionRoleItems`, {
		id: {
			type: DataTypes.INTEGER,
			primaryKey: true,
			autoIncrement: true,
		},

		guildId: {
			type: DataTypes.STRING,
			allowNull: false,
		},

		reactionRoleMessageId: {
			type: DataTypes.INTEGER,
			allowNull: false,
		},

		messageId: {
			type: DataTypes.STRING,
			allowNull: true,
		},

		roleId: {
			type: DataTypes.STRING,
			allowNull: false,
		},

		label: {
			type: DataTypes.STRING,
			allowNull: false,
		},

		emoji: {
			type: DataTypes.STRING,
			allowNull: true,
		},

		sortOrder: {
			type: DataTypes.INTEGER,
			allowNull: false,
			defaultValue: 0,
		},

		category: {
			type: DataTypes.STRING,
			allowNull: true,
		},
	}, {
		timestamps: false,

		indexes: [
			{
				name: `reactionRoleItemsGuildId`,
				fields: [`guildId`],
			},
			{
				name: `reactionRoleItemsPanelId`,
				fields: [`reactionRoleMessageId`],
			},
			{
				name: `reactionRoleItemsMessageEmoji`,
				fields: [`messageId`, `emoji`],
			},
			{
				name: `reactionRoleItemsPanelEmoji`,
				unique: true,
				fields: [`reactionRoleMessageId`, `emoji`],
			},
		],
	});
};
