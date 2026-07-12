# Changelog

Notable changes to Hachi are documented here.

## Unreleased

No unreleased changes yet.

## v3.3.0 - 2026-07-12

### Added

- Added mandatory encrypted database support through SQLCipher-compatible `better-sqlite3-multiple-ciphers`.
- Added HachiGen database protection controls for key generation, verification, conversion, key rotation, encrypted backups, backup metadata, and key backup export.
- Added encrypted `.env` secret storage with per-value encryption, automatic HachiGen conversion, runtime decryption, redacted reads, and short-lived copy-secret support.
- Added a manual Hachi patch-note announcement framework backed by user-facing `docs/patch-notes.md`.
- Added `/setup` Hachi Updates channel selection so servers can opt in to manually sent Hachi patch notes.
- Added owner-only `/announce patch-notes` for manually broadcasting the latest user-facing patch notes to opted-in servers.
- Added `botOwners` and `guildIds` array support in `config/config.json`, while retaining compatibility with old `botOwner` and `guildId` config files.
- Added multi-guild command deployment support for every configured guild ID.
- Added `leftAt` tracking for servers Hachi leaves so server data is retained briefly instead of being removed immediately.
- Added a seven-day cleanup window for left servers, including guild-scoped database rows and archived raid evidence under `data/evidence/<guildId>/`.
- Startup reconciliation now marks active server rows as left when Hachi is no longer in those guilds, covering missed leave events while offline.
- Added broad inline code comments and `docs/developer-guide.md` to make the project easier to inspect file-by-file.

### Changed

- Hachi now requires encrypted database and encrypted `.env` secret configuration before startup.
- HachiGen now saves Setup config with plural owner/guild arrays and reads older singular config files for compatibility.
- HachiGen update, remote, database, and runtime logs now use more readable normalized messages for routine actions.
- Updated the project version to `3.3.0`.

### Fixed

- Added startup server-row reconciliation so Hachi creates missing `servers` table rows for guilds it is already in, recovering from missed join events or local/production database swaps.
- Rejoining a server now clears its `leftAt` marker before the cleanup window can remove its data.
- Fixed database protection status wording so encrypted databases that open with the configured key are shown as encrypted, while unreadable files are treated as invalid format.
- Fixed database key path display normalization in HachiGen.

### Security

- Database files are encrypted at rest by default and plaintext databases are converted or rejected.
- Stored `.env` values are encrypted individually instead of being saved as plaintext.
- Decrypted secrets are kept out of HachiGen reads and logs, with controlled copy-to-clipboard behavior.

## v3.2.0 - 2026-07-08

### Added

- Added a Remote tab to HachiGen for connecting to a production Hachi server over SSH.
- Added saved remote connection settings for host, username, SSH key, port mode, remote path, and PM2 process name.
- Added SSH key selection through a file picker with private-key validation.
- Added a default SSH port option with custom-port support for forwarded or nonstandard SSH setups.
- Added Local Development / Remote Server runtime switching in HachiGen.
- Added remote support for HachiGen dashboard runtime controls, setup configuration, update checks, command deployment, database tools, PM2 status, and logs.
- Added remote database viewing, backup, audit, migration, sanitation, and status support.
- Added automatic HachiGen releases when `main` receives a `package.json` version bump.

### Changed

- Normalized remote paths so entries like `bots/Hachi` resolve as `~/bots/Hachi`.
- Updated HachiGen remote command logging so routine SSH/Git/database checks use readable status messages instead of full command transcripts.
- Updated automatic releases to create the current version tag when it is missing, even if the workflow was added after the version bump.
- Redacted SSH command details and key paths when remote shell commands are logged.
- Updated the project version to `3.2.0`.

### Notes

- Direct remote database restore from a local backup remains disabled to avoid accidental production data replacement.
- HachiGen remembers the selected runtime target until it is changed again.

## v3.1.0 - 2026-07-07

### Added

- Added `/setup` as a setup hub with buttons for Stream Notifications, Security Reporting, Raid Protection, and related setup flows.
- Moved stream notification setup to `/stream setup`.
- Added application command monitoring configuration under `/security setup`.
- Added raid protection configuration under `/raid setup`.
- Added `/help` with ephemeral replies, permission-aware command filtering, and `/help public:true` for moderator/admin public help posts through a category picker.
- Added optional public application command monitoring with embed reports sent to the configured reporting channel.
- Added command monitoring report details for triggering user, responding application, command name, command type when detectable, install context, source channel, interaction ID, and jump links.
- Added clearer console output, structured logs, and pretty-readable logs for command-monitoring investigations.
- Added command monitoring whitelists for trusted applications and channels:
  - `/security whitelist app action:Add application_id:<id> name:<optional>`
  - `/security whitelist app action:Remove application_id:<id>`
  - `/security whitelist channel action:Add channel:<channel>`
  - `/security whitelist channel action:Remove channel:<channel>`
  - `/security whitelist list`
- Added `/raid setup` for raid protection settings, including quarantine role, moderator alert role, alert channel, report channel, message/app spam thresholds, join spike thresholds, quarantine action, timeout action, spam deletion action, and timeout duration.
- Added `/raid drill` to simulate raid behavior without assigning roles, timing users out, deleting messages, pinging roles, or editing permissions.
- Added `/raid audit` to check raid readiness, quarantine reliability, role hierarchy, and suggested configuration improvements without forcing changes.
- Added `/raid sync` for intentionally applying quarantine permission denies across channels/categories.
- Added manual `/raid quarantine` and `/raid release`.
- Added raid incident review commands:
  - `/raid incidents`
  - `/raid incident`
  - `/raid report`
  - `/raid evidence`
- Added raid incident storage for affected users, actions taken, action failures, captured message evidence, attachment metadata, and archived files when available.
- Added raid reports posted to the configured report/mod channel.
- Added rolling recent-message evidence capture so Hachi does not permanently store every message.
- Added attachment archiving under `data/evidence/` when raid evidence is saved.
- Added duplicate spam collapsing in reports while preserving stored evidence.
- Added Twitch VIP and Moderator role syncing to Discord roles.
- Added `/twitch` commands for broadcaster connection, role mapping, member verification, verification panels, manual sync, status checks, and disconnecting Twitch role sync.
- Added Twitch Device Code Flow support so Twitch role sync does not require a domain, callback URL, tunnel, or hosted backend.
- Added Twitch EventSub WebSocket support for near-real-time VIP and Moderator role updates.
- Added recurring full Twitch role reconciliation as a backup to EventSub updates.
- Added Twitch role sync database tables for broadcaster configs, verified member links, and EventSub message deduplication.
- Added birthday setup improvements and broader setup workflow refinements.

### Changed

- Renamed the project from KenjiBot to Hachi.
- Updated README and privacy-policy documentation for Twitch role sync, raid protection, setup flows, and current configuration behavior.
- Improved startup behavior so Twitch EventSub pauses quietly when no broadcaster role mappings are configured.
- Command monitoring whitelists suppress monitoring reports only; raid spam detection can still see whitelisted app/channel messages.
- Command monitoring logs message content internally for investigation, but monitoring embeds do not display message content.

### Security

- Added dependency overrides for patched `js-yaml` and `undici` versions.

### Notes

- Command monitoring only detects public command responses Discord emits as messages.
- Ephemeral responses cannot be seen by Hachi.
- Commands blocked by `Use External Apps` usually become ephemeral and cannot be monitored.
- Third-party command names may show as unavailable depending on what Discord exposes.

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
