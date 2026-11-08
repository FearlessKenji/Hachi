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
const { Op, Transaction } = require(`sequelize`);
const {
	BirthdayBoardRetiredMessages,
	BirthdayCards,
	BirthdayConfigs,
	BirthdayUsers,
	Servers,
	sequelize,
} = require(`../database/dbObjects.js`);
const { error, warn } = require(`./writeLog.js`);

const UPCOMING_BIRTHDAY_DAYS = 14;
const IMMEDIATE_BIRTHDAY_REMINDER_DAYS = 2;
const BIRTHDAY_MEMBER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MEMBERSHIP_FETCH_BATCH_SIZE = 100;
const BIRTHDAY_BOARD_COLOR = 0xf0b83a;
const RECOCARDS_CREATE_URL = `https://recocards.com/create-card/HAPPY_BIRTHDAY`;
const CARD_URL_HOSTS = new Set([
	`recocards.com`,
	`www.recocards.com`,
]);
let membershipReconciliationComplete = false;
const boardWorkTails = new Map();

function serializeBirthdayBoardWork(guildId, operation) {
	// Board replacement, membership edits, and cleanup must not race for one guild.
	const previous = boardWorkTails.get(guildId) || Promise.resolve();
	const result = previous.then(operation);
	const settled = result.catch(() => null);
	boardWorkTails.set(guildId, settled);
	void settled.then(() => {
		if (boardWorkTails.get(guildId) === settled) {
			boardWorkTails.delete(guildId);
		}
	});
	return result;
}

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
	// Delivery goes to the earliest scheduled participating server. On a tie,
	// prefer the card owner, then a stable guild ID order so cron iteration order
	// cannot decide which community notifies the member.
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

function pendingBirthdayCardDeliveryCandidates(candidates, notBefore = null, includeGuildId = null) {
	return candidates.filter(candidate =>
		candidate.lastBirthdayAnnouncementDate !== candidate.scheduledAt.toISODate() &&
		(!notBefore || candidate.scheduledAt >= notBefore || candidate.guildId === includeGuildId),
	);
}

