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
const { Op } = require(`sequelize`);
const { BirthdayCards, BirthdayConfigs, BirthdayUsers, Servers } = require(`../database/dbObjects.js`);
const { error, warn } = require(`./writeLog.js`);

const UPCOMING_BIRTHDAY_DAYS = 14;
const IMMEDIATE_BIRTHDAY_REMINDER_DAYS = 2;
const BIRTHDAY_BOARD_COLOR = 0xf0b83a;
const RECOCARDS_CREATE_URL = `https://recocards.com/create-card/HAPPY_BIRTHDAY`;
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

function compareGuildIds(left, right) {
	try {
		return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
	} catch {
		return String(left).localeCompare(String(right));
	}
}

function selectBirthdayCardDeliveryGuild(card, candidates) {
	const ordered = [...candidates].sort((left, right) => {
		const timeDifference = left.scheduledAt.toMillis() - right.scheduledAt.toMillis();

		if (timeDifference) {
			return timeDifference;
		}

		if (left.guildId === card.guildId || right.guildId === card.guildId) {
			return left.guildId === card.guildId ? -1 : 1;
		}

		return compareGuildIds(left.guildId, right.guildId);
	});

	return ordered[0]?.guildId || null;
}

async function getBirthdayCardDeliveryCandidates(card, {
	excludeGuildIds = [],
	notBefore = null,
	requirePendingAnnouncement = false,
} = {}) {
	const excluded = new Set(excludeGuildIds.map(String));
	const birthdays = await BirthdayUsers.findAll({
		raw: true,
		where: { userId: card.userId },
	});
	const guildIds = [...new Set(birthdays.map(birthday => birthday.guildId))];

	if (!guildIds.length) {
		return [];
	}

	const [configs, activeServers] = await Promise.all([
		BirthdayConfigs.findAll({ raw: true, where: { guildId: { [Op.in]: guildIds } } }),
		Servers.findAll({
			attributes: [`guildId`],
			raw: true,
			where: { guildId: { [Op.in]: guildIds }, leftAt: null },
		}),
	]);
	const configByGuildId = new Map(configs.map(config => [config.guildId, config]));
	const activeGuildIds = new Set(activeServers.map(server => server.guildId));

	return birthdays.flatMap(birthday => {
		const config = configByGuildId.get(birthday.guildId);

		if (!config || !activeGuildIds.has(birthday.guildId) || excluded.has(String(birthday.guildId))) {
			return [];
		}

		const scheduledAt = getBirthdayDateForYear(config.timezone, card.year, birthday.month, birthday.day)
			.set({ hour: config.hour });

		if (
			!scheduledAt.isValid ||
			scheduledAt.year !== card.year ||
			(notBefore && scheduledAt < notBefore) ||
			(requirePendingAnnouncement && birthday.lastBirthdayAnnouncementDate === scheduledAt.toISODate())
		) {
			return [];
		}

		return [{
			guildId: birthday.guildId,
			lastBirthdayAnnouncementDate: birthday.lastBirthdayAnnouncementDate,
			scheduledAt,
		}];
	});
}

async function reverifyBirthdayCardDelivery(card, {
	excludeGuildIds = [],
	force = false,
	notBefore = null,
	requirePendingAnnouncement = false,
	transferOwnership = true,
} = {}) {
	const candidates = await getBirthdayCardDeliveryCandidates(card, {
		excludeGuildIds,
		notBefore,
		requirePendingAnnouncement,
	});
	const currentIsEligible = candidates.some(candidate => candidate.guildId === card.deliveryGuildId);
	const deliveryGuildId = !force && currentIsEligible ?
		card.deliveryGuildId :
		selectBirthdayCardDeliveryGuild(card, candidates);
	const ownerIsEligible = candidates.some(candidate => candidate.guildId === card.guildId);
	const guildId = !transferOwnership || ownerIsEligible ? card.guildId : deliveryGuildId;

	if (card.deliveryGuildId !== deliveryGuildId || card.guildId !== guildId) {
		await card.update({ deliveryGuildId, guildId });
	}

	return { candidates, deliveryGuildId, guildId };
}

async function reverifyBirthdayCardsForUser(userId, options = {}) {
	const cards = await BirthdayCards.findAll({ where: { userId } });

	return Promise.all(cards.map(card => reverifyBirthdayCardDelivery(card, options)));
}

