// Stored member birthdays.
//
// Rows are scoped per guild so the same Discord user can have different birthday
// visibility/settings across servers. leftAt suspends one server's participation
// while preserving the row for a seven-day rejoin grace period.
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
		lastUpcomingReminderDate: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		lastBirthdayAnnouncementDate: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		leftAt: {
			type: DataTypes.DATE,
			allowNull: true,
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
			{
				fields: [`leftAt`],
				name: `birthdayUsersLeftAt`,
			},
		],
		timestamps: false,
	});
};