async function getBirthdayCardDeliveryCandidates(card, { transaction } = {}) {
	const birthdays = await BirthdayUsers.findAll({
		raw: true,
		transaction,
		where: { userId: card.userId, leftAt: null },
	});
	const guildIds = [...new Set(birthdays.map(birthday => birthday.guildId))];

	if (!guildIds.length) {
		return [];
	}

	const [configs, activeServers] = await Promise.all([
		BirthdayConfigs.findAll({ raw: true, transaction, where: { guildId: { [Op.in]: guildIds } } }),
		Servers.findAll({
			attributes: [`guildId`],
			raw: true,
			transaction,
			where: { guildId: { [Op.in]: guildIds }, leftAt: null },
		}),
	]);
	const configByGuildId = new Map(configs.map(config => [config.guildId, config]));
	const activeGuildIds = new Set(activeServers.map(server => server.guildId));

	return birthdays.flatMap(birthday => {
		const config = configByGuildId.get(birthday.guildId);

		if (!config || !activeGuildIds.has(birthday.guildId)) {
			return [];
		}

		const scheduledAt = getBirthdayDateForYear(config.timezone, card.year, birthday.month, birthday.day)
			.set({ hour: config.hour });

		if (!scheduledAt.isValid || scheduledAt.year !== card.year) {
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
	includeGuildId = null,
	notBefore = DateTime.now(),
	requirePendingAnnouncement = true,
	transaction = undefined,
	transferOwnership = true,
} = {}) {
	// Ownership controls who may replace or remove the shared card; delivery
	// controls which server sends its one member notification. Recalculate those
	// independently as memberships and announcement eligibility change.
	const ownershipCandidates = await getBirthdayCardDeliveryCandidates(card, { transaction });
	const remainingCandidates = ownershipCandidates.filter(candidate => !excludeGuildIds.includes(candidate.guildId));
	const deliveryCandidates = requirePendingAnnouncement ?
		pendingBirthdayCardDeliveryCandidates(remainingCandidates, notBefore, includeGuildId) :
		remainingCandidates.filter(candidate => !notBefore || candidate.scheduledAt >= notBefore);
	const currentIsEligible = deliveryCandidates.some(candidate => candidate.guildId === card.deliveryGuildId);
	let deliveryGuildId = card.deliveryGuildId;

	if (!card.notificationDeliveredAt && (force || !currentIsEligible)) {
		deliveryGuildId = selectBirthdayCardDeliveryGuild(card, deliveryCandidates);
	}
	const ownerIsEligible = ownershipCandidates.some(candidate => candidate.guildId === card.guildId && !excludeGuildIds.includes(card.guildId));
	let guildId = card.guildId;

	if (transferOwnership && !ownerIsEligible) {
		guildId = selectBirthdayCardDeliveryGuild(card, remainingCandidates);
	}

	if (card.deliveryGuildId !== deliveryGuildId || card.guildId !== guildId) {
		await card.update({ deliveryGuildId, guildId }, { transaction });
	}

	return { candidates: deliveryCandidates, deliveryGuildId, guildId };
}

async function reverifyBirthdayCardsForUser(userId, options = {}) {
	const cards = await BirthdayCards.findAll({ where: { userId }, transaction: options.transaction });
	const results = [];
	for (const card of cards) {
		// SQLite transactions use one connection; keep their dependent reads and
		// writes in order so a failed card leaves the membership unchanged.
		results.push(await reverifyBirthdayCardDelivery(card, options));
	}
	return results;
}

async function reverifyBirthdayCardsForGuild(guildId, options = {}) {
	const birthdays = await BirthdayUsers.findAll({
		attributes: [`userId`],
		raw: true,
		where: { guildId, leftAt: null },
	});
	const userIds = [...new Set(birthdays.map(birthday => birthday.userId))];

	if (!userIds.length) {
		return [];
	}

	const cards = await BirthdayCards.findAll({ where: { userId: { [Op.in]: userIds } } });

	return Promise.all(cards.map(card => reverifyBirthdayCardDelivery(card, options)));
}

async function transferBirthdayCardsFromGuild(guildId, { transaction } = {}) {
	const cards = await BirthdayCards.findAll({
		transaction,
		where: {
			[Op.or]: [
				{ guildId },
				{ deliveryGuildId: guildId },
			],
		},
	});

	const results = [];
	for (const card of cards) {
		results.push(await reverifyBirthdayCardDelivery(card, {
			excludeGuildIds: [guildId],
			force: true,
			transaction,
		}));
	}
	return results;
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

	return [...groups.values()].sort((earlierBirthday, laterBirthday) =>
		earlierBirthday.month - laterBirthday.month || earlierBirthday.day - laterBirthday.day);
}

async function fetchBirthdaysForDate(guildId, target) {
	const rows = await BirthdayUsers.findAll({
		order: [[`day`, `ASC`], [`userId`, `ASC`]],
		raw: true,
		where: {
			guildId,
			leftAt: null,
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
				leftAt: null,
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
			leftAt: null,
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
	const hasUpcomingCard = upcomingEntries.some(entry => entry.card);
	const todayText = todayEntries.length ?
		todayEntries.map(formatBoardEntry).join(`\n`) :
		`No birthdays today.`;
	const upcomingText = upcomingEntries.length ?
		upcomingEntries.map(formatBoardEntry).join(`\n`) :
		`No upcoming birthdays.`;

	return new EmbedBuilder()
		.setColor(BIRTHDAY_BOARD_COLOR)
		.setTitle(`Birthday Board`)
		.setDescription(hasUpcomingCard ?
			`Use the buttons below to add your birthday or sign an upcoming card.` :
			`Use the buttons below to add your birthday.`)
		.addFields(
			{ name: `Today`, value: truncateFieldValue(todayText) },
			{ name: `Next Two Weeks`, value: truncateFieldValue(upcomingText) },
		)
		.setFooter({
			text: `${guild.name} - Updated ${now.toFormat(`MMM d, h:mm a ZZZZ`)}`,
		});
}

function buildBirthdayPanelComponents(config, entries = []) {
	const buttons = [
		new ButtonBuilder()
			.setCustomId(`birthday:panel:set`)
			.setLabel(`Set / Update Birthday`)
			.setStyle(ButtonStyle.Primary),
	];

	if (entries.some(entry => entry.daysAway > 0 && entry.card)) {
		buttons.push(
			new ButtonBuilder()
				.setCustomId(`birthday:panel:sign`)
				.setLabel(`Sign Upcoming Card`)
				.setStyle(ButtonStyle.Secondary),
		);
	}

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
		components: [buildBirthdayPanelComponents(config, entries)],
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

			const deliveryUrl = card?.deliveryUrl || (card?.url && deriveBirthdayDeliveryUrl(card.url));

			return deliveryUrl ? `<@${birthday.userId}>: ${deliveryUrl}` : null;
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
		{ where: { guildId: entry.guildId, userId: entry.userId, leftAt: null } },
	)));
}

async function sendPendingUpcomingBirthdayReminders(client, config, now, maxDays = UPCOMING_BIRTHDAY_DAYS) {
	const birthdays = await BirthdayUsers.findAll({
		order: [[`month`, `ASC`], [`day`, `ASC`], [`userId`, `ASC`]],
		raw: true,
		where: { guildId: config.guildId, leftAt: null },
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

async function failOverBirthdayCardNotification(client, card, failedGuildId, now) {
	// Record each candidate before trying it. A future-hour candidate will send
	// on its own schedule; an eligible current-hour candidate gets a separate
	// card message because its day announcement may already have been posted.
	const deliveryUrl = card.deliveryUrl || deriveBirthdayDeliveryUrl(card.url);

	if (!deliveryUrl) {
		warn(`Birthday card ${card.id} has no valid delivery URL; fallback notification skipped.`);
		return;
	}

	const candidates = (await getBirthdayCardDeliveryCandidates(card))
		.filter(candidate => candidate.guildId !== failedGuildId && candidate.scheduledAt >= now.startOf(`hour`));
	const remaining = [...candidates];

	while (remaining.length) {
		const nextGuildId = selectBirthdayCardDeliveryGuild(card, remaining);
		const nextCandidate = remaining.find(candidate => candidate.guildId === nextGuildId);

		await card.update({ deliveryGuildId: nextGuildId });

		if (nextCandidate.scheduledAt > now) {
			return;
		}

		// A tied server may already have posted without notifying. A separate
		// card message makes the fallback independent of cron iteration order.
		const config = await BirthdayConfigs.findByPk(nextGuildId);

		try {
			const sent = await sendBirthdayMessage(client, config, getBirthdayChannelId(config, `day`), {
				allowedMentions: { roles: [], users: [card.userId] },
				content: `<@${card.userId}> Your birthday card: ${deliveryUrl}`,
			});

			if (sent) {
				await card.update({ notificationDeliveredAt: new Date() });
				return;
			}
		} catch (err) {
			warn(`Fallback birthday card delivery failed for guild ${nextGuildId}:`, err);
		}

		remaining.splice(remaining.findIndex(candidate => candidate.guildId === nextGuildId), 1);
	}

	await card.update({ deliveryGuildId: null });
}

function shouldSendLateBirthdayCard(card, birthday, now) {
	return !card.notificationDeliveredAt &&
		!card.deliveryGuildId &&
		card.year === now.year &&
		birthday.lastBirthdayAnnouncementDate === now.toISODate() &&
		getNextBirthdayDate(now, birthday).toISODate() === now.toISODate();
}

async function sendLateBirthdayCard(client, card, guildId) {
	if (card.notificationDeliveredAt || card.deliveryGuildId) {
		return false;
	}

	const [config, birthday] = await Promise.all([
		BirthdayConfigs.findByPk(guildId),
		BirthdayUsers.findOne({ raw: true, where: { guildId, userId: card.userId, leftAt: null } }),
	]);

	if (!config || !birthday) {
		return false;
	}

	const now = DateTime.now().setZone(config.timezone);
	const deliveryUrl = card.deliveryUrl || deriveBirthdayDeliveryUrl(card.url);

	if (!now.isValid || !deliveryUrl || !shouldSendLateBirthdayCard(card, birthday, now)) {
		return false;
	}

	const sent = await sendBirthdayMessage(client, config, getBirthdayChannelId(config, `day`), {
		allowedMentions: { roles: [], users: [card.userId] },
		content: `<@${card.userId}> Your birthday card: ${deliveryUrl}`,
	});

	if (sent) {
		await card.update({ deliveryGuildId: guildId, notificationDeliveredAt: new Date() });
	}

	return sent;
}

async function sendPendingBirthdayAnnouncements(client, config, now, { immediate = false } = {}) {
	// Discord delivery is the commit point: only after a successful send do we
	// mark this guild's occurrence and the selected card notification complete.
	// A failure leaves the occurrence pending and moves the card notification to
	// another eligible server without marking this guild's post as sent.
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

	await Promise.all([...cards.values()].map(card => reverifyBirthdayCardDelivery(card, {
		force: immediate,
		includeGuildId: immediate ? config.guildId : null,
		notBefore: now.startOf(`hour`),
	})));

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
			failOverBirthdayCardNotification(client, card, config.guildId, now),
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

	const birthday = await BirthdayUsers.findOne({ raw: true, where: { guildId, userId, leftAt: null } });

	if (!birthday) {
		return false;
	}

	const daysAway = Math.floor(getNextBirthdayDate(now, birthday).diff(now.startOf(`day`), `days`).days);

	const action = getNewBirthdayAnnouncementAction(daysAway, now.hour, config.hour);

	if (action === `birthday`) {
		return sendPendingBirthdayAnnouncements(client, config, now, { immediate: true });
	}

	if (action === `upcoming`) {
		return sendPendingUpcomingBirthdayReminders(client, config, now, IMMEDIATE_BIRTHDAY_REMINDER_DAYS);
	}

	return false;
}

function getBirthdayBoardRefreshAction(config, entries, existingMessage, options = {}) {
	if (!config.boardOnlyWhenUpcoming) {
		return options.inPlace && existingMessage?.edit ? `edit` : `replace`;
	}

	if (!entries.length && !options.hadBirthdayYesterday) {
		return `remove`;
	}

	if (options.inPlace && existingMessage?.edit) {
		return `edit`;
	}

	if (options.scheduled) {
		return `replace`;
	}

	return existingMessage?.edit ? `edit` : `replace`;
}

async function hadBirthdayYesterday(config, now) {
	const yesterday = now.minus({ days: 1 }).startOf(`day`);
	const birthdays = await BirthdayUsers.findAll({
		attributes: [`month`, `day`],
		raw: true,
		where: { guildId: config.guildId, leftAt: null },
	});

	// Resolve dates through the same leap-day rule used for the upcoming board.
	return birthdays.some(birthday => getNextBirthdayDate(yesterday, birthday).hasSame(yesterday, `day`));
}

async function deleteBirthdayBoardMessage(message) {
	if (!message) {
		return;
	}
	try {
		await message.delete();
	} catch (err) {
		// Discord can confirm the message was already removed by another actor.
		if (Number(err?.code) !== 10008) {
			throw err;
		}
	}
}

async function deleteRetiredBirthdayBoardMessage(client, retiredMessage) {
	const guild = await getBirthdayGuild(client, retiredMessage.guildId);
	if (!guild) {
		return false;
	}
	let channel;
	try {
		channel = guild.channels.cache.get(retiredMessage.channelId) ||
			await guild.channels.fetch(retiredMessage.channelId);
	} catch (err) {
		if (Number(err?.code) !== 10003) {
			throw err;
		}
		// A confirmed deleted channel also confirms its board is gone.
		await retiredMessage.destroy();
		return true;
	}
	if (!channel?.messages?.fetch) {
		return false;
	}
	let message;
	try {
		message = await channel.messages.fetch(retiredMessage.messageId);
	} catch (err) {
		if (Number(err?.code) !== 10008) {
			throw err;
		}
	}
	await deleteBirthdayBoardMessage(message);
	await retiredMessage.destroy();
	return true;
}

async function refreshBirthdayBoardUnlocked(client, config, now, options = {}) {
	const channelId = getBirthdayChannelId(config, `board`);

	if (!channelId) {
		return `unavailable`;
	}

	const guild = await getBirthdayGuild(client, config.guildId);

	if (!guild) {
		return `unavailable`;
	}

	const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);

	if (!channel?.send) {
		warn(`Skipping birthday board refresh for guild ${config.guildId}; channel ${channelId} is unavailable`);
		return `unavailable`;
	}

	const entries = await getUpcomingBirthdayEntries(guild, config, { now });
	const birthdayYesterday = config.boardOnlyWhenUpcoming && !entries.length ?
		await hadBirthdayYesterday(config, now) :
		false;
	let existingMessage = null;
	if (config.boardMessageId) {
		try {
			existingMessage = await channel.messages.fetch(config.boardMessageId);
		} catch (err) {
			// Only a confirmed Discord 404 means the stored board ID can be replaced.
			// Permission, network, and rate-limit errors leave the ID intact for retry.
			if (Number(err?.code) !== 10008) {
				throw err;
			}
		}
	}
	const refreshAction = getBirthdayBoardRefreshAction(config, entries, existingMessage, {
		hadBirthdayYesterday: birthdayYesterday,
		inPlace: options.inPlace,
		scheduled: options.scheduled,
	});

	// Card changes edit the current board; the scheduled refresh posts a fresh one.
	if (refreshAction === `remove`) {
		await deleteBirthdayBoardMessage(existingMessage);

		await config.update({
			boardMessageId: null,
			...(options.scheduled ? { lastBoardPostDate: now.toISODate() } : {}),
		});
		return `removed`;
	}

	const payload = await buildBirthdayBoardPayload(guild, config, { entries, now });

	if (refreshAction === `edit`) {
		await existingMessage.edit(payload);
		return `updated`;
	}

	const message = await channel.send(payload);
	try {
		// Save the replacement and the old message's cleanup job atomically. A
		// failed send leaves the previous board visible, and a failed delete retries.
		await sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
			await config.update({
				boardMessageId: message.id,
				...(options.scheduled ? { lastBoardPostDate: now.toISODate() } : {}),
			}, { transaction });
			if (existingMessage) {
				await BirthdayBoardRetiredMessages.create({
					guildId: config.guildId,
					channelId,
					messageId: existingMessage.id,
				}, { transaction });
			}
		});
	} catch (err) {
		await deleteBirthdayBoardMessage(message).catch(deleteError =>
			error(`Could not remove an unsaved birthday board ${message.id}:`, deleteError));
		throw err;
	}
	if (existingMessage) {
		try {
			const retired = await BirthdayBoardRetiredMessages.findByPk(existingMessage.id);
			if (retired) {
				await deleteRetiredBirthdayBoardMessage(client, retired);
			}
		} catch (err) {
			warn(`Could not remove old birthday board ${existingMessage.id}; it remains queued for retry:`, err);
		}
	}

	return `posted`;
}

function refreshBirthdayBoard(client, config, now, options = {}) {
	return serializeBirthdayBoardWork(config.guildId, async () => {
		const currentConfig = await BirthdayConfigs.findByPk(config.guildId);
		if (!currentConfig) {
			return `unavailable`;
		}
		if (options.scheduled && currentConfig.lastBoardPostDate === now.toISODate()) {
			return `up-to-date`;
		}
		return refreshBirthdayBoardUnlocked(client, currentConfig, now, options);
	});
}

async function markBirthdayBoardDirty(guildId, transaction) {
	// This revision is committed with membership/card changes. A process restart
	// cannot lose a board update that Discord did not confirm.
	await BirthdayConfigs.increment(`boardRevision`, {
		by: 1,
		transaction,
		where: { guildId },
	});
}

function refreshPendingBirthdayBoard(client, guildId) {
	return serializeBirthdayBoardWork(guildId, async () => {
		const config = await BirthdayConfigs.findByPk(guildId);
		if (!config || config.boardRevision <= config.boardPublishedRevision) {
			return true;
		}
		const revision = config.boardRevision;
		const now = DateTime.now().setZone(config.timezone);
		if (!now.isValid) {
			return false;
		}
		const outcome = await refreshBirthdayBoardUnlocked(client, config, now, { inPlace: true });
		if (outcome === `unavailable`) {
			return false;
		}
		// A later membership change advances boardRevision again. Mark only the
		// revision actually rendered so that later work remains pending.
		await BirthdayConfigs.update({ boardPublishedRevision: revision }, {
			where: { guildId, boardPublishedRevision: { [Op.lt]: revision } },
		});
		return true;
	});
}

async function retryPendingBirthdayBoardWork(client) {
	const [configs, retiredMessages] = await Promise.all([
		BirthdayConfigs.findAll({
			attributes: [`guildId`, `boardRevision`, `boardPublishedRevision`], raw: true,
		}),
		BirthdayBoardRetiredMessages.findAll(),
	]);
	for (const config of configs) {
		if (config.boardRevision <= config.boardPublishedRevision) {
			continue;
		}
		try {
			await refreshPendingBirthdayBoard(client, config.guildId);
		} catch (err) {
			warn(`Could not finish birthday board refresh for guild ${config.guildId}:`, err);
		}
	}
	for (const retiredMessage of retiredMessages) {
		try {
			await serializeBirthdayBoardWork(retiredMessage.guildId, () =>
				deleteRetiredBirthdayBoardMessage(client, retiredMessage));
		} catch (err) {
			warn(`Could not remove retired birthday board ${retiredMessage.messageId}:`, err);
		}
	}
}

async function refreshBirthdayBoardsForUser(client, userId) {
	const birthdays = await BirthdayUsers.findAll({
		attributes: [`guildId`],
		raw: true,
		where: { userId, leftAt: null },
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

	return results.filter(outcome => outcome === `updated` || outcome === `posted`).length;
}

async function refreshBirthdayBoardForMembership(client, guildId) {
	await refreshPendingBirthdayBoard(client, guildId);
}

async function markBirthdayMemberLeft(client, guildId, userId, { now = new Date() } = {}) {
	const changed = await sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
		const [updated] = await BirthdayUsers.update(
			{ leftAt: now },
			{ transaction, where: { guildId, userId, leftAt: null } },
		);
		if (!updated) {
			return false;
		}
		await reverifyBirthdayCardsForUser(userId, { force: true, transaction });
		await markBirthdayBoardDirty(guildId, transaction);
		return true;
	});

	if (!changed) {
		return false;
	}

	// A Discord failure leaves the durable revision pending for hourly/startup retry.
	await refreshBirthdayBoardForMembership(client, guildId).catch(err =>
		warn(`Birthday board refresh remains queued after member ${userId} left guild ${guildId}:`, err));
	return true;
}

async function markBirthdayMemberJoined(client, guildId, userId, {
	joinedAt = new Date(),
	now = new Date(),
} = {}) {
	const transition = await sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
		const birthday = await BirthdayUsers.findOne({ raw: true, transaction, where: { guildId, userId } });
		if (!birthday?.leftAt) {
			return `unchanged`;
		}
		const expiresAt = new Date(birthday.leftAt).getTime() + BIRTHDAY_MEMBER_RETENTION_MS;
		if (new Date(joinedAt).getTime() > expiresAt) {
			return `expired`;
		}
		const [changed] = await BirthdayUsers.update(
			{ leftAt: null },
			{ transaction, where: { guildId, userId, leftAt: { [Op.ne]: null } } },
		);
		if (!changed) {
			return `unchanged`;
		}
		await reverifyBirthdayCardsForUser(userId, { force: true, transaction });
		await markBirthdayBoardDirty(guildId, transaction);
		return `restored`;
	});

	if (transition === `expired`) {
		// Expiration is based on the actual rejoin time, not when an offline bot
		// happened to observe the member again.
		await purgeExpiredBirthdayDepartures({ guildId, now, userId });
		return false;
	}
	if (transition !== `restored`) {
		return false;
	}
	await refreshBirthdayBoardForMembership(client, guildId).catch(err =>
		warn(`Birthday board refresh remains queued after member ${userId} rejoined guild ${guildId}:`, err));
	return true;
}

