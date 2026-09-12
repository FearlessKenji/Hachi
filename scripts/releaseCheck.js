const { spawnSync } = require(`node:child_process`);

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: process.cwd(),
		stdio: `inherit`,
	});

	if (result.error) {
		throw result.error;
	}

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

function currentBranch() {
	const result = spawnSync(`git`, [`branch`, `--show-current`], {
		cwd: process.cwd(),
		encoding: `utf8`,
	});

	if (result.error || result.status !== 0) {
		throw result.error ?? new Error(`Unable to determine the current Git branch.`);
	}

	return result.stdout.trim();
}

const branch = currentBranch();

// Release preparation must happen on a reviewable branch before it reaches main.
if (!branch || branch === `main`) {
	console.error(`Release preparation is not allowed on main. Switch to a release branch first.`);
	process.exit(1);
}

console.log(`Preparing release from branch ${branch}.`);

const npmEntryPoint = process.env.npm_execpath;

if (!npmEntryPoint) {
	console.error(`Run release preparation through npm run release:check.`);
	process.exit(1);
}

run(process.execPath, [npmEntryPoint, `run`, `check`]);
run(process.execPath, [npmEntryPoint, `run`, `lint`]);
run(process.execPath, [npmEntryPoint, `run`, `smoke`]);
run(process.execPath, [npmEntryPoint, `audit`, `--audit-level=moderate`]);
run(`git`, [`diff`, `--check`]);
