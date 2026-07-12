// Stored member birthdays.
//
// Rows are scoped per guild so the same Discord user can have different birthday
// visibility/settings across servers.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`birthdayUsers`, {
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
		month: {
			type: DataTypes.INTEGER,
			allowNull: false,
		},
		day: {
			type: DataTypes.INTEGER,
			allowNull: false,
		},
	},
	{
		indexes: [
			{
				unique: true,
				fields: [`guildId`, `userId`],
			},
			{
				fields: [`guildId`, `month`, `day`],
			},
		],
		timestamps: false,
	});
};
