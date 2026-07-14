#!/usr/bin/env node

const childProcess = require(`node:child_process`);
const fs = require(`node:fs`);
const path = require(`node:path`);

const projectRoot = path.resolve(__dirname, `..`);
const ignoredDirectories = new Set([
	`.git`,
	`node_modules`,
]);

function normalizePath(filePath) {
	return filePath.replace(/\\/gu, `/`);
}

function listTrackedJavaScriptFiles() {
	const result = childProcess.spawnSync(`git`, [`ls-files`, `--`, `*.js`], {
		cwd: projectRoot,
		encoding: `utf8`,
	});

	if (result.status !== 0 || result.error) {
		return null;
	}

	return result.stdout
		.split(/\r?\n/u)
		.map(line => line.trim())
		.filter(Boolean);
}

function listJavaScriptFiles(directory) {
	const files = [];

	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				files.push(...listJavaScriptFiles(path.join(directory, entry.name)));
			}

			continue;
		}

		if (entry.isFile() && entry.name.endsWith(`.js`)) {
			files.push(normalizePath(path.relative(projectRoot, path.join(directory, entry.name))));
		}
	}

	return files;
}

function getJavaScriptFiles() {
	return listTrackedJavaScriptFiles() || listJavaScriptFiles(projectRoot);
}

function checkFile(file) {
	const result = childProcess.spawnSync(process.execPath, [`--check`, file], {
		cwd: projectRoot,
		encoding: `utf8`,
	});

	if (result.status === 0) {
		return null;
	}

	return {
		file,
		output: `${result.stdout || ``}${result.stderr || ``}`.trim(),
		status: result.status,
	};
}

function main() {
	const files = getJavaScriptFiles();
	const failures = files
		.map(checkFile)
		.filter(Boolean);

	if (!files.length) {
		console.log(`No JavaScript files found.`);
		return;
	}

	if (!failures.length) {
		console.log(`Syntax check passed for ${files.length} JavaScript file${files.length === 1 ? `` : `s`}.`);
		return;
	}

	for (const failure of failures) {
		console.error(`[fail] ${failure.file}`);
		console.error(failure.output || `node --check exited with ${failure.status}.`);
	}

	process.exitCode = 1;
}

main();
