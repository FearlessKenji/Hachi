/*
 * equivalent to: CREATE TABLE channels (
 * id INTEGER PRIMARY KEY AUTOINCREMENT,
 * channelName VARCHAR(255) NOT NULL,
 * discordUrl VARCHAR(255),
 * isSelf BOOLEAN NOT NULL DEFAULT false,
 * twitchStreamId VARCHAR(255),
 * twitchMessageId VARCHAR(255) UNIQUE,
 * twitchNotif BOOLEAN NOT NULL DEFAULT true
 * kickMessageId VARCHAR(255) UNIQUE,
 * kickIsLive BOOLEAN NOT NULL DEFAULT false,
 * kickNotif BOOLEAN NOT NULL DEFAULT true
 * guildId VARCHAR(255) NOT NULL,
 * UNIQUE (channelName, guildId)
 * );
 */

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
			defaultValue: true,
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
			defaultValue: true,
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
