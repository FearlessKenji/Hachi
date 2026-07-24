// Birthday card links prepared by server staff.
//
// Cards are scoped to one user's birthday in one server/year so upcoming-card
// signing can stay hidden from the birthday person until their actual birthday.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`birthdayCards`, {
		id: {
			type: DataTypes.INTEGER,
			autoIncrement: true,
			primaryKey: true,
		},
		guildId: {
			type: DataTypes.STRING,
			allowNull: false,
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
	}, {
		timestamps: false,
		indexes: [
			{
				unique: true,
				fields: [`guildId`, `userId`, `year`],
				name: `birthdayCardsGuildUserYear`,
			},
			{
				fields: [`guildId`, `year`],
				name: `birthdayCardsGuildYear`,
			},
		],
	});
};
