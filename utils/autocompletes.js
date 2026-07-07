const { colorAutocompletes } = require(`./colors.js`);
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

	return [];
}

module.exports = {
	autocompletes,
	birthdayAutocompletes,
	timezoneAutocompletes,
};