async function removeBirthdayMembership(guildId, userId) {
	return sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
		const birthday = await BirthdayUsers.findOne({ transaction, where: { guildId, userId } });
		if (!birthday) {
			return 0;
		}

		const otherMemberships = await BirthdayUsers.count({
			transaction,
			where: { guildId: { [Op.ne]: guildId }, userId },
		});
		if (!otherMemberships) {
			// A shared card has no valid owner after the final membership is gone.
			await BirthdayCards.destroy({ transaction, where: { userId } });
		}
		return BirthdayUsers.destroy({ transaction, where: { guildId, userId } });
	});
}

async function purgeExpiredBirthdayDepartures({ guildId = null, now = new Date(), userId = null } = {}) {
	const cutoff = new Date(now.getTime() - BIRTHDAY_MEMBER_RETENTION_MS);
	return sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
		const expired = await BirthdayUsers.findAll({
			attributes: [`id`, `userId`],
			raw: true,
			transaction,
			where: {
				...(guildId ? { guildId } : {}),
				...(userId ? { userId } : {}),
				leftAt: { [Op.ne]: null, [Op.lte]: cutoff },
			},
		});
		if (!expired.length) {
			return { birthdays: 0, cards: 0 };
		}

		const expiredIds = expired.map(row => row.id);
		const candidateUserIds = [...new Set(expired.map(row => row.userId))];
		const retained = await BirthdayUsers.findAll({
			attributes: [`userId`],
			raw: true,
			transaction,
			where: {
				id: { [Op.notIn]: expiredIds },
				userId: { [Op.in]: candidateUserIds },
			},
		});
		const retainedUserIds = new Set(retained.map(row => row.userId));
		const orphanedUserIds = candidateUserIds.filter(candidateUserId => !retainedUserIds.has(candidateUserId));
		// Delete global cards before their final membership IDs. The immediate
		// transaction prevents a concurrent rejoin from racing this decision.
		let cards = 0;
		if (orphanedUserIds.length) {
			cards = await BirthdayCards.destroy({
				transaction,
				where: { userId: { [Op.in]: orphanedUserIds } },
			});
		}
		const birthdays = await BirthdayUsers.destroy({
			transaction,
			where: {
				id: { [Op.in]: expiredIds },
				leftAt: { [Op.ne]: null, [Op.lte]: cutoff },
			},
		});
		return { birthdays, cards };
	});
}

