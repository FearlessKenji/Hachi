// Retain a departing member's birthday for seven days, but stop using it
// immediately for this server's boards and announcements.
const { Events } = require(`discord.js`);
const { markBirthdayMemberLeft } = require(`../utils/birthdays.js`);
const { error } = require(`../utils/writeLog.js`);

module.exports = {
	name: Events.GuildMemberRemove,
	async execute(member) {
		try {
			await markBirthdayMemberLeft(member.client, member.guild.id, member.id);
		} catch (err) {
			error(`Failed to retain a departing member's birthday:`, err, {
				meta: { guildId: member.guild.id, userId: member.id },
				module: `birthday`,
			});
		}
	},
};
