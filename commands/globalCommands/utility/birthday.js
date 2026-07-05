const {
	ChannelType,
	InteractionContextType,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
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
	parseHour,
	parseMonth,
} = require(`../../../utils/birthdays.js`);

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

async function setupBirthdays(interaction) {
	if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
		await interaction.reply({
			content: `You need Manage Server to set up birthday posts.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const hour = parseHour(interaction.options.getString(`hour`, true));
	const timezone = interaction.options.getString(`timezone`, true);

	if (hour === null) {
		await interaction.reply({
			content: `I couldn't understand that hour. Birthday setup only supports whole-hour times. Try \`12pm\`, \`noon\`, or a 24-hour value like \`13\`.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (!isValidTimezone(timezone)) {
		await interaction.reply({
			content: `That timezone is not valid. Use one of the autocompletes.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const channel = interaction.options.getChannel(`channel`, true);
	const weekRole = interaction.options.getRole(`week_role`);
	const dayRole = interaction.options.getRole(`day_role`);

	await Servers.upsert({ guildId: interaction.guild.id });
	await BirthdayConfigs.upsert({
		channelId: channel.id,
		dayRoleId: dayRole?.id || null,
		guildId: interaction.guild.id,
		hour,
		lastDayPostDate: null,
		lastWeekPostDate: null,
		timezone,
		weekRoleId: weekRole?.id || null,
	});

	const weekRoleText = weekRole ? `${weekRole}` : `no role`;
	const dayRoleText = dayRole ? `${dayRole}` : `no role`;

	await interaction.reply({
		content: `Birthday posts are set for ${channel} at ${hour}:00 in ${timezone}.\nWeek-before role: ${weekRoleText}\nBirthday-day role: ${dayRoleText}`,
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
		.addSubcommand(subcommand =>
			subcommand
				.setName(`setup`)
				.setDescription(`Set up automatic birthday posts.`)
				.addChannelOption(option =>
					option
						.setName(`channel`)
						.setDescription(`Channel where birthday posts should be sent.`)
						.setRequired(true)
						.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
				)
				.addStringOption(option =>
					option
						.setName(`hour`)
						.setDescription(`Whole-hour posting time, such as 12pm, noon, or 13.`)
						.setRequired(true),
				)
				.addStringOption(option =>
					option
						.setName(`timezone`)
						.setDescription(`IANA timezone, such as America/New_York.`)
						.setRequired(true)
						.setAutocomplete(true),
				)
				.addRoleOption(option =>
					option
						.setName(`week_role`)
						.setDescription(`Optional role to ping one week before birthdays.`),
				)
				.addRoleOption(option =>
					option
						.setName(`day_role`)
						.setDescription(`Optional role to ping on birthday days.`),
				),
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
			await setupBirthdays(interaction);
		}
	},
};
