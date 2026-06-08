const {
    SlashCommandBuilder,
    InteractionContextType,
    MessageFlags,
} = require(`discord.js`);

const MAX_DICE = 100;
const MAX_SIDES = 1000;
const MAX_EXPLOSIONS = 100;
const MAX_EXPRESSIONS = 10;

module.exports = {
    data: new SlashCommandBuilder()
        .setName(`roll`)
        .setDescription(`Roll dice using RPG notation.`)
        .addStringOption(option =>
            option
                .setName(`expression`)
                .setDescription(`Dice expression (e.g. d20, 2d6+1, 4d6kh3)`)
                .setRequired(true)
        ),

    async execute(interaction) {

        const input = interaction.options
            .getString(`expression`)
            .trim()
            .toLowerCase();

        const expressions = input.split(/\s+/).slice(0, MAX_EXPRESSIONS);

        const results = [];

        for (const expr of expressions) {
            try {
                results.push(parseExpression(expr));
            }
            catch (err) {
                return interaction.reply({
                    content: `❌ Invalid expression \`${expr}\`: ${err.message}`,
                    flags: MessageFlags.Ephemeral,
                });
            }
        }

        await interaction.reply({
            content: results.join(`\n\n`),
        });
    },
};

function parseExpression(input) {

    if (input === `d%`) input = `d100`;

    if (input.endsWith(`a`)) {
        return advantage(input.slice(0, -1), true);
    }

    if (input.endsWith(`d`)) {
        return advantage(input.slice(0, -1), false);
    }

    const terms = input.match(/[+-]?[^+-]+/g);
    if (!terms) throw new Error(`Could not parse expression`);

    let total = 0;
    const breakdown = [];

    for (const term of terms) {

        const sign = term.startsWith(`-`) ? -1 : 1;
        const clean = term.replace(/^[+-]/, ``);

        if (clean.includes(`d`)) {

            const roll = rollDice(clean);

            total += sign * roll.total;

            breakdown.push(
                `${sign < 0 ? `-` : `+`}${roll.label} = ${roll.total}`
            );

        }
        else {

            const num = Number(clean);

            if (Number.isNaN(num)) {
                throw new Error(`Invalid number: ${clean}`);
            }

            total += sign * num;
            breakdown.push(`${sign < 0 ? `-` : `+`}${num}`);
        }
    }

    return [
        `🎲 \`${input}\``,
        ...breakdown,
        `**Total → ${total}**`,
    ].join(`\n`);
}

function rollDice(expr) {

    const match = expr.match(
        /^(\d*)d(\d+)(!?)((?:kh|kl)\d+)?$/
    );

    if (!match) throw new Error(`Invalid dice format`);

    const dice = Number(match[1] || 1);
    const sides = Number(match[2]);
    const exploding = match[3] === `!`;
    const keepRule = match[4];

    if (dice < 1 || dice > MAX_DICE) {
        throw new Error(`Dice must be 1-${MAX_DICE}`);
    }

    if (sides < 2 || sides > MAX_SIDES) {
        throw new Error(`Sides must be 2-${MAX_SIDES}`);
    }

    let rolls = [];

    for (let i = 0; i < dice; i++) {

        let roll = rand(sides);
        rolls.push(roll);

        if (exploding) {

            let explosions = 0;

            while (roll === sides && explosions < MAX_EXPLOSIONS) {
                explosions++;
                roll = rand(sides);
                rolls.push(roll);
            }
        }
    }

    let kept = [...rolls];

    if (keepRule) {

        const type = keepRule.slice(0, 2);
        const count = Number(keepRule.slice(2));

        if (count > rolls.length) {
            throw new Error(`Cannot keep more dice than rolled`);
        }

        if (type === `kh`) {
            kept = [...rolls].sort((a, b) => b - a).slice(0, count);
        }
        else {
            kept = [...rolls].sort((a, b) => a - b).slice(0, count);
        }
    }

    return {
        total: sum(kept),
        label: `${expr} [${rolls.join(`, `)}]`,
    };
}

function advantage(expr, adv) {

    const match = expr.match(/^(\d*)d(\d+)$/);
    if (!match) throw new Error(`Invalid advantage format`);

    const dice = Number(match[1] || 1);
    const sides = Number(match[2]);

    if (dice !== 1) {
        throw new Error(`Advantage/disadvantage only works with 1 die`);
    }

    const a = rand(sides);
    const b = rand(sides);

    const chosen = adv ? Math.max(a, b) : Math.min(a, b);

    return `🎲 \`${expr}${adv ? `a` : `d`}\`
Rolls → ${a}, ${b}
Result → **${chosen}**`;
}

function rand(max) {
    return Math.floor(Math.random() * max) + 1;
}

function sum(arr) {
    return arr.reduce((a, b) => a + b, 0);
}