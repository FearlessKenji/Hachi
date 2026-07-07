const {
	ActionRowBuilder,
	ApplicationIntegrationType,
	ButtonBuilder,
	ButtonStyle,
	InteractionContextType,
	MessageFlags,
	SlashCommandBuilder,
} = require(`discord.js`);
const { DateTime } = require(`luxon`);

const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;
const pendingConfirmations = new Map();

const DATE_TIME_FORMATS = [
	`M/d/yyyy h a`,
	`M/d/yy h a`,
	`M/d/yyyy h:mm a`,
	`M/d/yy h:mm a`,
	`M/d/yyyy H`,
	`M/d/yy H`,
	`M/d/yyyy H:mm`,
	`M/d/yy H:mm`,
	`yyyy-MM-dd h a`,
	`yyyy-MM-dd h:mm a`,
	`yyyy-MM-dd H`,
	`yyyy-MM-dd H:mm`,
	`MMM d yyyy h a`,
	`MMM d yy h a`,
	`MMM d yyyy h:mm a`,
	`MMM d yy h:mm a`,
	`MMM d yyyy H`,
	`MMM d yy H`,
	`MMM d yyyy H:mm`,
	`MMM d yy H:mm`,
	`MMMM d yyyy h a`,
	`MMMM d yy h a`,
	`MMMM d yyyy h:mm a`,
	`MMMM d yy h:mm a`,
	`MMMM d yyyy H`,
	`MMMM d yy H`,
	`MMMM d yyyy H:mm`,
	`MMMM d yy H:mm`,
];

const DATE_TIME_FORMATS_WITH_INFERRED_YEAR = [
	`M/d yyyy h a`,
	`M/d/yyyy h a`,
	`M/d yyyy h:mm a`,
	`M/d/yyyy h:mm a`,
	`M/d yyyy H`,
	`M/d/yyyy H`,
	`M/d yyyy H:mm`,
	`M/d/yyyy H:mm`,
	`MMM d yyyy h a`,
	`MMM d yyyy h:mm a`,
	`MMM d yyyy H`,
	`MMM d yyyy H:mm`,
	`MMMM d yyyy h a`,
	`MMMM d yyyy h:mm a`,
	`MMMM d yyyy H`,
	`MMMM d yyyy H:mm`,
];

function isValidTimezone(zone) {
	return DateTime.now().setZone(zone).isValid;
}

function normalizeTime(input) {
	return input
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ` `)
		.replace(/(\d)(am|pm)/, `$1 $2`)
		.replace(/(\d:\d{2})(am|pm)/, `$1 $2`);
}

function parseWithFormats(input, formats, zone) {
	for (const format of formats) {
		const dateTime = DateTime.fromFormat(input, format, { zone });

		if (dateTime.isValid) {
			return dateTime;
		}
	}

	return null;
}

function parseExplicitDateTime(date, time, zone) {
	return parseWithFormats(`${date} ${time}`, DATE_TIME_FORMATS, zone);
}

function parseDateTimeWithYear(date, time, year, zone) {
	return parseWithFormats(`${date} ${year} ${time}`, DATE_TIME_FORMATS_WITH_INFERRED_YEAR, zone);
}

function parseDateTime(date, time, zone) {
	const explicitDateTime = parseExplicitDateTime(date, time, zone);

	if (explicitDateTime) {
		return {
			dateTime: explicitDateTime,
			requiresConfirmation: false,
		};
	}

	const now = DateTime.now().setZone(zone);
	const currentYearDateTime = parseDateTimeWithYear(date, time, now.year, zone);

	if (!currentYearDateTime) {
		return null;
	}

	if (currentYearDateTime >= now) {
		return {
			dateTime: currentYearDateTime,
			requiresConfirmation: false,
		};
	}

	return {
		dateTime: currentYearDateTime.plus({ years: 1 }),
		requiresConfirmation: true,
	};
}

function getEpoch(dateTime) {
	return Math.floor(dateTime.toUTC().toSeconds());
}

function buildTimestampResponse(title, dateTime) {
	const epoch = getEpoch(dateTime);

	return `**${title}**
<t:${epoch}:D> at <t:${epoch}:t>. This is <t:${epoch}:R>.`;
}

function buildConfirmContent(title, dateTime, timezone) {
	const epoch = getEpoch(dateTime);

	return `The requested time has already passed this year in ${timezone}.

Did you mean **${title}** for <t:${epoch}:D> at <t:${epoch}:t>, which is <t:${epoch}:R>?`;
}

