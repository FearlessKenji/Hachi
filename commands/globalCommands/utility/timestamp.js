const { SlashCommandBuilder, MessageFlags } = require(`discord.js`);
const { DateTime } = require(`luxon`);

/**
 * Normalize raw user input into predictable formats
 */
function normalizeDate(input) {
    input = input.trim();

    // M/D
    if (/^\d{1,2}\/\d{1,2}$/.test(input)) {
        const now = DateTime.now();
        const [month, day] = input.split(`/`).map(Number);
        const inputDate = DateTime.fromObject({
            year,
            month,
            day,
        });
        let year = now.year;

        if (inputDate < now.startOf(`day`)) {
            year++;
        }

        return `${month}/${day}/${year}`;
    }

    return input;
}

function normalizeTime(input) {
    return input
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/(\d)(am|pm)/, "$1 $2")
        .replace(/(\d:\d{2})(am|pm)/, "$1 $2");
}

/**
 * Try parsing with a small set of reliable formats
 */
function parseDateTime(date, time, zone) {
    const input = `${date} ${time}`;

    const formats = [
        "M/d/yyyy h a",
        "M/d/yy h a",
        "M/d/yyyy h:mm a",
        "M/d/yy h:mm a",
        "M/d/yyyy H:mm",
        "M/d/yy H:mm",
    ];

    for (const format of formats) {
        const dateTime = DateTime.fromFormat(input, format, { zone });

        if (dateTime.isValid) {
            return dt;
        }
    }

    return null;
}

function toEpoch(date, time, zone) {
    const dt = parseDateTime(date, time, zone);
    if (!dt) return null;

    return Math.floor(dt.toUTC().toSeconds());
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName(`timestamp`)
        .setDescription(`Convert a date/time into a Discord timestamp.`)
        .addStringOption(option =>
            option
                .setName(`title`)
                .setDescription(`What is the timestamp for?`)
                .setRequired(true)
        )
        .addStringOption(option =>
            option
                .setName(`date`)
                .setDescription(`Date (e.g. 6/7/26 or 06/07/2026)`)
                .setRequired(true)
        )

        .addStringOption(option =>
            option
                .setName(`time`)
                .setDescription(`Time (e.g. 9pm, 9:00pm, 21:00)`)
                .setRequired(true)
        )

        .addStringOption(option =>
            option
                .setName(`timezone`)
                .setDescription(`Timezone (default: UTC)`)
                .setAutocomplete(true)
                .setRequired(true)
        ),

    async execute(interaction) {
        const header = interaction.options.getString(`header`);
        const date = normalizeDate(interaction.options.getString(`date`));
        const time = normalizeTime(interaction.options.getString(`time`));
        const timezone = interaction.options.getString(`timezone`);

        const epoch = toEpoch(date, time, timezone);

        if (!epoch) {
            return interaction.reply({
                content: `I couldn't parse that date/time. Try something like: 1/1/26 12pm`,
                flags: MessageFlags.Ephemeral,
            });
        }

        // const full = `<t:${epoch}:F>`;
        const timeOnly = `<t:${epoch}:t>`;
        const dateOnly = `<t:${epoch}:D>`;
        const relative = `<t:${epoch}:R>`;

        await interaction.reply({
            content:
                `**${header}**\n` +
                `${dateOnly} at ${timeOnly}. This is ${relative}.`
        });
    },
};