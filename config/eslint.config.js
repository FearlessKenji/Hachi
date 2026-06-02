const js = require(`@eslint/js`);

module.exports = [
	js.configs.recommended,

	{
		languageOptions: {
			ecmaVersion: `latest`,
			sourceType: `commonjs`,

			globals: {
				clearInterval: `readonly`,
				clearTimeout: `readonly`,
				console: `readonly`,
				fetch: `readonly`,
				module: `readonly`,
				process: `readonly`,
				require: `readonly`,
				setInterval: `readonly`,
				setTimeout: `readonly`,
				__dirname: `readonly`,
			},
		},

		rules: {
			// =========================================================
			// CORE SAFETY (prevent real runtime bugs)
			// =========================================================

			'eqeqeq': [`error`, `always`],
			'no-async-promise-executor': `error`,
			'no-else-return': `error`,
			'no-empty-function': `error`,
			'no-eval': `error`,
			'no-implicit-globals': `error`,
			'no-implied-eval': `error`,
			'no-lonely-if': `error`,
			'no-param-reassign': `error`,
			'no-promise-executor-return': `error`,
			'no-return-await': `error`,
			'no-undef': `error`,
			'no-unused-vars': [`error`, { argsIgnorePattern: `^_` }],
			'no-useless-return': `error`,
			'no-var': `error`,
			'prefer-const': `error`,
			'require-atomic-updates': `error`,

			// =========================================================
			// DEBUGGING CONTROL
			// =========================================================

			'no-console': `off`,
			'no-shadow': [`error`, { allow: [`err`, `resolve`, `reject`] }],

			// =========================================================
			// STYLE ENFORCEMENT (CONSISTENT CODE BASE)
			// =========================================================

			'arrow-spacing': [`error`, { before: true, after: true }],
			'brace-style': [`error`, `1tbs`, { allowSingleLine: true }],
			'comma-dangle': [`error`, `always-multiline`],
			'comma-spacing': [`error`, { before: false, after: true }],
			'comma-style': [`error`, `last`],
			'curly': [`error`, `all`],
			'dot-location': [`error`, `property`],
			'indent': [`error`, `tab`],
			'keyword-spacing': [`error`],
			'linebreak-style': [`error`, `unix`],
			'max-len': [`error`, { code: 200, ignoreUrls: true }],
			'max-statements-per-line': [`error`, { max: 1 }],
			'multiline-ternary': [`error`, `always-multiline`],
			'no-multi-spaces': `error`,
			'no-multiple-empty-lines': [`error`, { max: 1, maxEOF: 0 }],
			'no-trailing-spaces': `error`,
			'object-curly-spacing': [`error`, `always`],
			'operator-linebreak': [`error`, `after`],
			'quotes': [`error`, `backtick`, { avoidEscape: true }],
			'semi': [`error`, `always`],
			'space-before-blocks': `error`,
			'space-before-function-paren': [
				`error`,
				{
					anonymous: `never`,
					named: `never`,
					asyncArrow: `always`,
				},
			],

			'space-in-parens': [`error`, `never`],
			'space-infix-ops': `error`,
			'spaced-comment': [`error`, `always`],
			'template-curly-spacing': [`error`, `never`],
			'yoda': `error`,

		},
	},
];