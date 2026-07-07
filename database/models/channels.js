module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`channels`, {
		id: {
			type: DataTypes.INTEGER,
			primaryKey: true,
			autoIncrement: true,
		},
		channelName: {
			type: DataTypes.STRING,
			allowNull: false,
		},
		discordUrl: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		isSelf: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: false,
		},
		twitchStreamId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		twitchMessageId: {
			type: DataTypes.STRING,
			allowNull: true,
			unique: true,
		},
		twitchNotif: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
		},
		kickMessageId: {
			type: DataTypes.STRING,
			allowNull: true,
			unique: true,
		},
		kickIsLive: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: false,
		},
		kickNotif: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
		},
		guildId: {
			type: DataTypes.STRING,
			allowNull: false,
		},
	}, {
		timestamps: false,
		indexes: [
			{
				unique: true,
				fields: [`channelName`, `guildId`],
				name: `compositeIndex`,
			},
		],
	});
};
