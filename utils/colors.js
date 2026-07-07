const DEFAULT_RULES_COLOR = 0xff0000;

const NAMED_COLORS = new Map([
	[`black`, 0x000000],
	[`blue`, 0x3498db],
	[`cyan`, 0x00ffff],
	[`gray`, 0x808080],
	[`grey`, 0x808080],
	[`green`, 0x57f287],
	[`magenta`, 0xff00ff],
	[`orange`, 0xffa500],
	[`pink`, 0xeb459e],
	[`purple`, 0x9b59b6],
	[`red`, 0xff0000],
	[`white`, 0xffffff],
	[`yellow`, 0xfee75c],
]);

const COLOR_AUTOCOMPLETE_CHOICES = [
	{ name: `red`, value: `red` },
	{ name: `orange`, value: `orange` },
	{ name: `yellow`, value: `yellow` },
	{ name: `green`, value: `green` },
	{ name: `blue`, value: `blue` },
	{ name: `purple`, value: `purple` },
	{ name: `cyan`, value: `cyan` },
	{ name: `magenta`, value: `magenta` },
	{ name: `pink`, value: `pink` },
	{ name: `black`, value: `black` },
	{ name: `white`, value: `white` },
	{ name: `gray`, value: `gray` },
	{ name: `#ff0000`, value: `#ff0000` },
];

function normalizeColorName(value) {
	return value
		.toLowerCase()
		.replace(/[\s_-]+/g, ``);
}

function expandShortHex(value) {
	return value
		.split(``)
		.map(character => `${character}${character}`)
		.join(``);
}

function normalizeHex(value) {
	const trimmed = value
		.trim()
		.replace(/^#/u, ``)
		.replace(/^0x/iu, ``);

	if (/^[0-9a-f]{3}$/iu.test(trimmed)) {
		return expandShortHex(trimmed);
	}

	if (/^[0-9a-f]{6}$/iu.test(trimmed)) {
		return trimmed;
	}

	return null;
}

function normalizeColorInput(input, fallbackColor = DEFAULT_RULES_COLOR) {
	if (!input) {
		return {
			color: fallbackColor,
			input: null,
			name: `red`,
		};
	}

	const value = String(input).trim();
	const namedColor = NAMED_COLORS.get(normalizeColorName(value));

	if (namedColor !== undefined) {
		return {
			color: namedColor,
			input: value,
			name: normalizeColorName(value),
		};
	}

	const hex = normalizeHex(value);

	if (!hex) {
		return null;
	}

	return {
		color: Number.parseInt(hex, 16),
		hex: `#${hex.toLowerCase()}`,
		input: value,
	};
}

function colorAutocompletes(focused) {
	const normalized = focused.toLowerCase();

	return COLOR_AUTOCOMPLETE_CHOICES
		.filter(choice => choice.name.includes(normalized) || choice.value.includes(normalized))
		.slice(0, 25);
}

function supportedColorText() {
	return `Use a hex code like #ff0000, ff0000, or 0xff0000, or one of: ${[...NAMED_COLORS.keys()].join(`, `)}.`;
}

module.exports = {
	COLOR_AUTOCOMPLETE_CHOICES,
	DEFAULT_RULES_COLOR,
	NAMED_COLORS,
	colorAutocompletes,
	normalizeColorInput,
	supportedColorText,
};
