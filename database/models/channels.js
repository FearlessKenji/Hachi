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
			unique: true, // Ensure globally unique
		},
		twitchNotif: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: false,
		},
		kickMessageId: {
			type: DataTypes.STRING,
			allowNull: true,
			unique: true, // Ensure globally unique
		},
		kickIsLive: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: false,
		},
		kickNotif: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: false,
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
				fields: [`channelName`, `guildId`], // Composite unique index
				name: `compositeIndex`,
			},
		],
	});
};
