
module.exports = (sequelize, DataTypes) => {
    return sequelize.define(`reactionRoleMessages`, {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
        },
        guildId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        channelId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        messageId: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        title: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        description: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
    },
        {
            timestamps: false,
            indexes: [
                {
                    fields: ['guildId'],
                },
                {
                    unique: true,
                    fields: ['messageId'],
                },
            ],
        });
};