// Birthday feature helpers.
//
// Commands store birthdays, and the birthday cron asks this module which users
// need reminder/day-of messages for a server's configured timezone and hour.
const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
} = require(`discord.js`);
const { URL } = require(`node:url`);
const { DateTime } = require(`luxon`);
const { BirthdayCards, BirthdayConfigs, BirthdayUsers } = require(`../database/dbObjects.js`);
const { error, warn } = require(`./writeLog.js`);

const UPCOMING_BIRTHDAY_DAYS = 14;
const BIRTHDAY_BOARD_COLOR = 0xf0b83a;
const RECOCARDS_CREATE_URL = `https://recocards.com/home`;
const CARD_URL_HOSTS = new Set([
	`recocards.com`,
	`www.recocards.com`,
]);

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

function normalizeRecoCardsUrl(input, pathPrefix) {
	const value = input.trim();

	let parsed;

	try {
		parsed = new URL(value);
	} catch {
		return null;
	}

	if (parsed.protocol !== `https:` || !CARD_URL_HOSTS.has(parsed.hostname.toLowerCase())) {
		return null;
	}

	if (!parsed.pathname.startsWith(pathPrefix)) {
		return null;
	}

	parsed.hash = ``;

	return parsed.toString();
}

function normalizeBirthdayCardUrl(input) {
	return normalizeRecoCardsUrl(input, `/board/`);
}

function deriveBirthdayDeliveryUrl(input) {
	const normalizedUrl = normalizeBirthdayCardUrl(input);

	if (!normalizedUrl) {
		return null;
	}

	const parsed = new URL(normalizedUrl);

	parsed.pathname = parsed.pathname.replace(/^\/board\//u, `/view/b/`);

	return parsed.toString();
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

function getBirthdayDateForYear(timezone, year, month, day) {
	const anchor = DateTime.fromObject({ day: 1, month: 1, year }, { zone: timezone });

	return getAdjustedBirthdayDate(anchor, month, day).startOf(`day`);
}

function getNextBirthdayDate(now, birthday) {
	const today = now.startOf(`day`);
	let nextBirthday = getBirthdayDateForYear(now.zoneName, now.year, birthday.month, birthday.day);

	if (nextBirthday < today) {
		nextBirthday = getBirthdayDateForYear(now.zoneName, now.year + 1, birthday.month, birthday.day);
	}

	return nextBirthday;
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

function buildCreateCardButton() {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setLabel(`Create a card`)
			.setStyle(ButtonStyle.Link)
			.setURL(RECOCARDS_CREATE_URL),
	);
}

function formatDaysAway(daysAway) {
	if (daysAway === 0) {
		return `today`;
	}

	if (daysAway === 1) {
		return `tomorrow`;
	}

	return `in ${daysAway} days`;
}

function truncateFieldValue(value) {
	if (value.length <= 1000) {
		return value;
	}

	return `${value.slice(0, 997)}...`;
}

async function fetchMemberDisplay(guild, userId) {
	const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);

	return {
		displayName: member?.displayName || member?.user?.username || userId,
		mention: `<@${userId}>`,
	};
}

async function getUpcomingBirthdayEntries(guild, config, options = {}) {
	const timezone = config.timezone || `UTC`;
	const now = options.now || DateTime.now().setZone(timezone);
	const days = options.days ?? UPCOMING_BIRTHDAY_DAYS;
	const today = now.startOf(`day`);
	const cutoff = today.plus({ days });
	const birthdays = await BirthdayUsers.findAll({
		order: [[`month`, `ASC`], [`day`, `ASC`], [`userId`, `ASC`]],
		raw: true,
		where: {
			guildId: config.guildId,
		},
	});

	const entries = birthdays
		.map(birthday => {
			const date = getNextBirthdayDate(now, birthday);
			const daysAway = Math.floor(date.diff(today, `days`).days);

			return {
				...birthday,
				date,
				daysAway,
				year: date.year,
			};
		})
		.filter(entry => entry.date <= cutoff)
		.sort((left, right) => left.date.toMillis() - right.date.toMillis() || left.userId.localeCompare(right.userId));

	if (!entries.length) {
		return [];
	}

	const years = [...new Set(entries.map(entry => entry.year))];
	const cards = await BirthdayCards.findAll({
		raw: true,
		where: {
			guildId: config.guildId,
			year: years,
		},
	});
	const cardByUserYear = new Map(cards.map(card => [`${card.userId}:${card.year}`, card]));

	return Promise.all(entries.map(async entry => {
		const display = await fetchMemberDisplay(guild, entry.userId);

		return {
			...entry,
			...display,
			card: cardByUserYear.get(`${entry.userId}:${entry.year}`) || null,
		};
	}));
}

function formatBoardEntry(entry) {
	const dateLabel = entry.daysAway === 0 ?
		`Today` :
		`${entry.date.toFormat(`MMM d`)} (${formatDaysAway(entry.daysAway)})`;

	return `**${dateLabel}** - ${entry.mention}`;
}

function buildBirthdayBoardEmbed(guild, now, entries) {
	const todayEntries = entries.filter(entry => entry.daysAway === 0);
	const upcomingEntries = entries.filter(entry => entry.daysAway > 0);
	const todayText = todayEntries.length ?
		todayEntries.map(formatBoardEntry).join(`\n`) :
		`No birthdays today.`;
	const upcomingText = upcomingEntries.length ?
		upcomingEntries.map(formatBoardEntry).join(`\n`) :
		`No upcoming birthdays in the next two weeks.`;

	return new EmbedBuilder()
		.setColor(BIRTHDAY_BOARD_COLOR)
		.setTitle(`Birthday Board`)
		.setDescription(`Use the buttons below to add your birthday or sign an upcoming card.`)
		.addFields(
			{ name: `Today`, value: truncateFieldValue(todayText) },
			{ name: `Next Two Weeks`, value: truncateFieldValue(upcomingText) },
		)
		.setFooter({
			text: `${guild.name} - Updated ${now.toFormat(`MMM d, h:mm a ZZZZ`)}`,
		});
}

function buildBirthdayPanelComponents() {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`birthday:panel:set`)
			.setLabel(`Set / Update Birthday`)
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder()
			.setCustomId(`birthday:panel:sign`)
			.setLabel(`Sign Upcoming Card`)
			.setStyle(ButtonStyle.Secondary),
	);
}

