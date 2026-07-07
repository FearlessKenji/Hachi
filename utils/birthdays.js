const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
} = require(`discord.js`);
const { DateTime } = require(`luxon`);
const { BirthdayConfigs, BirthdayUsers } = require(`../database/dbObjects.js`);
const { error, warn } = require(`./writeLog.js`);

const RECOCARDS_URL = `https://recocards.com/home`;

const MONTHS = [
	`january`,
	`february`,
	`march`,
	`april`,
	`may`,
	`june`,
	`july`,
	`august`,
	`september`,
	`october`,
	`november`,
	`december`,
];

const MONTH_ALIASES = new Map(
	MONTHS.flatMap((month, index) => [
		[month, index + 1],
		[month.slice(0, 3), index + 1],
	]),
);

function getMonthName(month) {
	return MONTHS[month - 1].replace(/^./, letter => letter.toUpperCase());
}

function stripOrdinal(value) {
	return value.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, `$1`);
}

function isValidBirthday(month, day) {
	if (!Number.isInteger(month) || !Number.isInteger(day)) {
		return false;
	}

	if (month < 1 || month > 12 || day < 1) {
		return false;
	}

	// Use a known leap year for month-length validation so February 29 is accepted.
	// The scheduler later maps leap-day birthdays onto February 28 during non-leap years.
	const daysInMonth = DateTime.local(2024, month).daysInMonth;

	return day <= daysInMonth;
}

function parseBirthdayDate(input) {
	const value = stripOrdinal(input.trim().toLowerCase()).replace(/,/g, ``);
	let match = value.match(/^(\d{1,2})\s*[/-]\s*(\d{1,2})$/);

	if (match) {
		const month = Number.parseInt(match[1], 10);
		const day = Number.parseInt(match[2], 10);

		if (isValidBirthday(month, day)) {
			return { month, day };
		}

		return null;
	}

	match = value.match(/^([a-z]+)\s+(\d{1,2})$/);

	if (match) {
		const month = MONTH_ALIASES.get(match[1]);
		const day = Number.parseInt(match[2], 10);

		if (isValidBirthday(month, day)) {
			return { month, day };
		}
	}

	return null;
}

function parseMonth(input) {
	const value = input.trim().toLowerCase();

	if (/^\d{1,2}$/.test(value)) {
		const month = Number.parseInt(value, 10);

		return month >= 1 && month <= 12 ? month : null;
	}

	return MONTH_ALIASES.get(value) || null;
}

function parseHour(input) {
	const value = input.trim().toLowerCase().replace(/\s+/g, ``);

	if (value === `noon`) {
		return 12;
	}

	if (value === `midnight`) {
		return 0;
	}

	let match = value.match(/^(\d{1,2})(?::00)?(am|pm)$/);

	if (match) {
		let hour = Number.parseInt(match[1], 10);

		if (hour < 1 || hour > 12) {
			return null;
		}

		if (match[2] === `am`) {
			hour = hour === 12 ? 0 : hour;
		} else {
			hour = hour === 12 ? 12 : hour + 12;
		}

		return hour;
	}

	match = value.match(/^(\d{1,2})$/);

	if (match) {
		const hour = Number.parseInt(match[1], 10);

		return hour >= 0 && hour <= 23 ? hour : null;
	}

	return null;
}

function isValidTimezone(timezone) {
	return DateTime.now().setZone(timezone).isValid;
}

function formatBirthday(month, day) {
	return `${getMonthName(month)} ${day}`;
}

function formatMemberList(userIds) {
	if (userIds.length === 1) {
		return `<@${userIds[0]}>`;
	}

	if (userIds.length === 2) {
		return `<@${userIds[0]}> and <@${userIds[1]}>`;
	}

	return `${userIds.slice(0, -1).map(userId => `<@${userId}>`).join(`, `)}, and <@${userIds[userIds.length - 1]}>`;
}

function getAdjustedBirthdayDate(now, month, day) {
	// When a stored birthday is February 29, non-leap years need a real calendar date
	// for reminder matching. This bot celebrates those birthdays on February 28.
	if (month === 2 && day === 29 && !DateTime.local(now.year, 2, 29).isValid) {
		return DateTime.fromObject({ day: 28, month: 2, year: now.year }, { zone: now.zoneName });
	}

	return DateTime.fromObject({ day, month, year: now.year }, { zone: now.zoneName });
}

