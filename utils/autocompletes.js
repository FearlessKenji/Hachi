// Shared autocomplete sources.
//
// Discord autocomplete handlers need at most 25 choices. These helpers filter
// colors, birthdays, and timezones into Discord-ready choice arrays.
const { colorAutocompletes } = require(`./colors.js`);
const { RECOMMENDED_FIX_RULES } = require(`./socialLinks.js`);
const { TIMEZONE_CHOICES } = require(`./timezones.js`);

const MONTHS = [
	{ aliases: [`1`, `jan`], name: `January`, value: `January` },
	{ aliases: [`2`, `feb`], name: `February`, value: `February` },
	{ aliases: [`3`, `mar`], name: `March`, value: `March` },
	{ aliases: [`4`, `apr`], name: `April`, value: `April` },
	{ aliases: [`5`], name: `May`, value: `May` },
	{ aliases: [`6`, `jun`], name: `June`, value: `June` },
	{ aliases: [`7`, `jul`], name: `July`, value: `July` },
	{ aliases: [`8`, `aug`], name: `August`, value: `August` },
	{ aliases: [`9`, `sep`], name: `September`, value: `September` },
	{ aliases: [`10`, `oct`], name: `October`, value: `October` },
	{ aliases: [`11`, `nov`], name: `November`, value: `November` },
	{ aliases: [`12`, `dec`], name: `December`, value: `December` },
];

function birthdayAutocompletes(focused) {
	return MONTHS
		.filter(month =>
			month.name.toLowerCase().startsWith(focused) ||
			month.aliases.some(alias => alias.startsWith(focused)),
		)
		.map(({ name, value }) => ({ name, value }))
		.slice(0, 25);
}

function timezoneAutocompletes(focused) {
	return TIMEZONE_CHOICES
		.filter(tz => tz.label.toLowerCase().includes(focused) || tz.value.toLowerCase().includes(focused))
		.slice(0, 25)
		.map(tz => ({
			name: tz.label,
			value: tz.value,
		}));
}

function autocompletes(interaction) {
	const focusedOption = interaction.options.getFocused(true);
	const focused = String(focusedOption.value).toLowerCase();

	if (interaction.commandName === `birthday` && focusedOption.name === `month`) {
		return birthdayAutocompletes(focused);
	}

	if (focusedOption.name === `timezone`) {
		return timezoneAutocompletes(focused);
	}

	if (interaction.commandName === `rules` && focusedOption.name === `color`) {
		return colorAutocompletes(focused);
	}

	if (interaction.commandName === `links` && [`source`, `replacement`].includes(focusedOption.name)) {
		const source = interaction.options.getString(`source`)?.toLowerCase();
		return RECOMMENDED_FIX_RULES
			.filter(rule => !source || focusedOption.name === `source` || rule.sourceDomain === source)
			.map(rule => {
				const value = focusedOption.name === `source` ? rule.sourceDomain : rule.targetDomain;
				return { name: `${rule.sourceDomain} → ${rule.targetDomain}`, value };
			})
			.filter(choice => choice.value.includes(focused));
	}

	return [];
}

module.exports = {
	autocompletes,
	birthdayAutocompletes,
	timezoneAutocompletes,
};
