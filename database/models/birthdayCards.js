// Birthday card links prepared by server staff.
//
// Cards are global per user/year. guildId identifies the server that owns card
// management, while deliveryGuildId selects the one server allowed to notify.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`birthdayCards`, {
		id: {
			type: DataTypes.INTEGER,
			autoIncrement: true,
			primaryKey: true,
		},
		guildId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		userId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		year: {
			type: DataTypes.INTEGER,
			allowNull: false,
		},
		url: {
			type: DataTypes.TEXT,
			allowNull: false,
		},
		deliveryUrl: {
			type: DataTypes.TEXT,
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
		updatedAt: {
			type: DataTypes.DATE,
			allowNull: true,
		},
		deliveryGuildId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		notificationDeliveredAt: {
			type: DataTypes.DATE,
			allowNull: true,
		},
	}, {
		timestamps: false,
		indexes: [
			{
				unique: true,
				fields: [`userId`, `year`],
				name: `birthdayCardsUserYear`,
			},
			{
				fields: [`deliveryGuildId`, `year`],
				name: `birthdayCardsDeliveryGuildYear`,
			},
		],
	});
};
