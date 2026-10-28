#!/usr/bin/env node

// Guard the release boundary with the metadata that will ship in the tag.
// Editorial patch-note claims still require the manual audit in AGENTS.md.
const fs = require(`node:fs`);
const path = require(`node:path`);

function readJson(root, relativePath) {
	return JSON.parse(fs.readFileSync(path.join(root, relativePath), `utf8`));
}

function hasVersionHeading(content, marker, version) {
	return content.split(/\r?\n/u).some(line =>
		line === `${marker} v${version}` || line.startsWith(`${marker} v${version} - `));
}

function validateReleaseMetadata(tag, root = path.resolve(__dirname, `..`)) {
	const packageJson = readJson(root, `package.json`);
	const lock = readJson(root, `package-lock.json`);
	const version = String(packageJson.version || ``);
	const expectedTag = `hachi-v${version}`;

	if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
		throw new Error(`package.json does not contain a valid release version.`);
	}
	if (tag !== expectedTag) {
		throw new Error(`Release tag ${tag || `(missing)`} must match package.json version: ${expectedTag}.`);
	}
	if (lock.version !== version || lock.packages?.[``]?.version !== version) {
		throw new Error(`package-lock.json root versions must match package.json version ${version}.`);
	}

	const changelog = fs.readFileSync(path.join(root, `CHANGELOG.md`), `utf8`);
	const patchNotes = fs.readFileSync(path.join(root, `docs`, `patch-notes.md`), `utf8`);
	if (!hasVersionHeading(changelog, `##`, version)) {
		throw new Error(`CHANGELOG.md is missing a v${version} release section.`);
	}
	if (!hasVersionHeading(patchNotes, `#`, version)) {
		throw new Error(`docs/patch-notes.md is missing a v${version} release section.`);
	}

	return { tag: expectedTag, version };
}

if (require.main === module) {
	try {
		const { tag, version } = validateReleaseMetadata(process.argv[2]);
		console.log(`Validated ${tag} metadata for Hachi v${version}.`);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}

module.exports = { validateReleaseMetadata };