async function reverifyBirthdayCardsForGuild(guildId, options = {}) {
	const birthdays = await BirthdayUsers.findAll({
		attributes: [`userId`],
		raw: true,
		where: { guildId },
	});
	const userIds = [...new Set(birthdays.map(birthday => birthday.userId))];

	if (!userIds.length) {
		return [];
	}

	const cards = await BirthdayCards.findAll({ where: { userId: { [Op.in]: userIds } } });

	return Promise.all(cards.map(card => reverifyBirthdayCardDelivery(card, options)));
}

async function transferBirthdayCardsFromGuild(guildId) {
	const cards = await BirthdayCards.findAll({
		where: {
			[Op.or]: [
				{ guildId },
				{ deliveryGuildId: guildId },
			],
		},
	});

	return Promise.all(cards.map(card => reverifyBirthdayCardDelivery(card, {
		excludeGuildIds: [guildId],
		force: true,
	})));
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

function buildUpcomingReminderContent(config, entries) {
	const roleMention = config.weekRoleId ? `<@&${config.weekRoleId}> ` : ``;
	const groups = groupBirthdaysByDay(entries);
	const lines = groups.map(group => {
		const daysAway = entries.find(entry => entry.month === group.month && entry.day === group.day).daysAway;

		return `${formatBirthday(group.month, group.day)} (${formatDaysAway(daysAway)}): ${formatMemberList(group.userIds)}`;
	});

	return `${roleMention}Upcoming birthday${groups.length === 1 ? `` : `s`}:\n${lines.join(`\n`)}`;
}

function buildCreateCardButton() {
	return new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setLabel(`Create a Card`)
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
			userId: entries.map(entry => entry.userId),
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
	const cardStatus = entry.daysAway > 0 ? ` ${entry.card ? `(has card)` : `(no card set)`}` : ``;

	return `**${dateLabel}** - ${entry.mention}${cardStatus}`;
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

function buildBirthdayPanelComponents(config) {
	const buttons = [
		new ButtonBuilder()
			.setCustomId(`birthday:panel:set`)
			.setLabel(`Set / Update Birthday`)
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder()
			.setCustomId(`birthday:panel:sign`)
			.setLabel(`Sign Upcoming Card`)
			.setStyle(ButtonStyle.Secondary),
	];

	if (config.dayRoleId) {
		buttons.push(
			new ButtonBuilder()
				.setCustomId(`birthday:panel:toggleDayRole`)
				.setLabel(`Toggle Birthday Pings`)
				.setStyle(ButtonStyle.Secondary),
		);
	}

	return new ActionRowBuilder().addComponents(buttons);
}

async function buildBirthdayBoardPayload(guild, config, options = {}) {
	const now = options.now || DateTime.now().setZone(config.timezone || `UTC`);
	const entries = options.entries || await getUpcomingBirthdayEntries(guild, config, {
		days: options.days ?? UPCOMING_BIRTHDAY_DAYS,
		now,
	});

	return {
		allowedMentions: { parse: [] },
		components: [buildBirthdayPanelComponents(config)],
		embeds: [buildBirthdayBoardEmbed(guild, now, entries)],
	};
}

async function fetchBirthdayCardsForUsers(year, userIds) {
	if (!userIds.length) {
		return new Map();
	}

	const cards = await BirthdayCards.findAll({
		where: {
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

function getBirthdayNotificationUserIds(birthdays, cardsByUserId, guildId) {
	return birthdays
		.filter(birthday => {
			const card = cardsByUserId.get(birthday.userId);

			return !card || (!card.notificationDeliveredAt && card.deliveryGuildId === guildId);
		})
		.map(birthday => birthday.userId);
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
	if (!channelId) {
		return false;
	}

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

function getPendingUpcomingBirthdayEntries(birthdays, now, maxDays = UPCOMING_BIRTHDAY_DAYS) {
	const today = now.startOf(`day`);

	return birthdays
		.map(birthday => {
			const date = getNextBirthdayDate(now, birthday);
			const daysAway = Math.floor(date.diff(today, `days`).days);

			return { ...birthday, date, daysAway };
		})
		.filter(entry =>
			entry.daysAway > 0 &&
			entry.daysAway <= maxDays &&
			entry.lastUpcomingReminderDate !== entry.date.toISODate(),
		)
		.sort((left, right) => left.date.toMillis() - right.date.toMillis() || left.userId.localeCompare(right.userId));
}

function getNewBirthdayAnnouncementAction(daysAway, currentHour, postingHour) {
	if (daysAway === 0 && currentHour >= postingHour) {
		return `birthday`;
	}

	if (daysAway > 0 && daysAway <= IMMEDIATE_BIRTHDAY_REMINDER_DAYS) {
		return `upcoming`;
	}

	return null;
}

async function markBirthdayEntries(entries, field, valueForEntry) {
	await Promise.all(entries.map(entry => BirthdayUsers.update(
		{ [field]: valueForEntry(entry) },
		{ where: { guildId: entry.guildId, userId: entry.userId } },
	)));
}

async function sendPendingUpcomingBirthdayReminders(client, config, now, maxDays = UPCOMING_BIRTHDAY_DAYS) {
	const birthdays = await BirthdayUsers.findAll({
		order: [[`month`, `ASC`], [`day`, `ASC`], [`userId`, `ASC`]],
		raw: true,
		where: { guildId: config.guildId },
	});
	const entries = getPendingUpcomingBirthdayEntries(birthdays, now, maxDays);

	if (!entries.length) {
		return false;
	}

	const sent = await sendBirthdayMessage(client, config, getBirthdayChannelId(config, `week`), {
		allowedMentions: {
			roles: config.weekRoleId ? [config.weekRoleId] : [],
			users: [],
		},
		components: [buildCreateCardButton()],
		content: buildUpcomingReminderContent(config, entries),
	});

	if (!sent) {
		return false;
	}

	// Mark an occurrence only after Discord accepts the message so a transient
	// delivery failure remains eligible for the next scheduled check.
	await markBirthdayEntries(entries, `lastUpcomingReminderDate`, entry => entry.date.toISODate());
	await config.update({ lastWeekPostDate: now.toISODate() });
	return true;
}

async function sendPendingBirthdayAnnouncements(client, config, now) {
	const todayKey = now.toISODate();
	const birthdays = (await fetchBirthdaysForDate(config.guildId, {
		day: now.day,
		month: now.month,
		year: now.year,
	})).filter(birthday => birthday.lastBirthdayAnnouncementDate !== todayKey);

	if (!birthdays.length) {
		return false;
	}

	const cards = await fetchBirthdayCardsForUsers(now.year, birthdays.map(birthday => birthday.userId));

	await Promise.all([...cards.values()].map(card => reverifyBirthdayCardDelivery(card)));

	const notifyingCards = [...cards.values()].filter(card =>
		!card.notificationDeliveredAt && card.deliveryGuildId === config.guildId,
	);
	const notifyingUserIds = getBirthdayNotificationUserIds(birthdays, cards, config.guildId);
	let sent = false;

	try {
		sent = await sendBirthdayMessage(client, config, getBirthdayChannelId(config, `day`), {
			allowedMentions: {
				roles: config.dayRoleId ? [config.dayRoleId] : [],
				users: notifyingUserIds,
			},
			content: buildDayContent(config, birthdays, cards),
		});
	} catch (err) {
		warn(`Birthday announcement failed for guild ${config.guildId}; selecting fallback card delivery servers.`, err);
	}

	if (!sent) {
		await Promise.all(notifyingCards.map(card =>
			reverifyBirthdayCardDelivery(card, {
				excludeGuildIds: [config.guildId],
				force: true,
				notBefore: now.startOf(`hour`),
				requirePendingAnnouncement: true,
				transferOwnership: false,
			}),
		));
		return false;
	}

	await Promise.all(notifyingCards.map(card => card.update({ notificationDeliveredAt: new Date() })));

	// Same-day additions can arrive after the scheduled post, so deduplicate by
	// member and occurrence rather than relying on the config's daily timestamp.
	await markBirthdayEntries(birthdays, `lastBirthdayAnnouncementDate`, () => todayKey);
	await config.update({ lastDayPostDate: todayKey });
	return true;
}

async function announceNewlyStoredBirthday(client, guildId, userId) {
	const config = await BirthdayConfigs.findByPk(guildId);

	if (!config?.timezone) {
		return false;
	}

	const now = DateTime.now().setZone(config.timezone);

	if (!now.isValid) {
		return false;
	}

	const birthday = await BirthdayUsers.findOne({ raw: true, where: { guildId, userId } });

	if (!birthday) {
		return false;
	}

	const daysAway = Math.floor(getNextBirthdayDate(now, birthday).diff(now.startOf(`day`), `days`).days);

	const action = getNewBirthdayAnnouncementAction(daysAway, now.hour, config.hour);

	if (action === `birthday`) {
		return sendPendingBirthdayAnnouncements(client, config, now);
	}

	if (action === `upcoming`) {
		return sendPendingUpcomingBirthdayReminders(client, config, now, IMMEDIATE_BIRTHDAY_REMINDER_DAYS);
	}

	return false;
}

function getBirthdayBoardRefreshAction(config, entries, existingMessage) {
	if (!config.boardOnlyWhenUpcoming) {
		return `replace`;
	}

	if (!entries.length) {
		return `remove`;
	}

	return existingMessage?.edit ? `edit` : `replace`;
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

	const entries = await getUpcomingBirthdayEntries(guild, config, { now });
	const existingMessage = config.boardMessageId ?
		await channel.messages.fetch(config.boardMessageId).catch(() => null) :
		null;
	const refreshAction = getBirthdayBoardRefreshAction(config, entries, existingMessage);

	// Upcoming-only mode keeps channels quiet between birthday windows and edits
	// the active board in place so its countdowns remain current without reposting.
	if (refreshAction === `remove`) {
		if (existingMessage) {
			await existingMessage.delete().catch(err => warn(`Failed to delete old birthday board ${config.boardMessageId}:`, err));
		}

		await config.update({
			boardMessageId: null,
			lastBoardPostDate: now.toISODate(),
		});
		return false;
	}

	const payload = await buildBirthdayBoardPayload(guild, config, { entries, now });

	if (refreshAction === `edit`) {
		await existingMessage.edit(payload);
		await config.update({ lastBoardPostDate: now.toISODate() });
		return true;
	}

	if (config.boardMessageId) {
		if (existingMessage) {
			await existingMessage.delete().catch(err => warn(`Failed to delete old birthday board ${config.boardMessageId}:`, err));
		}
	}

	const message = await channel.send(payload);

	await config.update({
		boardMessageId: message.id,
		lastBoardPostDate: now.toISODate(),
	});

	return true;
}

async function refreshBirthdayBoardsForUser(client, userId) {
	const birthdays = await BirthdayUsers.findAll({
		attributes: [`guildId`],
		raw: true,
		where: { userId },
	});
	const guildIds = [...new Set(birthdays.map(birthday => birthday.guildId))];

	if (!guildIds.length) {
		return 0;
	}

	const configs = await BirthdayConfigs.findAll({
		where: { guildId: { [Op.in]: guildIds } },
	});
	const results = await Promise.all(configs.map(async config => {
		const now = DateTime.now().setZone(config.timezone);

		if (!now.isValid) {
			return false;
		}

		return refreshBirthdayBoard(client, config, now).catch(err => {
			warn(`Failed to refresh birthday board after global card update for guild ${config.guildId}:`, err);
			return false;
		});
	}));

	return results.filter(Boolean).length;
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

	await sendPendingUpcomingBirthdayReminders(client, config, now);
	await sendPendingBirthdayAnnouncements(client, config, now);

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
	announceNewlyStoredBirthday,
	checkBirthdays,
	buildCreateCardButton,
	buildBirthdayBoardPayload,
	buildBirthdayPanelComponents,
	formatBoardEntry,
	formatBirthday,
	formatDaysAway,
	getMonthName,
	getNextBirthdayDate,
	getBirthdayBoardRefreshAction,
	getBirthdayNotificationUserIds,
	getNewBirthdayAnnouncementAction,
	getPendingUpcomingBirthdayEntries,
	getUpcomingBirthdayEntries,
	isValidTimezone,
	deriveBirthdayDeliveryUrl,
	normalizeBirthdayCardUrl,
	parseBirthdayDate,
	parseHour,
	parseMonth,
	refreshBirthdayBoard,
	refreshBirthdayBoardsForUser,
	reverifyBirthdayCardDelivery,
	reverifyBirthdayCardsForGuild,
	reverifyBirthdayCardsForUser,
	selectBirthdayCardDeliveryGuild,
	transferBirthdayCardsFromGuild,
	IMMEDIATE_BIRTHDAY_REMINDER_DAYS,
	UPCOMING_BIRTHDAY_DAYS,
};
