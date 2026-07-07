const { RulesVerificationMessages } = require(`../database/dbObjects.js`);
const { roleIsAssignable } = require(`./reactionRoles.js`);

const RULES_VERIFICATION_EMOJI = `✅`;

async function fetchReactionMessage(reaction) {
	if (reaction.partial) {
		await reaction.fetch().catch(() => null);
	}

	if (reaction.message?.partial) {
		await reaction.message.fetch().catch(() => null);
	}

	return reaction.message || null;
}

async function handleRulesVerificationReaction(reaction, user, shouldAdd) {
	if (user.bot) {
		return false;
	}

	const message = await fetchReactionMessage(reaction);

	if (!message?.id) {
		return false;
	}

	const verification = await RulesVerificationMessages.findOne({
		where: {
			emoji: reaction.emoji.toString(),
			messageId: message.id,
		},
	});

	if (!verification) {
		return false;
	}

	const guild = await message.client.guilds.fetch(verification.guildId).catch(() => null);

	if (!guild) {
		return true;
	}

	await guild.roles.fetch().catch(() => null);
	await guild.members.fetchMe().catch(() => null);

	const member = await guild.members.fetch(user.id).catch(() => null);
	const role = guild.roles.cache.get(verification.roleId);

	if (!member || !roleIsAssignable(guild, role)) {
		return true;
	}

	if (shouldAdd) {
		if (!member.roles.cache.has(role.id)) {
			await member.roles.add(role);
		}

		return true;
	}

	if (member.roles.cache.has(role.id)) {
		await member.roles.remove(role);
	}

	return true;
}

module.exports = {
	RULES_VERIFICATION_EMOJI,
	handleRulesVerificationReaction,
};