async function reconcileStoredBirthdayMemberships(client, { now = new Date() } = {}) {
	membershipReconciliationComplete = false;
	const birthdays = await BirthdayUsers.findAll({
		attributes: [`guildId`, `userId`, `leftAt`],
		raw: true,
	});
	const birthdaysByGuild = new Map();
	for (const birthday of birthdays) {
		if (!birthdaysByGuild.has(birthday.guildId)) {
			birthdaysByGuild.set(birthday.guildId, []);
		}
		birthdaysByGuild.get(birthday.guildId).push(birthday);
	}
	let left = 0;
	let restored = 0;
	let unverified = 0;

	for (const [guildId, guildBirthdays] of birthdaysByGuild) {
		const guild = client.guilds.cache.get(guildId);
		if (!guild) {
			unverified += guildBirthdays.length;
			warn(`Could not verify ${guildBirthdays.length} birthday memberships because guild ${guildId} is unavailable.`);
			continue;
		}

		for (let offset = 0; offset < guildBirthdays.length; offset += MEMBERSHIP_FETCH_BATCH_SIZE) {
			const batch = guildBirthdays.slice(offset, offset + MEMBERSHIP_FETCH_BATCH_SIZE);
			let members;
			try {
				// Discord's member gateway accepts multiple IDs per request. An empty
				// successful result means absent; a failed request remains unknown.
				members = await guild.members.fetch({
					user: batch.map(birthday => birthday.userId),
					time: 30_000,
				});
			} catch (err) {
				unverified += batch.length;
				warn(`Could not verify ${batch.length} birthday memberships for guild ${guildId}:`, err);
				continue;
			}

			for (const birthday of batch) {
				const member = members.get(birthday.userId);
				try {
					if (member && birthday.leftAt) {
						restored += Number(await markBirthdayMemberJoined(client, guildId, birthday.userId, {
							joinedAt: member.joinedAt || now,
							now,
						}));
					} else if (!member && !birthday.leftAt) {
						left += Number(await markBirthdayMemberLeft(client, guildId, birthday.userId, { now }));
					}
				} catch (err) {
					unverified++;
					warn(`Could not update birthday membership for guild ${guildId}, user ${birthday.userId}:`, err);
				}
			}
		}
	}

	membershipReconciliationComplete = unverified === 0;
	return { left, restored, unverified };
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
		await refreshBirthdayBoard(client, config, now, { scheduled: true });
	}
}

