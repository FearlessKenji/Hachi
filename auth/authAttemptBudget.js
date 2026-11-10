// Reserve a provider OAuth request before sending it. SQLite keeps the last
// six timestamps so a PM2 restart cannot reset the rolling-hour limit.
const { Op, Transaction } = require(`sequelize`);
const { AuthRequestAttempts, sequelize } = require(`../database/dbObjects.js`);

const HOUR_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS_PER_HOUR = 6;
let reservationTail = Promise.resolve();

function reserveAuthAttempt(provider, now = null) {
	// Startup primes Twitch and Kick together. Serialize their short immediate
	// transactions because SQLite accepts only one writer at a time.
	const reservation = reservationTail.then(() => sequelize.transaction(
		{ type: Transaction.TYPES.IMMEDIATE },
		async transaction => {
			// Capture the real attempt time after waiting for the write lock.
			const attemptTime = now || new Date();
			const cutoff = new Date(attemptTime.getTime() - HOUR_MS);
			await AuthRequestAttempts.destroy({
				transaction,
				where: { provider, attemptedAt: { [Op.lte]: cutoff } },
			});
			const recentAttempts = await AuthRequestAttempts.findAll({
				attributes: [`attemptedAt`],
				order: [[`attemptedAt`, `ASC`]],
				raw: true,
				transaction,
				where: { provider },
			});
			if (recentAttempts.length >= MAX_ATTEMPTS_PER_HOUR) {
				const oldestAttempt = new Date(recentAttempts[0].attemptedAt).getTime();
				return { allowed: false, waitMs: Math.max(1, oldestAttempt + HOUR_MS - attemptTime.getTime()) };
			}
			await AuthRequestAttempts.create({ provider, attemptedAt: attemptTime }, { transaction });
			return { allowed: true, waitMs: 0 };
		},
	));
	reservationTail = reservation.catch(() => null);
	return reservation;
}

module.exports = { reserveAuthAttempt };
