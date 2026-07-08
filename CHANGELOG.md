# Changelog

Notable changes to Hachi are documented here.

## v3.2.0 - 2026-07-08

### Added

- Added a Remote tab to HachiGen for connecting to a production Hachi server over SSH.
- Added saved remote connection settings for host, username, SSH key, port mode, remote path, and PM2 process name.
- Added SSH key selection through a file picker with private-key validation.
- Added a default SSH port option with custom-port support for forwarded or nonstandard SSH setups.
- Added Local Development / Remote Server runtime switching in HachiGen.
- Added remote support for HachiGen dashboard runtime controls, setup configuration, update checks, command deployment, database tools, PM2 status, and logs.
- Added remote database viewing, backup, audit, migration, sanitation, and status support.

### Changed

- Normalized remote paths so entries like `bots/Hachi` resolve as `~/bots/Hachi`.
- Updated HachiGen remote command logging so routine SSH/Git/database checks use readable status messages instead of full command transcripts.
- Redacted SSH command details and key paths when remote shell commands are logged.
- Updated the project version to `3.2.0`.

### Notes

- Direct remote database restore from a local backup remains disabled to avoid accidental production data replacement.
- HachiGen remembers the selected runtime target until it is changed again.

## v3.1.0 - 2026-07-07

### Added

- Added Discord raid protection tools for detecting and responding to suspicious join activity.
- Added Twitch VIP and Moderator role syncing to Discord roles.
- Added `/twitch` commands for broadcaster connection, role mapping, member verification, verification panels, manual sync, status checks, and disconnecting Twitch role sync.
- Added Twitch Device Code Flow support so Twitch role sync does not require a domain, callback URL, tunnel, or hosted backend.
- Added Twitch EventSub WebSocket support for near-real-time VIP and Moderator role updates.
- Added recurring full Twitch role reconciliation as a backup to EventSub updates.
- Added Twitch role sync database tables for broadcaster configs, verified member links, and EventSub message deduplication.
- Added command monitoring, birthday setup improvements, and broader setup/help workflow refinements.

### Changed

- Renamed the project from KenjiBot to Hachi.
- Updated README and privacy-policy documentation for Twitch role sync, raid protection, setup flows, and current configuration behavior.
- Improved startup behavior so Twitch EventSub pauses quietly when no broadcaster role mappings are configured.

### Security

- Added dependency overrides for patched `js-yaml` and `undici` versions.

## v3.0.0 - 2026-05-07

### Added

- Added Kick live notification support.
- Added Kick API authentication and stream/VOD lookup modules.
- Expanded stream notification setup to support both Twitch and Kick providers.

## v2.1.0 - 2024-04-01

### Added

- Added database-backed storage.
- Added Sequelize models for server and channel configuration.
- Added database initialization and migration support.

### Changed

- Moved persistent bot data out of JSON files and into the database.

## v2.0.0 - 2024-03-17

### Added

- Added Discord slash command support.
- Added command deployment tooling for global and guild commands.

### Changed

- Reworked command handling around Discord interactions.

## v1.0.3 - 2024-03-03

### Fixed

- Improved early runtime behavior and PM2 launch handling.

## v1.0.2 - 2024-03-02

### Changed

- Updated package metadata and early configuration handling.

## v1.0.0 - 2024-03-08

### Added

- Added initial Twitch live alert functionality.
- Added JSON-based storage for bot data.
- Added basic text commands.
