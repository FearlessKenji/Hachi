// /birthday command group.
//
// Lets members store/view/remove birthdays and lets administrators configure
// birthday announcement channels, roles, timezones, and posting behavior.
const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelSelectMenuBuilder,
	ChannelType,
	InteractionContextType,
	MessageFlags,
	ModalBuilder,
	PermissionFlagsBits,
	RoleSelectMenuBuilder,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextInputBuilder,
	TextInputStyle,
} = require(`discord.js`);
const { DateTime } = require(`luxon`);
const {
	BirthdayCards,
	BirthdayConfigs,
	BirthdayUsers,
	Servers,
} = require(`../../../database/dbObjects.js`);
const {
	formatBirthday,
	formatDaysAway,
	getMonthName,
	getNextBirthdayDate,
	getUpcomingBirthdayEntries,
	isValidTimezone,
	deriveBirthdayDeliveryUrl,
	normalizeBirthdayCardUrl,
	parseBirthdayDate,
	parseMonth,
	refreshBirthdayBoard,
	UPCOMING_BIRTHDAY_DAYS,
} = require(`../../../utils/birthdays.js`);
const {
	DEFAULT_TIMEZONE_REGION_ID,
	TIMEZONE_GROUPS,
	getTimezoneChoicesForRegion,
	getTimezoneRegionId,
} = require(`../../../utils/timezones.js`);
const { error: logError } = require(`../../../utils/writeLog.js`);

const pendingBirthdaySetups = new Map();
const textChannelTypes = [
	ChannelType.GuildText,
	ChannelType.GuildAnnouncement,
];

