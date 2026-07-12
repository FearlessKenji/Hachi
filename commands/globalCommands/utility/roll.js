// /roll command.
//
// Parses dice expressions such as 2d20kh1+5, rolls securely enough for casual
// utility use, formats kept/dropped dice, and keeps output within Discord limits.
const {
	ApplicationIntegrationType,
	InteractionContextType,
	MessageFlags,
	SlashCommandBuilder,
} = require(`discord.js`);

const MAX_DICE = 100;
const MAX_SIDES = 1000;
const MAX_EXPLOSIONS = 100;
const MAX_EXPRESSIONS = 10;
const MAX_MESSAGE_LENGTH = 1900;
const MAX_ROLLS_DISPLAYED = 60;

// Normalize into a compact grammar before parsing. Spaces and separators are
// user convenience; the parser below expects terms like 2d20kh1+5.
function normalizeInput(input) {
	return input
		.trim()
		.toLowerCase()
		.replace(/d%/g, `d100`)
		.replace(/\s*([+-])\s*/g, `$1`)
		.replace(/[;,]+/g, ` `)
		.replace(/\s+/g, ` `);
}

// Discord hard-limits message length. Use a smaller limit so the error/truncated
// note itself still fits and the response remains readable.
function truncateOutput(content) {
	if (content.length <= MAX_MESSAGE_LENGTH) {
		return content;
	}

	return `${content.slice(0, MAX_MESSAGE_LENGTH - 70)}
Output truncated. Try fewer dice or fewer expressions.`;
}

function rand(max) {
	return Math.floor(Math.random() * max) + 1;
}

function sum(values) {
	return values.reduce((total, value) => total + value, 0);
}

function parseInteger(value, label) {
	const number = Number(value);

	if (!Number.isInteger(number)) {
		throw new Error(`${label} must be a whole number.`);
	}

	return number;
}

function validateDice(dice, sides) {
	if (dice < 1 || dice > MAX_DICE) {
		throw new Error(`Dice must be 1-${MAX_DICE}.`);
	}

	if (sides < 2 || sides > MAX_SIDES) {
		throw new Error(`Sides must be 2-${MAX_SIDES}.`);
	}
}

// Keep-high/keep-low rules return indexes, not values, so duplicate dice values
// are handled correctly and the original roll order can be preserved in output.
function getKeptIndexes(rolls, keepRule) {
	if (!keepRule) {
		return new Set(rolls.map((_, index) => index));
	}

	const type = keepRule.slice(0, 2);
	const count = parseInteger(keepRule.slice(2), `Keep count`);

	if (count < 1) {
		throw new Error(`Keep count must be at least 1.`);
	}

	if (count > rolls.length) {
		throw new Error(`Cannot keep more dice than rolled.`);
	}

	const sorted = rolls
		.map((value, index) => ({ index, value }))
		.sort((left, right) => {
			const valueSort = type === `kh` ?
				right.value - left.value :
				left.value - right.value;

			return valueSort || left.index - right.index;
		});

	return new Set(sorted.slice(0, count).map(roll => roll.index));
}

function formatRolls(rolls, keptIndexes) {
	const visibleRolls = rolls.slice(0, MAX_ROLLS_DISPLAYED).map((roll, index) => {
		if (keptIndexes.has(index)) {
			return String(roll);
		}

		return `~~${roll}~~`;
	});

	if (rolls.length > MAX_ROLLS_DISPLAYED) {
		visibleRolls.push(`...${rolls.length - MAX_ROLLS_DISPLAYED} more`);
	}

	return visibleRolls.join(`, `);
}

// Supports normal dice, exploding dice with !, and keep-high/keep-low suffixes.
// Explosions are capped so a pathological d1-style loop cannot run forever.
function rollDice(expression) {
	const match = expression.match(/^(\d*)d(\d+)(!?)((?:kh|kl)\d+)?$/);

	if (!match) {
		throw new Error(`Invalid dice format.`);
	}

	const dice = parseInteger(match[1] || 1, `Dice`);
	const sides = parseInteger(match[2], `Sides`);
	const exploding = match[3] === `!`;
	const keepRule = match[4];

	validateDice(dice, sides);

	const rolls = [];

	for (let index = 0; index < dice; index += 1) {
		let roll = rand(sides);
		let explosions = 0;

		rolls.push(roll);

		while (exploding && roll === sides && explosions < MAX_EXPLOSIONS) {
			explosions += 1;
			roll = rand(sides);
			rolls.push(roll);
		}
	}

	const keptIndexes = getKeptIndexes(rolls, keepRule);
	const keptRolls = rolls.filter((_, index) => keptIndexes.has(index));

	return {
		label: `${expression} [${formatRolls(rolls, keptIndexes)}]`,
		total: sum(keptRolls),
	};
}