function groupBirthdaysByDay(birthdays) {
	const groups = new Map();

	for (const birthday of birthdays) {
		const key = `${birthday.month}-${birthday.day}`;

		if (!groups.has(key)) {
			groups.set(key, {
				day: birthday.day,
				month: birthday.month,
				userIds: [],
			});
		}

		groups.get(key).userIds.push(birthday.userId);
	}

	return [...groups.values()].sort((a, b) => a.month - b.month || a.day - b.day);
}

async function fetchBirthdaysForDate(guildId, target) {
	const rows = await BirthdayUsers.findAll({
		order: [[`day`, `ASC`], [`userId`, `ASC`]],
		raw: true,
		where: {
			guildId,
			month: target.month,
			day: target.day,
		},
	});

	if (target.month === 2 && target.day === 28 && !DateTime.local(target.year, 2, 29).isValid) {
		// The direct February 28 query does not find stored February 29 rows, so merge
		// them into the result only in non-leap years.
		const leapRows = await BirthdayUsers.findAll({
			order: [[`day`, `ASC`], [`userId`, `ASC`]],
			raw: true,
			where: {
				guildId,
				month: 2,
				day: 29,
			},
		});

		return [...rows, ...leapRows];
	}

	return rows;
}

function buildWeekContent(config, groups) {
	const roleMention = config.weekRoleId ? `<@&${config.weekRoleId}> ` : ``;
	const lines = groups.map(group => `${formatBirthday(group.month, group.day)}: ${formatMemberList(group.userIds)}`);

	return `${roleMention}Upcoming birthday${groups.length === 1 ? `` : `s`} in one week:\n${lines.join(`\n`)}`;
}

function buildCardButton() {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setLabel(`Create a card`)
			.setStyle(ButtonStyle.Link)
			.setURL(RECOCARDS_URL),
	);
}

function buildDayContent(config, birthdays) {
	const roleMention = config.dayRoleId ? `<@&${config.dayRoleId}> ` : ``;
	const userIds = birthdays.map(birthday => birthday.userId);

	return `${roleMention}Happy birthday to ${formatMemberList(userIds)}!`;
}

async function sendBirthdayMessage(client, config, payload) {
	const guild = client.guilds.cache.get(config.guildId) || await client.guilds.fetch(config.guildId).catch(() => null);

	if (!guild) {
		warn(`Skipping birthday post for unavailable guild ${config.guildId}`);
		return false;
	}

	const channel = guild.channels.cache.get(config.channelId) || await guild.channels.fetch(config.channelId).catch(() => null);

	if (!channel?.send) {
		warn(`Skipping birthday post for guild ${config.guildId}; channel ${config.channelId} is unavailable`);
		return false;
	}

	await channel.send(payload);
	return true;
}

async function processBirthdayConfig(client, config) {
	const now = DateTime.now().setZone(config.timezone);

	// The global cron wakes this checker on a fixed schedule, but each guild owns its
	// local posting hour and timezone in the database. This lets one bot process many
	// servers without rewriting config files or spawning one cron job per server.
	if (!now.isValid || now.hour !== config.hour) {
		return;
	}

	const todayKey = now.toISODate();
	const today = { day: now.day, month: now.month, year: now.year };
	const oneWeekOut = now.plus({ days: 7 });
	const weekTarget = getAdjustedBirthdayDate(oneWeekOut, oneWeekOut.month, oneWeekOut.day);

	if (config.lastWeekPostDate !== todayKey) {
		const weekBirthdays = await fetchBirthdaysForDate(config.guildId, {
			day: weekTarget.day,
			month: weekTarget.month,
			year: weekTarget.year,
		});

		if (weekBirthdays.length) {
			const sent = await sendBirthdayMessage(client, config, {
				components: [buildCardButton()],
				content: buildWeekContent(config, groupBirthdaysByDay(weekBirthdays)),
			});

			if (sent) {
				await config.update({ lastWeekPostDate: todayKey });
			}
		}
	}

	if (config.lastDayPostDate !== todayKey) {
		const dayBirthdays = await fetchBirthdaysForDate(config.guildId, today);

		if (dayBirthdays.length) {
			const sent = await sendBirthdayMessage(client, config, {
				content: buildDayContent(config, dayBirthdays),
			});

			if (sent) {
				await config.update({ lastDayPostDate: todayKey });
			}
		}
	}
}

async function checkBirthdays(client) {
	const configs = await BirthdayConfigs.findAll();

	for (const config of configs) {
		try {
			await processBirthdayConfig(client, config);
		} catch (err) {
			error(`Failed to process birthday config for guild ${config.guildId}:`, err);
		}
	}
}

module.exports = {
	checkBirthdays,
	formatBirthday,
	getMonthName,
	isValidTimezone,
	parseBirthdayDate,
	parseHour,
	parseMonth,
};
