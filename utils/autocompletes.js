const { colorAutocompletes } = require(`./colors.js`);

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

const TIMEZONES = [
	{ label: `UTC`, value: `UTC` },

	{ label: `US Eastern (New York)`, value: `America/New_York` },
	{ label: `US Central (Chicago)`, value: `America/Chicago` },
	{ label: `US Mountain (Denver)`, value: `America/Denver` },
	{ label: `US Mountain No DST (Phoenix)`, value: `America/Phoenix` },
	{ label: `US Pacific (Los Angeles)`, value: `America/Los_Angeles` },
	{ label: `US Alaska (Anchorage)`, value: `America/Anchorage` },
	{ label: `US Hawaii (Honolulu)`, value: `Pacific/Honolulu` },

	{ label: `Canada Eastern (Toronto)`, value: `America/Toronto` },
	{ label: `Canada Pacific (Vancouver)`, value: `America/Vancouver` },
	{ label: `Mexico City`, value: `America/Mexico_City` },
	{ label: `Brazil (Sao Paulo)`, value: `America/Sao_Paulo` },

	{ label: `UK (London)`, value: `Europe/London` },
	{ label: `Ireland (Dublin)`, value: `Europe/Dublin` },
	{ label: `Portugal (Lisbon)`, value: `Europe/Lisbon` },
	{ label: `France (Paris)`, value: `Europe/Paris` },
	{ label: `Germany (Berlin)`, value: `Europe/Berlin` },
	{ label: `Italy (Rome)`, value: `Europe/Rome` },
	{ label: `Spain (Madrid)`, value: `Europe/Madrid` },
	{ label: `Netherlands (Amsterdam)`, value: `Europe/Amsterdam` },
	{ label: `Poland (Warsaw)`, value: `Europe/Warsaw` },
	{ label: `Greece (Athens)`, value: `Europe/Athens` },

	{ label: `South Africa (Johannesburg)`, value: `Africa/Johannesburg` },
	{ label: `Egypt (Cairo)`, value: `Africa/Cairo` },

	{ label: `UAE (Dubai)`, value: `Asia/Dubai` },
	{ label: `India (Kolkata)`, value: `Asia/Kolkata` },
	{ label: `Singapore`, value: `Asia/Singapore` },
	{ label: `Philippines (Manila)`, value: `Asia/Manila` },
	{ label: `Hong Kong`, value: `Asia/Hong_Kong` },
	{ label: `China (Shanghai)`, value: `Asia/Shanghai` },
	{ label: `South Korea (Seoul)`, value: `Asia/Seoul` },
	{ label: `Japan (Tokyo)`, value: `Asia/Tokyo` },

	{ label: `Australia Western (Perth)`, value: `Australia/Perth` },
	{ label: `Australia Central (Adelaide)`, value: `Australia/Adelaide` },
	{ label: `Australia Queensland (Brisbane)`, value: `Australia/Brisbane` },
	{ label: `Australia Eastern (Sydney)`, value: `Australia/Sydney` },
	{ label: `Australia Eastern (Melbourne)`, value: `Australia/Melbourne` },
	{ label: `New Zealand (Auckland)`, value: `Pacific/Auckland` },
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
	return TIMEZONES
		.filter(tz => tz.label.toLowerCase().includes(focused))
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
