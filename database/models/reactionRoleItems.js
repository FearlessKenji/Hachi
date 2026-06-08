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

        componentType: {
            type: DataTypes.ENUM(`button`, `select`),
            allowNull: false,
        },

        customId: {
            type: DataTypes.STRING,
            allowNull: false,
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
    }, {
        timestamps: false,

        indexes: [
            {
                fields: [`guildId`],
            },
            {
                fields: [`reactionRoleMessageId`],
            },
            {
                unique: true,
                fields: [`reactionRoleMessageId`, `customId`],
            },
        ],
    });
};