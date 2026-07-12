// Guild member join event.
//
// Raid protection watches new-member bursts. This event sends joins into the
// raid detector so configured servers can quarantine, alert, and collect evidence
// when a suspicious spike appears.
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