// Advantage/disadvantage are intentionally limited to a single die. That matches
// common tabletop usage and avoids ambiguous behavior like "2d20a".
function rollAdvantage(expression, hasAdvantage) {
	const match = expression.match(/^(\d*)d(\d+)$/);

	if (!match) {
		throw new Error(`Invalid advantage format.`);
	}

	const dice = parseInteger(match[1] || 1, `Dice`);
	const sides = parseInteger(match[2], `Sides`);

	validateDice(dice, sides);

	if (dice !== 1) {
		throw new Error(`Advantage/disadvantage only works with 1 die.`);
	}

	const first = rand(sides);
	const second = rand(sides);
	const chosen = hasAdvantage ? Math.max(first, second) : Math.min(first, second);
	const suffix = hasAdvantage ? `a` : `d`;

	return `Roll \`${expression}${suffix}\`
Rolls: ${first}, ${second}
Result: **${chosen}**`;
}

function parseModifier(term) {
	const number = parseInteger(term, `Modifier`);

	return {
		label: String(number),
		total: number,
	};
}

function parseTerm(cleanTerm) {
	if (cleanTerm.includes(`d`)) {
		return rollDice(cleanTerm);
	}

	return parseModifier(cleanTerm);
}

// Parse one full expression, which may be a die shortcut, advantage shortcut, or
// a signed list of dice/modifier terms.
function parseExpression(expression) {
	if (/^\d+$/.test(expression)) {
		const result = rollDice(`d${expression}`);

		return [
			`Roll \`d${expression}\``,
			`${result.label} = ${result.total}`,
			`**Total: ${result.total}**`,
		].join(`\n`);
	}

	if (/^[+-]\d+$/.test(expression)) {
		throw new Error(`Standalone modifiers are not rolls. Try \`d20${expression}\` or \`${expression.slice(1)}\` for a die shortcut.`);
	}

	if (expression.endsWith(`a`)) {
		return rollAdvantage(expression.slice(0, -1), true);
	}

	if (expression.endsWith(`d`)) {
		return rollAdvantage(expression.slice(0, -1), false);
	}

	const terms = expression.match(/[+-]?[^+-]+/g);

	if (!terms) {
		throw new Error(`Could not parse expression.`);
	}

	let total = 0;
	const breakdown = [];

	for (const term of terms) {
		const sign = term.startsWith(`-`) ? -1 : 1;
		const cleanTerm = term.replace(/^[+-]/, ``);
		const result = parseTerm(cleanTerm);
		const signedTotal = sign * result.total;
		const prefix = sign < 0 ?
			`-` :
			breakdown.length ?
				`+` :
				``;

		total += signedTotal;
		breakdown.push(`${prefix}${result.label} = ${signedTotal}`);
	}

	return [
		`Roll \`${expression}\``,
		...breakdown,
		`**Total: ${total}**`,
	].join(`\n`);
}

function getExpressions(input) {
	const normalized = normalizeInput(input);

	if (!normalized) {
		return [];
	}

	return normalized.split(/\s+/);
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName(`roll`)
		.setDescription(`Roll dice using RPG notation.`)
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
				.setName(`expression`)
				.setDescription(`Dice expression, such as d20, 2d6+1, 4d6kh3, or d20a.`)
				.setRequired(true),
		),

	help: {
		category: `general`,
		entries: [
			{
				command: `/roll`,
				description: `roll dice using RPG notation.`,
			},
		],
	},

	async execute(interaction) {
		const expressions = getExpressions(interaction.options.getString(`expression`, true));

		if (!expressions.length) {
			await interaction.reply({
				content: `Give me a dice expression like \`d20\`, \`2d6+1\`, or \`4d6kh3\`.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (expressions.length > MAX_EXPRESSIONS) {
			await interaction.reply({
				content: `Please roll ${MAX_EXPRESSIONS} expressions or fewer at once.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const results = [];

		for (const expression of expressions) {
			try {
				results.push(parseExpression(expression));
			} catch (err) {
				await interaction.reply({
					content: `Invalid expression \`${expression}\`: ${err.message}`,
					flags: MessageFlags.Ephemeral,
				});
				return;
			}
		}

		await interaction.reply({
			content: truncateOutput(results.join(`\n\n`)),
		});
	},
};