async function checkBirthdays(client) {
	// A failed member fetch could hide a timely offline rejoin. Automatic purges
	// wait until every stored membership has been verified successfully.
	if (membershipReconciliationComplete) {
		await purgeExpiredBirthdayDepartures();
	}
	await retryPendingBirthdayBoardWork(client);
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
	pendingBirthdayCardDeliveryCandidates,
	getUpcomingBirthdayEntries,
	isValidTimezone,
	markBirthdayMemberJoined,
	markBirthdayMemberLeft,
	deriveBirthdayDeliveryUrl,
	normalizeBirthdayCardUrl,
	parseBirthdayDate,
	parseHour,
	parseMonth,
	refreshBirthdayBoard,
	refreshBirthdayBoardForMembership,
	refreshBirthdayBoardsForUser,
	reconcileStoredBirthdayMemberships,
	retryPendingBirthdayBoardWork,
	removeBirthdayMembership,
	purgeExpiredBirthdayDepartures,
	reverifyBirthdayCardDelivery,
	reverifyBirthdayCardsForGuild,
	reverifyBirthdayCardsForUser,
	selectBirthdayCardDeliveryGuild,
	sendLateBirthdayCard,
	shouldSendLateBirthdayCard,
	transferBirthdayCardsFromGuild,
	IMMEDIATE_BIRTHDAY_REMINDER_DAYS,
	UPCOMING_BIRTHDAY_DAYS,
};