async function buildBirthdayBoardPayload(guild, config, options = {}) {
	const now = options.now || DateTime.now().setZone(config.timezone || `UTC`);
	const entries = await getUpcomingBirthdayEntries(guild, config, {
		days: options.days ?? UPCOMING_BIRTHDAY_DAYS,
		now,
	});

	return {
		allowedMentions: { parse: [] },
		components: [buildBirthdayPanelComponents()],
		embeds: [buildBirthdayBoardEmbed(guild, now, entries)],
	};
}

async function fetchBirthdayCardsForUsers(guildId, year, userIds) {
	if (!userIds.length) {
		return new Map();
	}

	const cards = await BirthdayCards.findAll({
		raw: true,
		where: {
			guildId,
			userId: userIds,
			year,
		},
	});

	return new Map(cards.map(card => [card.userId, card]));
}

function buildDayContent(config, birthdays, cardsByUserId = new Map()) {
	const roleMention = config.dayRoleId ? `<@&${config.dayRoleId}> ` : ``;
	const userIds = birthdays.map(birthday => birthday.userId);
	const deliveryLines = birthdays
		.map(birthday => {
			const card = cardsByUserId.get(birthday.userId);

			return card?.deliveryUrl ? `<@${birthday.userId}>: ${card.deliveryUrl}` : null;
		})
		.filter(Boolean);
	const deliveryText = deliveryLines.length ? `\n\nBirthday card${deliveryLines.length === 1 ? `` : `s`}:\n${deliveryLines.join(`\n`)}` : ``;

	return `${roleMention}Happy birthday to ${formatMemberList(userIds)}!${deliveryText}`;
}

function getBirthdayChannelId(config, purpose) {
	if (purpose === `board`) {
		return config.boardChannelId || config.channelId;
	}

	if (purpose === `week`) {
		return config.weekChannelId || config.boardChannelId || config.channelId;
	}

	if (purpose === `day`) {
		return config.dayChannelId || config.boardChannelId || config.channelId;
	}

	return config.channelId;
}

async function getBirthdayGuild(client, guildId) {
	const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);

	if (!guild) {
		warn(`Skipping birthday post for unavailable guild ${guildId}`);
		return null;
	}

	return guild;
}

async function sendBirthdayMessage(client, config, channelId, payload) {
	const guild = await getBirthdayGuild(client, config.guildId);

	if (!guild) {
		return false;
	}

	const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);

	if (!channel?.send) {
		warn(`Skipping birthday post for guild ${config.guildId}; channel ${channelId} is unavailable`);
		return false;
	}

	await channel.send(payload);
	return true;
}

async function refreshBirthdayBoard(client, config, now) {
	const channelId = getBirthdayChannelId(config, `board`);

	if (!channelId) {
		return false;
	}

	const guild = await getBirthdayGuild(client, config.guildId);

	if (!guild) {
		return false;
	}

	const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);

	if (!channel?.send) {
		warn(`Skipping birthday board refresh for guild ${config.guildId}; channel ${channelId} is unavailable`);
		return false;
	}

	if (config.boardMessageId) {
		const oldMessage = await channel.messages.fetch(config.boardMessageId).catch(() => null);

		if (oldMessage) {
			await oldMessage.delete().catch(err => warn(`Failed to delete old birthday board ${config.boardMessageId}:`, err));
		}
	}

	const message = await channel.send(await buildBirthdayBoardPayload(guild, config, { now }));

	await config.update({
		boardMessageId: message.id,
		lastBoardPostDate: now.toISODate(),
	});

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
			const sent = await sendBirthdayMessage(client, config, getBirthdayChannelId(config, `week`), {
				allowedMentions: {
					roles: config.weekRoleId ? [config.weekRoleId] : [],
					users: [],
				},
				components: [buildCreateCardButton()],
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
			const dayBirthdayCards = await fetchBirthdayCardsForUsers(
				config.guildId,
				today.year,
				dayBirthdays.map(birthday => birthday.userId),
			);
			const sent = await sendBirthdayMessage(client, config, getBirthdayChannelId(config, `day`), {
				content: buildDayContent(config, dayBirthdays, dayBirthdayCards),
			});

			if (sent) {
				await config.update({ lastDayPostDate: todayKey });
			}
		}
	}

	if (config.lastBoardPostDate !== todayKey) {
		await refreshBirthdayBoard(client, config, now);
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
	buildBirthdayBoardPayload,
	formatBirthday,
	formatDaysAway,
	getMonthName,
	getNextBirthdayDate,
	getUpcomingBirthdayEntries,
	isValidTimezone,
	deriveBirthdayDeliveryUrl,
	normalizeBirthdayCardUrl,
	parseBirthdayDate,
	parseHour,
	parseMonth,
	refreshBirthdayBoard,
	UPCOMING_BIRTHDAY_DAYS,
};