function buildConfirmComponents(timestampId) {
	return [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`timestamp:${timestampId}:confirm`)
				.setLabel(`Yes`)
				.setStyle(ButtonStyle.Success),
			new ButtonBuilder()
				.setCustomId(`timestamp:${timestampId}:decline`)
				.setLabel(`No`)
				.setStyle(ButtonStyle.Secondary),
		),
	];
}

function setPendingConfirmation(timestampId, pendingConfirmation) {
	const timeout = setTimeout(() => {
		pendingConfirmations.delete(timestampId);
	}, CONFIRM_TIMEOUT_MS);

	pendingConfirmations.set(timestampId, {
		...pendingConfirmation,
		timeout,
	});
}

function clearPendingConfirmation(timestampId) {
	const pendingConfirmation = pendingConfirmations.get(timestampId);

	if (pendingConfirmation?.timeout) {
		clearTimeout(pendingConfirmation.timeout);
	}

	pendingConfirmations.delete(timestampId);

	return pendingConfirmation;
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`timestamp`)
		.setDescription(`Convert a date/time into a Discord timestamp.`)
		.setIntegrationTypes(
			ApplicationIntegrationType.GuildInstall,
			ApplicationIntegrationType.UserInstall,
		)
		.setContexts(
			InteractionContextType.Guild,
			InteractionContextType.BotDM,
			InteractionContextType.PrivateChannel,
		)
		.addStringOption(option =>
			option
				.setName(`title`)
				.setDescription(`What is the timestamp for?`)
				.setRequired(true),
		)
		.addStringOption(option =>
			option
				.setName(`date`)
				.setDescription(`Date, such as 6/7, 6/7/26, 2026-06-07, or June 7.`)
				.setRequired(true),
		)
		.addStringOption(option =>
			option
				.setName(`time`)
				.setDescription(`Time, such as 9pm, 9:00pm, or 21:00.`)
				.setRequired(true),
		)
		.addStringOption(option =>
			option
				.setName(`timezone`)
				.setDescription(`Timezone.`)
				.setAutocomplete(true)
				.setRequired(true),
		),

	help: {
		category: `general`,
		entries: [
			{
				command: `/timestamp`,
				description: `create Discord timestamps from a date, time, and timezone.`,
			},
		],
	},

	async execute(interaction) {
		const title = interaction.options.getString(`title`, true).trim();
		const timezone = interaction.options.getString(`timezone`, true);

		if (!isValidTimezone(timezone)) {
			await interaction.reply({
				content: `I do not recognize that timezone. Choose one from the autocomplete list.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const date = interaction.options.getString(`date`, true).trim();
		const time = normalizeTime(interaction.options.getString(`time`, true));
		const parsed = parseDateTime(date, time, timezone);

		if (!parsed) {
			await interaction.reply({
				content: `I could not parse that date/time. Try something like \`6/7 9pm\`, \`6/7/26 9pm\`, or \`2026-06-07 21:00\`.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (parsed.requiresConfirmation) {
			setPendingConfirmation(interaction.id, {
				dateTime: parsed.dateTime,
				guildId: interaction.guild?.id || null,
				title,
				userId: interaction.user.id,
			});

			await interaction.reply({
				content: buildConfirmContent(title, parsed.dateTime, timezone),
				components: buildConfirmComponents(interaction.id),
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		await interaction.reply({
			content: buildTimestampResponse(title, parsed.dateTime),
		});
	},

	async handleComponent(interaction) {
		const [, timestampId, action] = interaction.customId.split(`:`);
		const pendingConfirmation = clearPendingConfirmation(timestampId);

		if (
			!pendingConfirmation ||
			pendingConfirmation.userId !== interaction.user.id ||
			pendingConfirmation.guildId !== (interaction.guild?.id || null)
		) {
			await interaction.update({
				content: `This timestamp confirmation is no longer available. Run \`/timestamp\` again.`,
				components: [],
			});
			return;
		}

		if (action === `decline`) {
			await interaction.update({
				content: `Timestamp creation declined.`,
				components: [],
			});
			return;
		}

		await interaction.update({
			content: buildTimestampResponse(pendingConfirmation.title, pendingConfirmation.dateTime),
			components: [],
		});
	},
};
