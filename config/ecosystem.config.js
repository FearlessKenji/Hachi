module.exports = {
	apps: [
		{
			cwd: `./`,
			name: `Hachi`,
			script: `index.js`,
			exec_mode: `fork`,
			instances: 1,
			max_restarts: 5,
			autorestart: true,
			stop_exit_codes: [78],
			min_uptime: 30000,
			kill_timeout: 10000,
			restart_delay: 60000,

			env: {
				NODE_ENV: `production`,
			},
			log_date_format: `MM-DD-YYYY HH:mm`,
		},
	],
};
