module.exports = {
	apps: [
		{
			cwd: `./`,
			name: `KenjiBot`,
			script: `index.js`,
			exec_mode: `fork`,
			instances: 1,
			max_restarts: 5,
			autorestart: false,
			min_uptime: 30000,
			kill_timeout: 10000,
			restart_delay: 60000,

			env: {
				NODE_ENV: `development`,
			},
			log_date_format: `MM-DD-YYYY HH:mm`,
		},
	],
};
