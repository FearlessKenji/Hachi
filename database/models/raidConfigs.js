// Per-server raid-protection configuration.
//
// The raid runtime reads this policy to decide thresholds, quarantine behavior,
// alert destinations, report destinations, and cleanup behavior.
module.exports = (sequelize, DataTypes) => {
	return sequelize.define(`raidConfigs`, {
		guildId: {
			type: DataTypes.STRING,
			primaryKey: true,
		},
		enabled: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: false,
		},
		quarantineRoleId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		alertChannelId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		reportChannelId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		moderatorRoleId: {
			type: DataTypes.STRING,
			allowNull: true,
		},
		messageSpamCount: {
			type: DataTypes.INTEGER,
			allowNull: false,
			defaultValue: 5,
		},
		messageSpamSeconds: {
			type: DataTypes.INTEGER,
			allowNull: false,
			defaultValue: 5,
		},
		joinSpikeCount: {
			type: DataTypes.INTEGER,
			allowNull: false,
			defaultValue: 5,
		},
		joinSpikeSeconds: {
			type: DataTypes.INTEGER,
			allowNull: false,
			defaultValue: 5,
		},
		actionQuarantine: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: true,
		},
		actionTimeout: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: false,
		},
		actionDelete: {
			type: DataTypes.BOOLEAN,
			allowNull: false,
			defaultValue: true,
		},
		timeoutMinutes: {
			type: DataTypes.INTEGER,
			allowNull: false,
			defaultValue: 60,
		},
	}, {
		timestamps: false,
	});
};
