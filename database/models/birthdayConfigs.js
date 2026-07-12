// Per-server birthday announcement configuration.
//
// This stores where birthday reminders/day-of messages go and which timezone/hour
// should be used when the birthday cron checks due posts.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`birthdayConfigs`, {
		guildId: {
			type: DataTypes.STRING,
			primaryKey: true,
		},
		channelId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		weekRoleId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		dayRoleId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		hour: {
			type: DataTypes.INTEGER,
			allowNull: false,
		},
		timezone: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		lastWeekPostDate: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		lastDayPostDate: {
			type: DataTypes.STRING,
			allowNull: true,
		},
	},
	{
		timestamps: false,
	});
};
