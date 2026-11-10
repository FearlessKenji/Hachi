// Guild member join event.
//
// New joins feed raid protection and reactivate birthdays retained during the
// seven-day departure grace period.
const { Events } = require(`discord.js`);
const { observeGuildMemberAdd } = require(`../utils/raidProtection.js`);
const { markBirthdayMemberJoined } = require(`../utils/birthdays.js`);
const { error } = require(`../utils/writeLog.js`);

module.exports = {
	name: Events.GuildMemberAdd,

	async execute(member) {
		try {
			await observeGuildMemberAdd(member);
		} catch (err) {
			error(`Failed to process raid join monitor:`, err, {
				meta: {
					guildId: member.guild?.id || null,
					userId: member.id,
				},
				module: `raid`,
			});
		}

		try {
			await markBirthdayMemberJoined(member.client, member.guild.id, member.id, {
				joinedAt: member.joinedAt || new Date(),
			});
		} catch (err) {
			error(`Failed to restore birthday after a member rejoined:`, err, {
				meta: { guildId: member.guild.id, userId: member.id },
				module: `birthday`,
			});
		}
	},
};
