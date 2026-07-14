# Hachi Developer Guide

This guide explains how the project is organized and how the major variables,
functions, modules, and runtime flows fit together. Keep detailed explanations
here when they describe architecture or intent. Inline code comments should stay
close to the few places where the code is non-obvious, security-sensitive, or
crosses process boundaries.

## Project Shape

Hachi is the Discord bot runtime:

- `index.js` starts the Discord bot runtime.
- HachiGen is the separate Electron desktop manager that installs, configures,
  validates, updates, starts, stops, and inspects Hachi. Its source now lives in
  the [HachiGen repository](https://github.com/FearlessKenji/HachiGen).

Supporting folders:

- `auth/` handles provider access-token refresh.
- `commands/` contains Discord slash commands and context menu commands.
- `config/` contains startup validation, runtime process config, lint config,
  blank config templates, and secret encryption helpers.
- `database/` contains Sequelize models, schema audit/migration logic, database
  initialization, SQLCipher integration, and tool/database helper connections.
- `events/` contains Discord event handlers.
- `modules/` contains stream-provider integrations and larger feature logic.
- `utils/` contains reusable helpers shared across commands, events, and modules.
- `scripts/` contains local test and maintenance scripts.
- `docs/` contains user-facing docs and this developer guide.

Generated/vendor folders such as `node_modules/`, packaged artifacts, local
databases, logs, backups, and secret key files should not be treated as source.

## Runtime Entry Point

`index.js` is the bot process entry point.

The startup order matters:

1. `dotenv/config` loads `.env`.
2. `config/secretEncryption.js` decrypts encrypted `.env` values in memory.
3. `config/configCheck.js` validates required env fields, encrypted secrets,
   encrypted database settings, and `config/config.json`.
4. Discord.js creates the `Client`.
5. Cron jobs are created from `utils/crons.js`.
6. Command modules are loaded through `utils/commandLoader.js`.
7. Event handlers from `events/` are registered.
8. The client logs in with `process.env.TOKEN`.

Important variables:

- `client` is the live Discord.js client. Commands, events, and cron jobs use it
  as the gateway to Discord.
- `client.commands` is a `Collection` keyed by slash command name. Interaction
  handling uses it to route commands to the right module.
- `eventsPath` points to the event modules. Every event module exports `name`,
  `execute`, and optionally `once`.

## Configuration Files

Hachi uses two runtime configuration files:

- `.env` stores install-specific IDs, tokens, secrets, and bootstrap key pointers.
- `config/config.json` stores bot settings such as owner IDs, guild IDs, and
  cron schedules.

Required `.env` fields:

- `TOKEN` is the Discord bot token.
- `clientId` is the Discord application/client ID.
- `twitchClientId` and `twitchSecret` identify the Twitch developer app.
- `kickClientId` and `kickSecret` identify the Kick developer app.

Required `config/config.json` fields:

- `botOwners` is the array of Discord user IDs for owner-only controls. The old
  `botOwner` string is still accepted for existing installs.
- `guildIds` is the array of Discord server IDs used for guild command
  deployment/testing. The old `guildId` string is still accepted for existing
  installs.
- `twitchCron`, `kickCron`, `birthdayCron`, `statusCron`, and `authCron` control
  scheduled jobs.

`blank.env` and `config/blank.json` define the shape HachiGen presents on first
setup. They are templates, not runtime secrets.

## Secret Encryption

Secret encryption lives in `config/secretEncryption.js`.

The design goal is that `.env` remains editable and inspectable, but every
managed value is encrypted individually. That lets HachiGen replace or preserve a
single field without rewriting the whole file as an opaque blob.

Important constants:

- `ENCRYPTED_VALUE_PREFIX` is the marker for encrypted values. Current values use
  `enc:v1:aes-256-gcm:...`.
- `SECRET_ENV_FIELDS` lists the Setup-page fields HachiGen manages directly.
- `SECRET_PROTECTION_ENV_FIELDS` lists the bootstrap fields that cannot be
  encrypted because Hachi needs them to find the key.
- `DATABASE_PROTECTION_ENV_FIELDS` lists database key bootstrap fields that must
  also remain plaintext.
- `UNPROTECTED_ENV_FIELDS` combines both bootstrap lists so helper functions know
  which keys should never be encrypted as normal values.

Important functions:

- `parseDotEnvContent(content)` and `parseDotEnvFile(envPath)` parse the simple
  `.env` format HachiGen writes.
- `generateSecretKey()` creates a 32-byte random key encoded as base64url text.
- `getDefaultSecretKeyFile()` normalizes the recommended key location across
  Windows, macOS, and Linux.
- `resolveKeyFilePath(value, cwd, env)` expands environment variables, `~`, and
  relative paths so key-file pointers work across local and remote installs.
- `readSecretKeyFromEnv(env, cwd)` reads either `HACHI_SECRETS_KEY` or the file
  referenced by `HACHI_SECRETS_KEY_FILE`.
- `encryptSecretValue(field, value, rawKey)` encrypts one `.env` value.
- `decryptSecretValue(field, value, rawKey)` decrypts one encrypted `.env` value.
- `decryptEnvSecrets(env, options)` mutates an env object in memory by replacing
  encrypted values with plaintext values for runtime use.
- `inspectEnvValues()` and `inspectEnvFile()` report whether fields are missing,
  plaintext, or encrypted.
- `redactSecretText(text)` removes known secret values from logs and error text.

The encrypted value format is:

```text
enc:v1:aes-256-gcm:<key-id>:<iv>:<tag>:<ciphertext>
```

The `key-id` is a short fingerprint of the derived encryption key. It is not the
key and cannot decrypt anything. It only helps produce clearer error messages
when a value was encrypted with a different key.

Hachi derives the AES key with HKDF-SHA-256 before encrypting. The field name is
used as authenticated additional data, so encrypted text copied from one field to
another will not decrypt as a different field.

## Config Validation

`config/configCheck.js` is the shared startup gate. HachiGen calls it during
validation, and Hachi calls it before logging into Discord.

It validates in this order:

1. Secret encryption is enabled with `HACHI_SECRETS_ENCRYPTION=encrypted`.
2. No protectable `.env` fields are still plaintext.
3. Encrypted `.env` values decrypt successfully.
4. Required `.env` fields exist after decryption.
5. Database encryption is enabled with `HACHI_DB_ENCRYPTION=encrypted`.
6. The database key exists and can be read.
7. The SQLCipher driver is installed.
8. `database/database.sqlite` is encrypted or missing; plaintext is rejected.
9. Existing encrypted databases can be opened with the configured key.
10. `config/config.json` exists, parses, and has required fields.

If validation fails, `fatal(message)` writes a fatal log entry and exits with
`CONFIG_EXIT_CODE` (`78`), which callers can treat as configuration failure.

## Database Encryption

Database encryption lives mostly in `database/dbEncryption.js`.

Important constants:

- `CIPHER_DRIVER_PACKAGE` is the native SQLCipher-capable driver package.
- `SQLITE_HEADER` is the normal plain SQLite file header. If the file starts with
  this header, it is plaintext and must be converted before Hachi runs.
- `BACKUP_METADATA_TYPE` and `BACKUP_METADATA_VERSION` identify metadata files
  written beside backups.
- `KEY_FINGERPRINT_CONTEXT` scopes database-key fingerprints so they cannot be
  confused with other fingerprints in the project.

Important functions:

- `isDatabaseProtectionEnabled(value)` accepts values that mean database
  protection has been prepared or enabled.
- `isEncryptedDatabaseRuntimeEnabled(value)` accepts only values that mean the
  runtime should use SQLCipher.
- `readDatabaseKeyFromEnv()` and `readDatabaseKeyFromEnvFile()` read either
  `HACHI_DB_KEY` or `HACHI_DB_KEY_FILE`.
- `databaseFileStatus(dbPath)` checks whether a database is missing, plaintext,
  encrypted-looking, or invalid based on file existence and header bytes.
- `databaseAccessStatus(options)` tries to open encrypted-looking databases with
  the configured key and reports verified/invalid status.
- `openSqlCipherDatabase(options)` opens a `better-sqlite3-multiple-ciphers`
  connection and applies SQLCipher pragmas.
- `convertPlainDatabaseToEncrypted(options)` copies a plaintext SQLite database
  into an encrypted SQLCipher database.
- `rekeyEncryptedDatabase(options)` rotates the key for an existing encrypted
  database.
- `writeDatabaseBackupMetadata(options)` writes metadata beside a backup so
  HachiGen can tell which key was current when it was made.
- `describeDatabaseBackup(options)` classifies backups as current-key, older-key,
  plaintext, invalid, not verified, or key-required.
- `rotateDatabaseBackups(options)` updates eligible backups to the current key
  and metadata format.

`database/sqlcipherSqlite3.js` adapts `better-sqlite3-multiple-ciphers` to the
callback-shaped API Sequelize expects from `sqlite3`. This lets Hachi keep using
Sequelize models while opening encrypted databases underneath.

`database/dbToolConnection.js` gives tools and HachiGen database viewers one
promise-based interface that can open either plaintext databases during migration
or encrypted databases after protection is enabled.

`database/dbObjects.js` creates the Sequelize instance, selects the encrypted
dialect module when `HACHI_DB_ENCRYPTION=encrypted`, registers every model, and
declares associations.

`database/dbAudit.js` checks whether the actual SQLite schema matches the model
expectations. It also powers migration/sanitation flows in HachiGen.

`database/dbInit.js` initializes and synchronizes the database at runtime.

## HachiGen Integration

HachiGen is maintained in the separate
[HachiGen repository](https://github.com/FearlessKenji/HachiGen). Hachi still
keeps the runtime modules HachiGen needs to operate safely:

- `blank.env` and `config/blank.json` define the first-run Setup shape.
- `config/secretEncryption.js` encrypts individual `.env` values and decrypts
  them in memory during startup.
- `database/dbAudit.js`, `database/dbEncryption.js`, and
  `database/dbToolConnection.js` provide schema, SQLCipher, backup, and tool
  access logic that HachiGen calls against the selected Hachi install.
- `config/configCheck.js` is the shared startup gate HachiGen runs after saving
  or validating configuration.

HachiGen creates local runtime artifacts inside a selected Hachi install, such
as `manager/backups/` and `.hachigen/`. Those folders are ignored because they
belong to an individual installation, not to source control.

## Commands

Command files live under `commands/`.

Common command export shape:

```js
module.exports = {
	data: new SlashCommandBuilder(),
	async execute(interaction) {},
	async autocomplete(interaction) {},
	async handleComponent(interaction) {},
	async handleModal(interaction) {},
	help: {},
};
```

Not every command exports every handler. `utils/commandLoader.js` validates the
required pieces and attaches metadata such as the command file path and scope.

Command folders:

- `commands/globalCommands/` contains commands deployed globally.
- `commands/guildCommands/` contains guild-only commands.
- `commands/globalCommands/setup/` contains the setup hub command.
- `commands/globalCommands/admin/` contains moderation/admin flows.
- `commands/globalCommands/utility/` contains user-facing utilities.
- `commands/globalCommands/context/` contains message context menu commands.

Large interactive commands such as `reaction.js`, `stream.js`, `raid.js`, and
`rules.js` use temporary in-memory maps keyed by generated IDs. Those maps hold
pending setup state between Discord component interactions. They are intentionally
short-lived UI state, not database state.

## Events

Event modules live under `events/`.

Common event export shape:

```js
module.exports = {
	name: Events.SomeEvent,
	once: true,
	async execute(...args) {},
};
```

Important event responsibilities:

- `ready.js` initializes the database, reconciles server rows, starts cron jobs,
  and performs startup work.
- `eventsInteractionCreate.js` routes slash commands, autocomplete requests,
  buttons, selects, modals, and command component handlers.
- `guildCreate.js` and `guildDelete.js` reconcile server records when Hachi joins
  or leaves a server.
- `messageReactionAdd.js` and `messageReactionRemove.js` power reaction-role
  changes and rules verification.
- `messageDelete.js` and `channelDelete.js` clean up records tied to deleted
  Discord objects.
- `messageCreate.js` supports command-monitoring/security reporting.
- `guildMemberAdd.js` supports raid-protection join-spike tracking.

## Modules

Provider modules live under `modules/`.

Twitch/Kick fetchers:

- `getTwitch.js` and `getKick.js` are high-level cron entry points.
- `twitchStreams.js`, `twitchChannel.js`, `twitchVods.js`, `kickStreams.js`,
  `kickUser.js`, and `kickVods.js` perform provider API calls.
- `streamUtils.js` holds shared notification/embed/message update helpers.

Twitch role sync:

- `twitchRoles.js` handles Twitch device-code authorization, token validation,
  role mapping, VIP/moderator reconciliation, and member verification.
- `twitchRoleEventSub.js` handles EventSub-related lifecycle where applicable.

Provider auth:

- `auth/fetchAuthToken.js` requests provider app tokens.
- `auth/refreshAuthTokens.js` refreshes Twitch and Kick app auth tokens.
- `auth/authTokens.js` persists and retrieves provider auth-token state.

## Utilities

Utilities live under `utils/`.

Common helpers:

- `writeLog.js` normalizes application logging and crash handlers.
- `crons.js` creates scheduled jobs from config.
- `commandLoader.js` discovers command modules and deployable command data.
- `helpCatalog.js` builds the permission-aware `/help` catalog.
- `serverLifecycle.js` reconciles database server rows with Discord guilds.
- `reactionRoles.js` contains role/emoji helper logic.
- `rulesVerification.js` handles rules reaction verification behavior.
- `raidProtection.js` implements raid detection, quarantine, alerts, and
  incident evidence/report helpers.
- `birthdays.js` handles birthday storage and due-date checks.
- `autocompletes.js`, `timezones.js`, `colors.js`, and `dateToString.js` are
  small formatting/validation helpers shared by commands.

## Deployment Scripts

Deployment scripts are plain Node entry points:

- `deploy-global-commands.js` deploys global slash/context commands.
- `deploy-guild-commands.js` deploys guild-only commands.
- `delete-all-commands.js` clears existing global and guild commands before a
  fresh deployment.

Each script loads `.env`, decrypts protected env values, then uses
`utils/commandLoader.js` and Discord REST APIs.

## Tests And Smoke Checks

`scripts/smokeTest.js` is the main local confidence suite. It checks:

- package metadata and lockfile consistency
- required project files
- blank config cron validity
- dependency loading
- command loading and serialization
- component handler routing conventions
- event module exports
- help catalog building
- model/schema alignment
- encrypted Sequelize runtime behavior
- plaintext-to-encrypted database conversion
- database audit status
- secret encryption helper round-trip
- config validation
- pure utility helpers
- Git hygiene for generated artifacts

Run:

```bash
npm run lint
node scripts/smokeTest.js
```

## Commenting Style

Use inline comments when they explain intent, risk, or non-obvious behavior.
Avoid comments that restate syntax, such as "assigns value to variable." If a
future reader needs broad context, update this guide. If a future reader needs to
avoid breaking a delicate local invariant, add a code-adjacent comment.