function canManageBirthdays(interaction) {
	return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

async function requireBirthdayManager(interaction) {
	if (canManageBirthdays(interaction)) {
		return true;
	}

	await interaction.reply({
		content: `You need Manage Server to manage birthday setup or cards.`,
		flags: MessageFlags.Ephemeral,
	});
	return false;
}

async function saveUserBirthday(guildId, userId, parsed) {
	await Servers.upsert({ guildId });
	await BirthdayUsers.upsert({
		day: parsed.day,
		guildId,
		month: parsed.month,
		userId,
	});
}

async function setBirthday(interaction) {
	const parsed = parseBirthdayDate(interaction.options.getString(`date`, true));

	if (!parsed) {
		await interaction.reply({
			content: `I couldn't understand that birthday. Try something like \`12/25\`, \`12-25\`, or \`December 25\`.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await saveUserBirthday(interaction.guild.id, interaction.user.id, parsed);

	await interaction.reply({
		content: `Your birthday is set to ${formatBirthday(parsed.month, parsed.day)}.`,
		flags: MessageFlags.Ephemeral,
	});
}

async function viewBirthday(interaction) {
	const user = interaction.options.getUser(`user`, true);
	const birthday = await BirthdayUsers.findOne({
		raw: true,
		where: {
			guildId: interaction.guild.id,
			userId: user.id,
		},
	});

	if (!birthday) {
		await interaction.reply({
			content: `${user} has not set a birthday.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.reply({
		content: `${user}'s birthday is ${formatBirthday(birthday.month, birthday.day)}.`,
		flags: MessageFlags.Ephemeral,
	});
}

async function buildBirthdayListLines(interaction, birthdays) {
	const birthdaysByDay = new Map();

	for (const birthday of birthdays) {
		if (!birthdaysByDay.has(birthday.day)) {
			birthdaysByDay.set(birthday.day, []);
		}

		const member = await interaction.guild.members.fetch(birthday.userId).catch(() => null);

		birthdaysByDay.get(birthday.day).push({
			label: member?.displayName || birthday.userId,
			mention: `<@${birthday.userId}>`,
		});
	}

	return [...birthdaysByDay.entries()].map(([day, users]) => {
		const mentions = users
			.sort((left, right) => left.label.localeCompare(right.label))
			.map(user => user.mention)
			.join(`, `);

		return `${day}: ${mentions}`;
	});
}

async function listBirthdays(interaction) {
	const month = parseMonth(interaction.options.getString(`month`, true));

	if (!month) {
		await interaction.reply({
			content: `I couldn't understand that month. Try something like \`January\`, \`Jan\`, or \`1\`.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const birthdays = await BirthdayUsers.findAll({
		order: [[`day`, `ASC`], [`userId`, `ASC`]],
		raw: true,
		where: {
			guildId: interaction.guild.id,
			month,
		},
	});

	if (!birthdays.length) {
		await interaction.reply({
			content: `No birthdays are set for ${getMonthName(month)}.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const lines = await buildBirthdayListLines(interaction, birthdays);

	await interaction.reply({
		content: `Birthdays in ${getMonthName(month)}\n\n${lines.join(`\n`)}`,
		flags: MessageFlags.Ephemeral,
	});
}

async function removeBirthday(interaction) {
	const count = await BirthdayUsers.destroy({
		where: {
			guildId: interaction.guild.id,
			userId: interaction.user.id,
		},
	});

	await interaction.reply({
		content: count ? `Your birthday has been removed.` : `You do not have a birthday set.`,
		flags: MessageFlags.Ephemeral,
	});
}

async function getBirthdayConfigOrDefault(guildId) {
	const config = await BirthdayConfigs.findOne({
		raw: true,
		where: { guildId },
	});

	return {
		...(config || {}),
		guildId,
		timezone: config?.timezone || `UTC`,
	};
}

async function getStoredBirthday(guildId, userId) {
	return BirthdayUsers.findOne({
		raw: true,
		where: {
			guildId,
			userId,
		},
	});
}

function resolveBirthdayCardYear(birthday, timezone) {
	const now = DateTime.now().setZone(timezone || `UTC`);

	return getNextBirthdayDate(now, birthday).year;
}

async function refreshBirthdayBoardForInteraction(interaction) {
	const config = await BirthdayConfigs.findOne({
		where: { guildId: interaction.guild.id },
	});

	if (!config?.timezone || !(config.boardChannelId || config.channelId)) {
		return false;
	}

	const now = DateTime.now().setZone(config.timezone);

	if (!now.isValid) {
		return false;
	}

	return refreshBirthdayBoard(interaction.client, config, now).catch(err => {
		logError(`Failed to refresh birthday board after card update:`, err);
		return false;
	});
}

async function setBirthdayCard(interaction) {
	if (!await requireBirthdayManager(interaction)) {
		return;
	}

	const user = interaction.options.getUser(`user`, true);
	const normalizedUrl = normalizeBirthdayCardUrl(interaction.options.getString(`url`, true));

	if (!normalizedUrl) {
		await interaction.reply({
			content: `Use a valid HTTPS RecoCards board link, such as \`https://recocards.com/board/...\`.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const derivedDeliveryUrl = deriveBirthdayDeliveryUrl(normalizedUrl);
	const config = await getBirthdayConfigOrDefault(interaction.guild.id);
	const birthday = await getStoredBirthday(interaction.guild.id, user.id);

	if (!birthday) {
		await interaction.reply({
			content: `${user}'s birthday is not stored. They need to set a birthday before a card can be attached.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const year = resolveBirthdayCardYear(birthday, config.timezone);
	const existing = await BirthdayCards.findOne({
		where: {
			guildId: interaction.guild.id,
			userId: user.id,
			year,
		},
	});

	if (existing) {
		await existing.update({
			deliveryUrl: derivedDeliveryUrl,
			updatedAt: new Date(),
			url: normalizedUrl,
		});
	} else {
		await BirthdayCards.create({
			createdAt: new Date(),
			createdBy: interaction.user.id,
			deliveryUrl: derivedDeliveryUrl,
			guildId: interaction.guild.id,
			updatedAt: null,
			url: normalizedUrl,
			userId: user.id,
			year,
		});
	}

	const refreshed = await refreshBirthdayBoardForInteraction(interaction);

	await interaction.editReply({
		content: `Birthday card saved for ${user}'s next birthday.${refreshed ? ` The birthday board was refreshed.` : ``}`,
	});
}

async function removeBirthdayCard(interaction) {
	if (!await requireBirthdayManager(interaction)) {
		return;
	}

	const user = interaction.options.getUser(`user`, true);
	const config = await getBirthdayConfigOrDefault(interaction.guild.id);
	const birthday = await getStoredBirthday(interaction.guild.id, user.id);

	if (!birthday) {
		await interaction.reply({
			content: `${user}'s birthday is not stored. Hachi cannot determine which birthday card to remove.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	const year = resolveBirthdayCardYear(birthday, config.timezone);
	const count = await BirthdayCards.destroy({
		where: {
			guildId: interaction.guild.id,
			userId: user.id,
			year,
		},
	});
	const refreshed = count ? await refreshBirthdayBoardForInteraction(interaction) : false;

	await interaction.editReply({
		content: count ?
			`Birthday card removed for ${user}'s next birthday.${refreshed ? ` The birthday board was refreshed.` : ``}` :
			`No birthday card was saved for ${user}'s next birthday.`,
	});
}

function buildBirthdaySetModal() {
	return new ModalBuilder()
		.setCustomId(`birthday:panel:setModal`)
		.setTitle(`Set Birthday`)
		.addComponents(
			new ActionRowBuilder().addComponents(
				new TextInputBuilder()
					.setCustomId(`date`)
					.setLabel(`Birthday`)
					.setPlaceholder(`12/25 or December 25`)
					.setStyle(TextInputStyle.Short)
					.setMinLength(3)
					.setMaxLength(32)
					.setRequired(true),
			),
		);
}

function buildBirthdayCardSelect(entries) {
	return new ActionRowBuilder().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(`birthday:panel:cardSelect`)
			.setPlaceholder(`Choose a card to sign`)
			.addOptions(entries.slice(0, 25).map(entry =>
				new StringSelectMenuOptionBuilder()
					.setLabel(entry.displayName.slice(0, 100))
					.setDescription(`${formatBirthday(entry.month, entry.day)} - ${formatDaysAway(entry.daysAway)}`.slice(0, 100))
					.setValue(String(entry.card.id)),
			)),
	);
}

async function getSignableBirthdayCardEntries(interaction, config) {
	const entries = await getUpcomingBirthdayEntries(interaction.guild, config, {
		days: UPCOMING_BIRTHDAY_DAYS,
	});

	return entries.filter(entry =>
		entry.card &&
		!(entry.userId === interaction.user.id && entry.daysAway > 0),
	);
}

async function handlePanelSignCards(interaction) {
	const config = await getBirthdayConfigOrDefault(interaction.guild.id);
	const entries = await getUpcomingBirthdayEntries(interaction.guild, config, {
		days: UPCOMING_BIRTHDAY_DAYS,
	});
	const signableEntries = entries.filter(entry =>
		entry.card &&
		!(entry.userId === interaction.user.id && entry.daysAway > 0),
	);
	const hiddenOwnCard = entries.some(entry =>
		entry.card &&
		entry.userId === interaction.user.id &&
		entry.daysAway > 0,
	);

	if (!signableEntries.length) {
		await interaction.reply({
			content: hiddenOwnCard ?
				`No birthday cards are currently available for you to sign. Your card is hidden until your birthday.` :
				`No birthday cards are currently available for you to sign.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await interaction.reply({
		content: `Choose a birthday card to sign.`,
		components: [buildBirthdayCardSelect(signableEntries)],
		flags: MessageFlags.Ephemeral,
	});
}

async function handleBirthdayCardSelect(interaction) {
	const config = await getBirthdayConfigOrDefault(interaction.guild.id);
	const entries = await getSignableBirthdayCardEntries(interaction, config);
	const entry = entries.find(candidate => String(candidate.card.id) === interaction.values[0]);

	if (!entry) {
		await interaction.update({
			components: [],
			content: `That birthday card is no longer available.`,
		});
		return;
	}

	const isBirthdayMember = entry.userId === interaction.user.id;
	const cardUrl = isBirthdayMember && entry.daysAway === 0 && entry.card.deliveryUrl ?
		entry.card.deliveryUrl :
		entry.card.url;

	await interaction.update({
		components: [
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setLabel(isBirthdayMember ? `Open Birthday Card` : `Add Your Message`)
					.setStyle(ButtonStyle.Link)
					.setURL(cardUrl),
			),
		],
		content: `${entry.displayName}'s birthday is ${formatBirthday(entry.month, entry.day)} (${formatDaysAway(entry.daysAway)}).`,
	});
}

function formatChannel(id) {
	return id ? `<#${id}>` : `Not set`;
}

function formatRole(id) {
	return id ? `<@&${id}>` : `Not set`;
}

function hourOptionLabel(hour) {
	const period = hour >= 12 ? `PM` : `AM`;
	const displayHour = hour % 12 || 12;

	return `${displayHour}:00 ${period}`;
}

function formatHour(hour) {
	if (hour === null || hour === undefined) {
		return `Not set`;
	}

	return `${hourOptionLabel(hour)} (${String(hour).padStart(2, `0`)}:00)`;
}

async function getBirthdaySettings(guildId) {
	const config = await BirthdayConfigs.findOne({
		raw: true,
		where: { guildId },
	});

	return {
		guildId,
		channelId: config?.channelId || null,
		boardChannelId: config?.boardChannelId || config?.channelId || null,
		boardMessageId: config?.boardMessageId || null,
		boardOnlyWhenUpcoming: Boolean(config?.boardOnlyWhenUpcoming),
		weekChannelId: config?.weekChannelId || null,
		dayChannelId: config?.dayChannelId || null,
		weekRoleId: config?.weekRoleId || null,
		dayRoleId: config?.dayRoleId || null,
		hour: config?.hour === null || config?.hour === undefined ? null : Number(config.hour),
		timezone: config?.timezone || null,
	};
}

function formatOptionalChannel(id) {
	return id ? formatChannel(id) : `Board channel`;
}

function buildBirthdaySetupContent(settings) {
	const status = settings.statusMessage ? `\n### ${settings.statusMessage}` : ``;

	return `## Birthday Setup
- Birthday Board Channel: ${formatChannel(settings.boardChannelId)}
- Birthday Board Posting: ${settings.boardOnlyWhenUpcoming ? `Upcoming birthdays only` : `Daily`}
- Week-before Ping Channel: ${formatOptionalChannel(settings.weekChannelId)}
- Birthday-day Ping Channel: ${formatOptionalChannel(settings.dayChannelId)}
- Posting Hour: ${formatHour(settings.hour)}
- Timezone: ${settings.timezone ? `\`${settings.timezone}\`` : `Not set`}
- Week-before Role: ${formatRole(settings.weekRoleId)}
- Birthday-day Role: ${formatRole(settings.dayRoleId)}${status}`;
}

function buildChannelsContent(settings) {
	const status = settings.statusMessage ? `\n### ${settings.statusMessage}` : ``;

	return `## Birthday Channels
- Birthday Board Channel: ${formatChannel(settings.boardChannelId)}
- Week-before Ping Channel: ${formatOptionalChannel(settings.weekChannelId)}
- Birthday-day Ping Channel: ${formatOptionalChannel(settings.dayChannelId)}

If a ping channel is not set, Hachi posts that ping in the birthday board channel.${status}`;
}

function buildScheduleContent(settings) {
	const status = settings.statusMessage ? `\n### ${settings.statusMessage}` : ``;

	return `## Birthday Schedule
- Posting Hour: ${formatHour(settings.hour)}
- Birthday Board Posting: ${settings.boardOnlyWhenUpcoming ? `Upcoming birthdays only` : `Daily`}
- Timezone: ${settings.timezone ? `\`${settings.timezone}\`` : `Not set`}${status}`;
}

function buildRolesContent(settings) {
	const status = settings.statusMessage ? `\n### ${settings.statusMessage}` : ``;

	return `## Birthday Roles
- Week-before Role: ${formatRole(settings.weekRoleId)}
- Birthday-day Role: ${formatRole(settings.dayRoleId)}${status}`;
}

function buildChannelSelect(setupId, action, placeholder) {
	return new ActionRowBuilder().addComponents(
		new ChannelSelectMenuBuilder()
			.setCustomId(`birthday:${setupId}:setup:${action}`)
			.setPlaceholder(placeholder)
			.setChannelTypes(textChannelTypes)
			.setMaxValues(1),
	);
}

function buildRoleSelect(customId, placeholder) {
	return new ActionRowBuilder().addComponents(
		new RoleSelectMenuBuilder()
			.setCustomId(customId)
			.setPlaceholder(placeholder)
			.setMinValues(0)
			.setMaxValues(1),
	);
}

function buildHourSelect(setupId, selectedHour) {
	const options = Array.from({ length: 24 }, (_, hour) =>
		new StringSelectMenuOptionBuilder()
			.setLabel(hourOptionLabel(hour))
			.setDescription(`${String(hour).padStart(2, `0`)}:00`)
			.setValue(String(hour))
			.setDefault(selectedHour === hour),
	);

	return new ActionRowBuilder().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(`birthday:${setupId}:setup:hour`)
			.setPlaceholder(`Posting hour`)
			.addOptions(options),
	);
}

function buildTimezoneRegionSelect(setupId, selectedRegionId) {
	return new ActionRowBuilder().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(`birthday:${setupId}:setup:timezoneRegion`)
			.setPlaceholder(`Timezone region`)
			.addOptions(TIMEZONE_GROUPS.map(group =>
				new StringSelectMenuOptionBuilder()
					.setLabel(group.label)
					.setDescription(group.description)
					.setValue(group.id)
					.setDefault(group.id === selectedRegionId),
			)),
	);
}

function buildTimezoneSelect(setupId, settings) {
	const choices = getTimezoneChoicesForRegion(settings.timezoneRegionId, settings.timezone);

	return new ActionRowBuilder().addComponents(
		new StringSelectMenuBuilder()
			.setCustomId(`birthday:${setupId}:setup:timezone`)
			.setPlaceholder(`Timezone`)
			.addOptions(choices.map(choice =>
				new StringSelectMenuOptionBuilder()
					.setLabel(choice.label)
					.setValue(choice.value)
					.setDefault(choice.value === settings.timezone),
			)),
	);
}

function buildBackToSetupButton(parentSetupId) {
	if (!parentSetupId) {
		return null;
	}

	return new ButtonBuilder()
		.setCustomId(`setup:${parentSetupId}:home`)
		.setLabel(`Back to Setup`)
		.setStyle(ButtonStyle.Secondary);
}

function buildHomeComponents(setupId, parentSetupId = null) {
	const buttons = [
		new ButtonBuilder()
			.setCustomId(`birthday:${setupId}:setup:page:channels`)
			.setLabel(`Channels`)
			.setStyle(ButtonStyle.Primary),
		new ButtonBuilder()
			.setCustomId(`birthday:${setupId}:setup:page:schedule`)
			.setLabel(`Schedule`)
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(`birthday:${setupId}:setup:page:roles`)
			.setLabel(`Roles`)
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(`birthday:${setupId}:setup:submit`)
			.setLabel(`Submit`)
			.setStyle(ButtonStyle.Success),
	];

	const backToSetupButton = buildBackToSetupButton(parentSetupId);

	if (backToSetupButton) {
		buttons.push(backToSetupButton);
	}

	return [
		new ActionRowBuilder().addComponents(buttons),
	];
}

function buildBackRow(setupId, parentSetupId = null, options = {}) {
	const buttons = [];

	if (options.clearChannels) {
		buttons.push(
			new ButtonBuilder()
				.setCustomId(`birthday:${setupId}:setup:clearPingChannels`)
				.setLabel(`Clear Ping Channels`)
				.setStyle(ButtonStyle.Danger),
		);
	}

	if (options.clearRoles) {
		buttons.push(
			new ButtonBuilder()
				.setCustomId(`birthday:${setupId}:setup:clearRoles`)
				.setLabel(`Clear Roles`)
				.setStyle(ButtonStyle.Danger),
		);
	}

	buttons.push(
		new ButtonBuilder()
			.setCustomId(`birthday:${setupId}:setup:page:home`)
			.setLabel(`Back`)
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(`birthday:${setupId}:setup:submit`)
			.setLabel(`Submit`)
			.setStyle(ButtonStyle.Success),
	);

	const backToSetupButton = buildBackToSetupButton(parentSetupId);

	if (backToSetupButton) {
		buttons.push(backToSetupButton);
	}

	return new ActionRowBuilder().addComponents(buttons);
}

function buildChannelComponents(setupId, settings) {
	return [
		buildChannelSelect(setupId, `boardChannel`, `Birthday board channel`),
		buildChannelSelect(setupId, `weekChannel`, `Week-before ping channel`),
		buildChannelSelect(setupId, `dayChannel`, `Birthday-day ping channel`),
		buildBackRow(setupId, settings.parentSetupId, { clearChannels: true }),
	];
}

function buildScheduleComponents(setupId, settings) {
	return [
		buildHourSelect(setupId, settings.hour),
		buildTimezoneRegionSelect(setupId, settings.timezoneRegionId),
		buildTimezoneSelect(setupId, settings),
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`birthday:${setupId}:setup:toggleBoardPosting`)
				.setLabel(settings.boardOnlyWhenUpcoming ? `Board: Upcoming Only` : `Board: Daily`)
				.setStyle(settings.boardOnlyWhenUpcoming ? ButtonStyle.Secondary : ButtonStyle.Primary),
		),
		buildBackRow(setupId, settings.parentSetupId),
	];
}

function buildRolesComponents(setupId, settings) {
	return [
		buildRoleSelect(`birthday:${setupId}:setup:weekRole`, `Week-before role`),
		buildRoleSelect(`birthday:${setupId}:setup:dayRole`, `Birthday-day role`),
		buildBackRow(setupId, settings.parentSetupId, { clearRoles: true }),
	];
}

function buildBirthdaySetupComponents(setupId, settings) {
	if (settings.currentPage === `channels`) {
		return buildChannelComponents(setupId, settings);
	}

	if (settings.currentPage === `schedule`) {
		return buildScheduleComponents(setupId, settings);
	}

	if (settings.currentPage === `roles`) {
		return buildRolesComponents(setupId, settings);
	}

	return buildHomeComponents(setupId, settings.parentSetupId);
}

async function getPendingBirthdaySetup(interaction, setupId) {
	const pendingSetup = pendingBirthdaySetups.get(setupId);

	if (!pendingSetup || pendingSetup.userId !== interaction.user.id || pendingSetup.guildId !== interaction.guild.id) {
		await interaction.update({
			content: `This birthday setup request is no longer available. Run \`/birthday setup\` again.`,
			components: [],
		});
		return null;
	}

	return pendingSetup;
}

function buildBirthdaySetupPageContent(settings) {
	if (settings.currentPage === `channels`) {
		return buildChannelsContent(settings);
	}

	if (settings.currentPage === `schedule`) {
		return buildScheduleContent(settings);
	}

	if (settings.currentPage === `roles`) {
		return buildRolesContent(settings);
	}

	return buildBirthdaySetupContent(settings);
}

async function updateBirthdaySetup(interaction, setupId, pendingSetup) {
	await interaction.update({
		content: buildBirthdaySetupPageContent(pendingSetup),
		components: buildBirthdaySetupComponents(setupId, pendingSetup),
	});
}

function validateBirthdaySetup(pendingSetup) {
	if (!pendingSetup.boardChannelId) {
		return `Select a birthday board channel before submitting.`;
	}

	if (pendingSetup.hour === null || pendingSetup.hour === undefined) {
		return `Select a posting hour before submitting.`;
	}

	if (!pendingSetup.timezone || !isValidTimezone(pendingSetup.timezone)) {
		return `Set a valid timezone before submitting.`;
	}

	return null;
}

async function saveBirthdaySettings(guildId, settings) {
	const boardChannelId = settings.boardChannelId || settings.channelId;

	await Servers.upsert({ guildId });
	await BirthdayConfigs.upsert({
		boardChannelId,
		boardMessageId: settings.boardMessageId || null,
		boardOnlyWhenUpcoming: Boolean(settings.boardOnlyWhenUpcoming),
		channelId: boardChannelId,
		dayChannelId: settings.dayChannelId || null,
		dayRoleId: settings.dayRoleId || null,
		guildId,
		hour: settings.hour,
		lastBoardPostDate: null,
		lastDayPostDate: null,
		lastWeekPostDate: null,
		timezone: settings.timezone,
		weekChannelId: settings.weekChannelId || null,
		weekRoleId: settings.weekRoleId || null,
	});
}

async function submitBirthdaySetup(interaction, setupId, pendingSetup) {
	const validationError = validateBirthdaySetup(pendingSetup);

	if (validationError) {
		pendingSetup.statusMessage = validationError;
		pendingSetup.currentPage = pendingSetup.boardChannelId ? `schedule` : `channels`;
		await updateBirthdaySetup(interaction, setupId, pendingSetup);
		return;
	}

	pendingSetup.statusMessage = null;
	await saveBirthdaySettings(pendingSetup.guildId, pendingSetup);
	pendingBirthdaySetups.delete(setupId);

	await interaction.update({
		content: `${buildBirthdaySetupContent(pendingSetup)}
### Settings saved.`,
		components: [],
	});
}

async function openSetupPanel(interaction, { parentSetupId = null, update = false } = {}) {
	if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
		const payload = {
			content: `You need Manage Server to set up birthday posts.`,
			flags: MessageFlags.Ephemeral,
		};

		if (update) {
			await interaction.update({ content: payload.content, components: [], embeds: [] });
		} else {
			await interaction.reply(payload);
		}
		return;
	}

	const setupId = interaction.id;
	const settings = await getBirthdaySettings(interaction.guild.id);
	const pendingSetup = {
		...settings,
		currentPage: null,
		parentSetupId,
		statusMessage: null,
		timezoneRegionId: getTimezoneRegionId(settings.timezone),
		userId: interaction.user.id,
	};

	pendingBirthdaySetups.set(setupId, pendingSetup);

	const payload = {
		content: buildBirthdaySetupPageContent(pendingSetup),
		components: buildBirthdaySetupComponents(setupId, pendingSetup),
	};

	if (update) {
		await interaction.update({
			...payload,
			embeds: [],
		});
		return;
	}

	await interaction.reply({
		...payload,
		flags: MessageFlags.Ephemeral,
	});
}

async function handleBirthdaySetupComponent(interaction, setupId, action, field) {
	const pendingSetup = await getPendingBirthdaySetup(interaction, setupId);

	if (!pendingSetup) {
		return;
	}

	pendingSetup.statusMessage = null;

	if (action === `page`) {
		pendingSetup.currentPage = field === `home` ? null : field;
		await updateBirthdaySetup(interaction, setupId, pendingSetup);
		return;
	}

	if (action === `boardChannel`) {
		pendingSetup.boardChannelId = interaction.values[0] || null;
		pendingSetup.channelId = pendingSetup.boardChannelId;
	} else if (action === `weekChannel`) {
		pendingSetup.weekChannelId = interaction.values[0] || null;
	} else if (action === `dayChannel`) {
		pendingSetup.dayChannelId = interaction.values[0] || null;
	} else if (action === `weekRole`) {
		pendingSetup.weekRoleId = interaction.values[0] || null;
	} else if (action === `dayRole`) {
		pendingSetup.dayRoleId = interaction.values[0] || null;
	} else if (action === `toggleBoardPosting`) {
		pendingSetup.boardOnlyWhenUpcoming = !pendingSetup.boardOnlyWhenUpcoming;
	} else if (action === `hour`) {
		pendingSetup.hour = Number(interaction.values[0]);
	} else if (action === `timezoneRegion`) {
		pendingSetup.timezoneRegionId = interaction.values[0] || DEFAULT_TIMEZONE_REGION_ID;

		if (!getTimezoneChoicesForRegion(pendingSetup.timezoneRegionId, pendingSetup.timezone).some(choice => choice.value === pendingSetup.timezone)) {
			pendingSetup.timezone = null;
		}
	} else if (action === `timezone`) {
		pendingSetup.timezone = interaction.values[0] || null;
		pendingSetup.timezoneRegionId = getTimezoneRegionId(pendingSetup.timezone);
	} else if (action === `clearRoles`) {
		pendingSetup.weekRoleId = null;
		pendingSetup.dayRoleId = null;
	} else if (action === `clearPingChannels`) {
		pendingSetup.weekChannelId = null;
		pendingSetup.dayChannelId = null;
	} else if (action === `submit`) {
		await submitBirthdaySetup(interaction, setupId, pendingSetup);
		return;
	}

	await updateBirthdaySetup(interaction, setupId, pendingSetup);
}

async function handleBirthdayPanelComponent(interaction, action) {
	if (action === `set`) {
		await interaction.showModal(buildBirthdaySetModal());
	} else if (action === `sign`) {
		await handlePanelSignCards(interaction);
	} else if (action === `cardSelect`) {
		await handleBirthdayCardSelect(interaction);
	} else if (action === `toggleDayRole`) {
		await toggleBirthdayDayRole(interaction);
	} else if (action === `view` || action === `remove`) {
		await interaction.reply({
			content: `That birthday-board button is no longer available. Use \`/birthday view\` or \`/birthday remove\` instead.`,
			flags: MessageFlags.Ephemeral,
		});
	}
}

async function toggleBirthdayDayRole(interaction) {
	const config = await BirthdayConfigs.findByPk(interaction.guild.id);
	const role = config?.dayRoleId ? interaction.guild.roles.cache.get(config.dayRoleId) : null;

	// A stale or unassignable configured role should fail privately instead of
	// exposing Discord permission errors from a public birthday-board action.
	if (!role || role.id === interaction.guild.id || role.managed || !role.editable) {
		await interaction.reply({
			content: `The Birthday-day Role is unavailable or Hachi cannot assign it. Ask a server manager to check the birthday setup and role hierarchy.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const member = await interaction.guild.members.fetch(interaction.user.id);
	const hasRole = member.roles.cache.has(role.id);

	if (hasRole) {
		await member.roles.remove(role, `Birthday-day ping opt-out`);
	} else {
		await member.roles.add(role, `Birthday-day ping opt-in`);
	}

	await interaction.reply({
		content: hasRole ?
			`You will no longer receive pings on birthdays.` :
			`You will now receive birthday pings when it's someone's birthday.`,
		flags: MessageFlags.Ephemeral,
	});
}

async function handleBirthdayPanelModalSubmit(interaction) {
	const parsed = parseBirthdayDate(interaction.fields.getTextInputValue(`date`));

	if (!parsed) {
		await interaction.reply({
			content: `I couldn't understand that birthday. Try something like \`12/25\`, \`12-25\`, or \`December 25\`.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await saveUserBirthday(interaction.guild.id, interaction.user.id, parsed);
	await interaction.reply({
		content: `Your birthday is set to ${formatBirthday(parsed.month, parsed.day)}.`,
		flags: MessageFlags.Ephemeral,
	});
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`birthday`)
		.setDescription(`Manage server birthdays.`)
		.setContexts(InteractionContextType.Guild)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`set`)
				.setDescription(`Set your birthday.`)
				.addStringOption(option =>
					option
						.setName(`date`)
						.setDescription(`Your birthday in MM/DD format, such as 12/25 or December 25.`)
						.setRequired(true),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`view`)
				.setDescription(`View a member's birthday.`)
				.addUserOption(option =>
					option
						.setName(`user`)
						.setDescription(`Member to view.`)
						.setRequired(true),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`list`)
				.setDescription(`List birthdays in a month.`)
				.addStringOption(option =>
					option
						.setName(`month`)
						.setDescription(`Month, such as January or 1.`)
						.setAutocomplete(true)
						.setRequired(true),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`remove`)
				.setDescription(`Remove your birthday.`),
		)
		.addSubcommandGroup(group =>
			group
				.setName(`card`)
				.setDescription(`Manage birthday card links.`)
				.addSubcommand(subcommand =>
					subcommand
						.setName(`set`)
						.setDescription(`Save a birthday card link for a member.`)
						.addUserOption(option =>
							option
								.setName(`user`)
								.setDescription(`Birthday member.`)
								.setRequired(true),
						)
						.addStringOption(option =>
							option
								.setName(`url`)
								.setDescription(`RecoCards board link used for signing.`)
								.setRequired(true),
						),
				)
				.addSubcommand(subcommand =>
					subcommand
						.setName(`remove`)
						.setDescription(`Remove a birthday card link for a member.`)
						.addUserOption(option =>
							option
								.setName(`user`)
								.setDescription(`Birthday member.`)
								.setRequired(true),
						),
				),
		)
		.addSubcommand(subcommand =>
			subcommand
				.setName(`setup`)
				.setDescription(`Open the automatic birthday post setup panel.`),
		),

	help: {
		category: `general`,
		entries: [
			{
				command: `/birthday set/view/list/remove`,
				description: `set, view, list, and remove server birthdays.`,
			},
			{
				category: `management`,
				command: `/birthday setup/card`,
				description: `configure birthday posts and card links.`,
				permissions: [PermissionFlagsBits.ManageGuild],
			},
		],
	},

	async execute(interaction) {
		const group = interaction.options.getSubcommandGroup(false);
		const subcommand = interaction.options.getSubcommand();

		if (group === `card` && subcommand === `set`) {
			await setBirthdayCard(interaction);
		} else if (group === `card` && subcommand === `remove`) {
			await removeBirthdayCard(interaction);
		} else if (subcommand === `set`) {
			await setBirthday(interaction);
		} else if (subcommand === `view`) {
			await viewBirthday(interaction);
		} else if (subcommand === `list`) {
			await listBirthdays(interaction);
		} else if (subcommand === `remove`) {
			await removeBirthday(interaction);
		} else if (subcommand === `setup`) {
			await openSetupPanel(interaction);
		}
	},

	async handleComponent(interaction) {
		const [, setupId, scope, action, field] = interaction.customId.split(`:`);

		if (setupId === `panel`) {
			try {
				await handleBirthdayPanelComponent(interaction, scope);
			} catch (err) {
				logError(`Failed to handle birthday panel interaction:`, err);

				if (interaction.replied || interaction.deferred) {
					await interaction.followUp({ content: `Failed to update birthday panel.`, flags: MessageFlags.Ephemeral });
				} else {
					await interaction.reply({ content: `Failed to update birthday panel.`, flags: MessageFlags.Ephemeral });
				}
			}
			return;
		}

		if (scope !== `setup`) {
			return;
		}

		try {
			await handleBirthdaySetupComponent(interaction, setupId, action, field);
		} catch (err) {
			logError(`Failed to update birthday setup:`, err);

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: `Failed to update birthday setup.`, flags: MessageFlags.Ephemeral });
			} else {
				await interaction.reply({ content: `Failed to update birthday setup.`, flags: MessageFlags.Ephemeral });
			}
		}
	},

	async handleModalSubmit(interaction) {
		const [, scope, action] = interaction.customId.split(`:`);

		if (scope !== `panel` || action !== `setModal`) {
			return;
		}

		try {
			await handleBirthdayPanelModalSubmit(interaction);
		} catch (err) {
			logError(`Failed to handle birthday modal:`, err);

			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: `Failed to save birthday.`, flags: MessageFlags.Ephemeral });
			} else {
				await interaction.reply({ content: `Failed to save birthday.`, flags: MessageFlags.Ephemeral });
			}
		}
	},

	openSetupPanel,
};
