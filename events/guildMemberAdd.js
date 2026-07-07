const { Events } = require(`discord.js`);
const { observeGuildMemberAdd } = require(`../utils/raidProtection.js`);
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
	},
};
