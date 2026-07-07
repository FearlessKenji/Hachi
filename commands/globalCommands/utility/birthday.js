const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelSelectMenuBuilder,
	ChannelType,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	RoleSelectMenuBuilder,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
} = require(`discord.js`);
const {
	BirthdayConfigs,
	BirthdayUsers,
	Servers,
} = require(`../../../database/dbObjects.js`);
const {
	formatBirthday,
	getMonthName,
	isValidTimezone,
	parseBirthdayDate,
	parseMonth,
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

async function setBirthday(interaction) {
	const parsed = parseBirthdayDate(interaction.options.getString(`date`, true));

	if (!parsed) {
		await interaction.reply({
			content: `I couldn't understand that birthday. Try something like \`12/25\`, \`12-25\`, or \`December 25\`.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	await Servers.upsert({ guildId: interaction.guild.id });
	await BirthdayUsers.upsert({
		day: parsed.day,
		guildId: interaction.guild.id,
		month: parsed.month,
		userId: interaction.user.id,
	});

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
		weekRoleId: config?.weekRoleId || null,
		dayRoleId: config?.dayRoleId || null,
		hour: config?.hour === null || config?.hour === undefined ? null : Number(config.hour),
		timezone: config?.timezone || null,
	};
}

function buildBirthdaySetupContent(settings) {
	const status = settings.statusMessage ? `\n### ${settings.statusMessage}` : ``;

	return `## Birthday Setup
- Posting Channel: ${formatChannel(settings.channelId)}
- Posting Hour: ${formatHour(settings.hour)}
- Timezone: ${settings.timezone ? `\`${settings.timezone}\`` : `Not set`}
- Week-before Role: ${formatRole(settings.weekRoleId)}
- Birthday-day Role: ${formatRole(settings.dayRoleId)}${status}`;
}

function buildScheduleContent(settings) {
	const status = settings.statusMessage ? `\n### ${settings.statusMessage}` : ``;

	return `## Birthday Schedule
- Posting Channel: ${formatChannel(settings.channelId)}
- Posting Hour: ${formatHour(settings.hour)}
- Timezone: ${settings.timezone ? `\`${settings.timezone}\`` : `Not set`}${status}`;
}

function buildRolesContent(settings) {
	const status = settings.statusMessage ? `\n### ${settings.statusMessage}` : ``;

	return `## Birthday Roles
- Week-before Role: ${formatRole(settings.weekRoleId)}
- Birthday-day Role: ${formatRole(settings.dayRoleId)}${status}`;
}

function buildChannelSelect(setupId) {
	return new ActionRowBuilder().addComponents(
		new ChannelSelectMenuBuilder()
			.setCustomId(`birthday:${setupId}:setup:channel`)
			.setPlaceholder(`Birthday post channel`)
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
			.setCustomId(`birthday:${setupId}:setup:page:schedule`)
			.setLabel(`Schedule`)
			.setStyle(ButtonStyle.Primary),
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

function buildScheduleComponents(setupId, settings) {
	return [
		buildChannelSelect(setupId),
		buildHourSelect(setupId, settings.hour),
		buildTimezoneRegionSelect(setupId, settings.timezoneRegionId),
		buildTimezoneSelect(setupId, settings),
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
	if (!pendingSetup.channelId) {
		return `Select a birthday post channel before submitting.`;
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
	await Servers.upsert({ guildId });
	await BirthdayConfigs.upsert({
		channelId: settings.channelId,
		dayRoleId: settings.dayRoleId || null,
		guildId,
		hour: settings.hour,
		lastDayPostDate: null,
		lastWeekPostDate: null,
		timezone: settings.timezone,
		weekRoleId: settings.weekRoleId || null,
	});
}

async function submitBirthdaySetup(interaction, setupId, pendingSetup) {
	const validationError = validateBirthdaySetup(pendingSetup);

	if (validationError) {
		pendingSetup.statusMessage = validationError;
		pendingSetup.currentPage = `schedule`;
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

	if (action === `channel`) {
		pendingSetup.channelId = interaction.values[0] || null;
	} else if (action === `weekRole`) {
		pendingSetup.weekRoleId = interaction.values[0] || null;
	} else if (action === `dayRole`) {
		pendingSetup.dayRoleId = interaction.values[0] || null;
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
	} else if (action === `submit`) {
		await submitBirthdaySetup(interaction, setupId, pendingSetup);
		return;
	}

	await updateBirthdaySetup(interaction, setupId, pendingSetup);
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
				command: `/birthday setup`,
				description: `configure automatic birthday posts.`,
				permissions: [PermissionFlagsBits.ManageGuild],
			},
		],
	},

	async execute(interaction) {
		const subcommand = interaction.options.getSubcommand();

		if (subcommand === `set`) {
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

	openSetupPanel,
};
