# Hachi

Hachi is a Discord bot for Twitch and Kick live notifications. It can post when streamers go live, update live messages while streams continue, manage birthdays, create reaction-role panels, post rules embeds, monitor public application-command responses, provide raid-protection tools, and provide small utility commands.

Hachi is managed through `HachiGen.exe`, a windowed setup and runtime manager available from GitHub Releases or built from the `manager/` source.

Release history is available in the [Changelog](CHANGELOG.md). User-facing release notes are available in [Patch Notes](docs/patch-notes.md).
Developer architecture notes are available in the [Developer Guide](docs/developer-guide.md).

## What Hachi Does

- Twitch and Kick live notifications with configurable Discord channels and role pings
- Stream message updates while a streamer remains live
- VoD/end-of-stream updates when a previous live message can be matched
- Twitch VIP and Moderator role sync through Twitch device-code authorization
- Per-server notification setup for self streams and affiliate streams
- Birthday storage, birthday month lists, one-week reminders, birthday-day posts, and RecoCards card buttons
- Reaction-role panel creation, editing, message conversion, and cleanup when messages or channels are deleted
- Per-server profile customization with avatar, banner, bio, and nickname fields
- Rules embeds with optional reaction verification
- Optional application command monitoring with app/channel whitelists
- Configurable raid protection with quarantine, join-spike alerts, spam evidence, and incident reports
- Permission-aware `/help` generated from command metadata
- Timestamp and dice rolling utility commands

Hachi uses [The Official Twitch API](https://dev.twitch.tv/docs/api/) and [The Official Kick API](https://docs.kick.com/). Stream checks are batched per server to limit API calls.

## Getting Started

1. Download `HachiGen.exe` from the latest GitHub Release, or clone this repository and build it locally.
2. Open `HachiGen.exe`.
3. Confirm or choose the Hachi install path.
4. Open the Setup page and fill in Configuration.
5. Select Install / Validate.
6. Select Deploy Commands.
7. Select Start.

HachiGen handles setup, install validation, dependency checks, command deployment, updates, PM2 runtime control, and logs from its own window.

## Requirements

- Windows for `HachiGen.exe`
- A Discord application and bot token
- A Discord server for testing guild commands
- Twitch and Kick developer credentials for live-notification checks

## HachiGen

HachiGen is the desktop manager for Hachi. It is intentionally separate from the bot runtime so it can manage the install path, configuration, updates, command deployment, PM2 status, and logs without changing the bot's core process.

HachiGen can:

- Select and save the Hachi install path
- Install or validate the selected Hachi folder
- Install missing package dependencies during validation or bot start
- Save `.env` and `config/config.json` through the Configuration page
- Check for Git updates with one button that changes to Update when an update is available
- Back up `.env`, `config/config.json`, and `database/database.sqlite` before applying updates
- Save local file changes to a recoverable Git stash before updating
- Restore or delete HachiGen-created stashes
- View, sort, back up, restore, sanitize, and migrate the local SQLite database
- Deploy global and guild slash commands with one button; HachiGen deletes old commands first so removed local commands are cleared from Discord
- Start, stop, and restart Hachi through PM2
- Read PM2 status and recent logs

## Configuration

The Setup page in HachiGen writes the files Hachi needs. These values are required:

<table>
	<thead>
		<tr>
			<th>Field</th>
			<th>Purpose</th>
		</tr>
	</thead>
	<tbody>
		<tr>
			<td><code>TOKEN</code></td>
			<td>Discord bot token from the <a href="https://discord.com/developers/applications">Discord Developer Portal</a>.</td>
		</tr>
		<tr>
			<td><code>clientId</code></td>
			<td>Discord application/client ID used when deploying slash commands.</td>
		</tr>
		<tr>
			<td><code>botOwners</code></td>
			<td>Array of Discord user IDs allowed to use owner-only commands. Older <code>botOwner</code> configs are still accepted.</td>
		</tr>
		<tr>
			<td><code>guildIds</code></td>
			<td>Array of Discord server IDs used for private guild commands and faster command testing. Older <code>guildId</code> configs are still accepted.</td>
		</tr>
		<tr>
			<td><code>twitchClientId</code></td>
			<td>Twitch application client ID from the <a href="https://dev.twitch.tv/console/apps">Twitch Developer Console</a>.</td>
		</tr>
		<tr>
			<td><code>twitchSecret</code></td>
			<td>Twitch application secret. Do not share this.</td>
		</tr>
		<tr>
			<td><code>kickClientId</code></td>
			<td>Kick application client ID from the <a href="https://kick.com/settings/developer">Kick Developer settings</a>.</td>
		</tr>
		<tr>
			<td><code>kickSecret</code></td>
			<td>Kick application secret. Do not share this.</td>
		</tr>
		<tr>
			<td><code>twitchCron</code></td>
			<td>How often Twitch live channels are checked. Default: <code>*/1 * * * *</code>.</td>
		</tr>
		<tr>
			<td><code>kickCron</code></td>
			<td>How often Kick live channels are checked. Default: <code>*/1 * * * *</code>.</td>
		</tr>
		<tr>
			<td><code>birthdayCron</code></td>
			<td>How often birthday posting schedules are checked. Default: <code>0 * * * *</code>.</td>
		</tr>
		<tr>
			<td><code>statusCron</code></td>
			<td>How often bot status rotates. Default: <code>*/10 * * * *</code>.</td>
		</tr>
		<tr>
			<td><code>authCron</code></td>
			<td>How often Twitch and Kick auth tokens refresh. Default: <code>0 * * * *</code>.</td>
		</tr>
	</tbody>
</table>

Cron schedules use five fields: minute, hour, day of month, month, and day of week. For more help, visit [Cron Guru](https://crontab.guru/).

Bot tokens, API secrets, local config, logs, and databases are ignored by Git. Do not commit private IDs or secrets.

## Commands

### Global Commands

| Category | Command | Description |
| --- | --- | --- |
| Help | `/help` | Show a permission-aware command list. |
| Help | `/help public:true` | Moderator-only public help flow with a category picker. |
| Setup | `/setup` | Open the setup hub for stream, security, and raid configuration. |
| Streams | `/stream setup` | Configure Twitch/Kick notification channels and roles. |
| Streams | `/stream add` | Add or edit a Twitch/Kick streamer entry. |
| Streams | `/stream list` | List streamers configured for the server. |
| Streams | `/stream remove` | Remove a streamer entry. |
| Streams | `/twitch verify` | Verify your Twitch account for VIP/Moderator role sync. |
| Streams | `/twitch connect` | Connect this Discord server to a Twitch broadcaster. |
| Streams | `/twitch roles` | Map Twitch VIP and Moderator status to Discord roles. |
| Streams | `/twitch panel` | Post a public Twitch verification button. |
| Streams | `/twitch sync` | Reconcile linked users against Twitch VIP/Moderator lists. |
| Streams | `/twitch status` | Show Twitch role-sync setup for the server. |
| Security | `/security setup` | Configure application command reporting. |
| Security | `/security status` | Show command-monitoring settings. |
| Security | `/security audit` | Check whether command-monitoring reports can be posted. |
| Security | `/security whitelist app` | Add or remove a trusted application ID from command-monitoring reports. |
| Security | `/security whitelist channel` | Add or remove a channel from command-monitoring reports. |
| Security | `/security whitelist list` | List command-monitoring whitelist entries. |
| Raid Protection | `/raid setup` | Configure raid protection. |
| Raid Protection | `/raid status` | Show raid protection settings. |
| Raid Protection | `/raid audit` | Check quarantine and alert/report readiness. |
| Raid Protection | `/raid drill` | Send dry-run raid alerts and reports without taking actions or pinging roles. |
| Raid Protection | `/raid incidents` | List recent raid incidents. |
| Raid Protection | `/raid incident` | Show one raid incident. |
| Raid Protection | `/raid report` | Post a raid report to the configured report channel. |
| Raid Protection | `/raid evidence` | Post stored incident evidence to the configured report channel. |
| Raid Protection | `/raid quarantine` | Manually assign the quarantine role. |
| Raid Protection | `/raid release` | Remove quarantine and timeout state. |
| Raid Protection | `/raid sync` | Open a confirmation panel for applying quarantine denies across channels/categories. |
| Birthdays | `/birthday set` | Store your birthday for the current server. Numeric dates use American `MM/DD` format. |
| Birthdays | `/birthday view` | View a member's stored birthday. |
| Birthdays | `/birthday list` | List birthdays for a month, grouped by day. |
| Birthdays | `/birthday remove` | Remove your stored birthday from the current server. |
| Birthdays | `/birthday setup` | Open the birthday setup panel for channels, roles, posting hour, and timezone. |
| Reaction Roles | `/reaction roles add` | Create a reaction-role panel. |
| Reaction Roles | `Edit Reaction Roles` | Message context menu to edit an existing reaction-role panel. |
| Reaction Roles | `Convert to Reaction Roles` | Message context menu to convert an existing message into a reaction-role panel. |
| Profiles | `/profile set` | Set a per-server profile avatar, banner, bio, or nickname. |
| Profiles | `/profile clear` | Clear one or all per-server profile fields. |
| Rules | `/rules` | Post a custom rules embed with optional reaction verification. |
| Utilities | `/roll` | Roll dice using RPG notation. |
| Utilities | `/timestamp` | Convert a date and time into Discord timestamp tags. |

### Guild Commands

| Category | Command | Description |
| --- | --- | --- |
| Utilities | `/ping` | Reply with bot latency. |
| Utilities | `/time` | Reply with the current Discord-formatted time. |
| Utilities | `/uptime` | Reply with the current bot uptime. |
| Admin | `/restart` | Owner-only bot restart command. Hidden from `/help`. |

Global command updates can take time to appear in Discord. Guild commands are deployed to every server listed in `guildIds`, and usually appear much faster for testing.

## Command Details

### Help

Use `/help` to show a permission-aware command list. Hachi builds help from command metadata exported by files in `commands/`; commands with a `help` block get custom category text, while simple commands can fall back to their slash command name and description.

Private help is ephemeral. Categories and entries that the user cannot use are hidden, and the footer notes when commands may be hidden by permissions.

Moderators and administrators can run `/help public:true`. Hachi first opens an ephemeral category picker, then posts only the selected help categories publicly. Public help is allowed for members with at least one of these permissions:

- Administrator
- Manage Server
- Manage Messages
- Timeout Members

### Setup Hub

Use `/setup` to open the setup hub. The hub routes to:

- Stream Notifications
- Security Reporting
- Raid Protection
- Hachi Updates

Buttons do not literally invoke slash commands in Discord, but they route to the same panels used by `/stream setup`, `/security setup`, and `/raid setup`.

### Stream Notifications

Use `/stream setup` to configure Discord channels and roles for stream notifications.

The setup panel includes:

- My Twitch notification role/channel
- My Kick notification role/channel
- Affiliate stream notification role/channel

Changes made in the panel are pending until you press Submit. Selecting channels, selecting roles, or clearing settings updates the panel, but nothing is written to the database until Submit is pressed.

### Streamers

Use `/stream add` to add a streamer to the database:

```console
/stream add name: FearlessKenji discord: https://discord.gg/FearlessKenji
```

- `name` is the streamer login name, such as `fearlesskenji` from `https://www.twitch.tv/fearlesskenji`.
- `discord` is optional. Add it when the streamer has their own Discord server.

After running `/stream add`, Hachi opens an ephemeral panel with the streamer's pending settings:

- Discord: Provided or Not provided
- Twitch Notifications: Yes, No, or Not Set
- Kick Notifications: Yes, No, or Not Set
- Your Stream: Yes, No, or Not Set

Each selection updates the panel, but the streamer is not written to the database until Submit is pressed. If an option is still Not Set when Submit is pressed, the panel asks you to select every option before saving.

Use `/stream list` to check which streamers are configured, whether they are labeled as self or affiliate, and which notification types are enabled.

Use `/stream remove name: streamername` to remove a streamer from the database.

### Twitch VIP and Moderator Role Sync

Use `/twitch connect` to connect the Discord server to the broadcaster's Twitch account. Hachi uses Twitch's device-code flow, so no public callback URL, domain, tunnel, or web server is required. The broadcaster opens Twitch, enters the activation code, and grants `channel:read:vips` and `moderation:read`.

Use `/twitch roles` to choose separate Discord roles for Twitch VIPs and Twitch Moderators. Hachi must have Manage Roles, and Hachi's highest role must be above both mapped roles.

Members can run `/twitch verify`, or an administrator can post `/twitch panel` so members can click a public verification button. Verification links the member's Discord user ID to their Twitch user ID for that server. Hachi does not keep member Twitch access tokens after verification.

Hachi listens for Twitch EventSub WebSocket VIP/Moderator add and remove events for connected broadcasters. It also reconciles linked users during `/twitch sync`, on startup, and during the hourly auth cron to repair missed events or role drift.

### Security Reporting

Use `/security setup` to configure application command monitoring.

When command monitoring is enabled, Hachi watches public application-command response messages that Discord emits into channels it can see. Reports are posted as embeds to the configured reporting channel and include the triggering user, responding application, command name when available, command type, install context, source channel, interaction ID, and a jump link to the response.

Message content is not shown in the monitoring embed. Hachi logs command response metadata internally for investigation.

Use the whitelist for trusted apps or noisy channels:

```console
/security whitelist app action:Add application_id:1211781489931452447 name:Wordle
/security whitelist channel action:Add channel:#bot-games
/security whitelist list
```

Whitelisted apps and channels suppress command-monitoring reports only. Raid spam detection still sees those messages.

Command monitoring only detects public command responses that Discord emits as messages. Ephemeral responses cannot be seen by Hachi, including responses that become ephemeral because a member lacks `Use External Apps`.

### Raid Protection

Use `/raid setup` to configure raid protection.

Configurable options include:

- Enable/disable raid protection
- Quarantine role
- Moderator alert role
- Alert channel
- Report channel
- Message/app spam threshold
- Join spike threshold
- Quarantine action
- Timeout action and duration
- Spam deletion action

Message/app spam detection uses a short rolling buffer. Hachi does not permanently store every message; incident evidence is saved only after a configured threshold is triggered.

Use `/raid drill` to send dry-run alert and report messages to the configured raid channels without assigning roles, timing users out, deleting messages, editing overwrites, pinging roles, or creating database incidents. Drill alerts use the same alert embed as a real raid alert and suppress role pings with `allowedMentions`.

Use `/raid audit` to check whether Hachi can send alerts/reports, assign the quarantine role, time users out, delete spam, and whether quarantine overwrites appear reliable.

Use `/raid sync` to open a confirmation panel for applying quarantine denies across supported channels and categories. The sync only runs after pressing the confirmation button. Review channels that should remain visible, such as rules channels, after syncing.

Raid incidents can be reviewed with `/raid incidents`, `/raid incident id:<id>`, `/raid report id:<id>`, and `/raid evidence id:<id>`. Reports and evidence go to the configured report/mod channel.

Attachments from incident messages are archived locally under `data/evidence/` when available. Duplicate spam is collapsed in reports while preserving stored evidence rows.

### Birthdays

Use `/birthday set` to store your birthday for the current server. Hachi accepts flexible month/day input:

```console
/birthday set date: 12/25
/birthday set date: December 25
```

Numeric birthday dates use American `MM/DD` order.

- `/birthday set` adds or updates your birthday.
- `/birthday view user: @member` shows a member's stored birthday.
- `/birthday list month: January` lists birthdays for a month. Month input accepts names, abbreviations, or numbers, and the command provides month autocomplete.
- `/birthday remove` removes your stored birthday from the current server.

Administrators can configure automatic birthday posts:

```console
/birthday setup
```

The setup panel configures:

- Posting channel for birthday reminders and birthday-day posts.
- Optional role to ping one week before birthdays.
- Optional role to ping on birthday days.
- Whole-hour local posting time.
- IANA timezone used for the server's birthday schedule.

Hachi posts one reminder seven days before a birthday and one birthday message on the day itself. February 29 birthdays are celebrated on February 28 during non-leap years.

### Profiles

Use `/profile set` to manage your per-server profile. You can set an avatar, banner, bio, or nickname for the current server.

Use `/profile clear` to remove one profile field, or clear the full profile. This command requires Manage Server permission.

### Reaction Roles

Use `/reaction roles add` to create a reaction-role panel. The setup flow asks for a target channel and title. You can optionally provide a message for the embed body; otherwise Hachi uses a default message. The command then opens a public editor where you can add assignable roles.

Reaction-role embeds use a fixed yellow color.

Converting existing messages requires the Message Content intent to be enabled for the bot in code and in the Discord Developer Portal.

The editor uses a searchable role selector for adding roles. The setup message is public so the admin who started it can react to the message to assign emojis to roles in order. Removing one of those reactions updates the preview and shifts the remaining emoji order. Custom emoji must belong to the server where the command is used.

When a panel needs multiple messages, continuation messages are created automatically and only show the role list.

Administrators can right-click an existing reaction-role panel and use `Edit Reaction Roles` to open the same setup editor with the current roles and emojis loaded.

Administrators can also use the `Convert to Reaction Roles` message context menu to parse an existing message into a bot-owned reaction-role embed. The converter keeps the leading message text, turns perceived category headings into embed fields, matches emoji lines to assignable server roles, supports common `:emoji_name:` shortcodes, and adds the matched reactions.

### Rules

Use `/rules` to post a custom rules embed. The command asks for a target channel and optional color and verification role, then opens a modal where you can enter the rules title and body.

```console
/rules channel:#rules color:green verification:@Member
```

The color option accepts common color names such as red, orange, yellow, green, blue, purple, cyan, magenta, pink, black, white, and gray. It also accepts hex colors such as `#ff0000`, `ff0000`, `0xff0000`, and short hex values such as `#f00`.

If a verification role is selected, Hachi adds a second embed asking members to react with a check mark. Adding the reaction grants the selected role; removing the reaction removes it. Posting a new rules verification message replaces the previous verification mapping for that server.

## Updates and Local Changes

HachiGen checks for Git updates from the Updates page and also checks on startup.

If updates are available, the Check Updates button changes to Update. If local files have changed, HachiGen saves those changes to a recoverable Git stash before updating. The Updates page shows local changes, incoming commits, and any HachiGen-created stash. Restore Changes applies the saved stash without deleting it. Delete Changes permanently removes the saved stash.

Before applying updates, HachiGen also backs up local runtime files such as `.env`, `config/config.json`, and `database/database.sqlite` into `manager/backups/`.

## Database Maintenance

HachiGen's Database page can show read-only table data, sort columns by clicking table headers, create dated SQLite backups, restore a selected backup with confirmation, and review the current database for schema or data issues.

Database backups are copied from the current database file. When the database is encrypted, normal backups are encrypted too. HachiGen writes a sidecar metadata file beside each backup (`.sqlite.meta.json`) with a non-secret key fingerprint so the Database page can show whether a backup matches the current key, an older key, plaintext, or an unknown key.

Rotating the database key can also rotate existing backups while HachiGen still has both the old and new keys in memory. The separate Rotate Backups action encrypts plaintext backups and verifies or tags backups that already use the current key. Backups that require an older lost key cannot be rekeyed or restored.

Sanitize validates the database schema, checks SQLite integrity, and shows a review popup before making changes. Any selected cleanup creates a safety backup first.

The Dashboard also shows database schema status. If Hachi finds a schema mismatch, the Database page enables Migrate. Safe migration creates a backup first and stops if destructive changes would be required. Force Migrate is intentionally red because it can drop extra columns while reshaping the database to the current Hachi schema.

Console database commands are available for troubleshooting:

```console
npm run db:audit
npm run db:migrate
npm run db:migrate:force
```

Migration backups are stored under `database/backups/migrations/`, and Hachi keeps the five newest automatic migration backups.

## Logs

HachiGen shows PM2 and HachiGen activity on the Logs page. The Clear PM2 and Clear HachiGen buttons only clear the visible log windows; they do not delete real logs.

HachiGen writes its own daily manager logs under the app data folder, such as `%APPDATA%\HachiGen\logs\YYYY-MM-DD\` on Windows. These logs include raw, structured, pretty structured, and crash files. Older daily folders are archived and old archives are removed automatically.

The visible HachiGen activity log hides raw shell commands and Git plumbing. The AppData raw and structured logs keep the sanitized transcript for debugging.

Hachi writes runtime logs in the `logs/` folder. The `logs/` folder is ignored by Git.

## Troubleshooting

- If Discord global commands do not appear immediately, wait a while. Global command updates can take time to propagate.
- If guild commands do not appear, confirm `guildIds` includes the Discord server where you are testing and run Deploy Commands again.
- If HachiGen reports missing Node.js tooling, install Node.js 20.17.0 or newer. npm is included with Node.js and may be needed while HachiGen installs package dependencies.
- If an executable icon looks stale after a rebuild, close File Explorer windows pointed at the folder or restart Windows Explorer. Windows caches icon previews aggressively.
- If PM2 status looks stale, use Refresh in HachiGen and check the Logs page for command output.

## Developer Notes

### HachiGen Packaging

HachiGen is packaged with Electron Builder. The portable executable is created at `manager/dist/HachiGen.exe`, then copied to the repository root as `HachiGen.exe`.

`HachiGen.exe` is generated output and is not committed to the repository. Hachi bot releases use `hachi-vX.X.X` tags from the root `package.json`, while HachiGen releases use `hachigen-vX.X.X` tags from `manager/package.json`. When a `hachigen-v*` tag is pushed, `.github/workflows/release-hachigen.yml` builds HachiGen on a Windows runner and attaches `HachiGen.exe` to the matching GitHub Release. The workflow can also be run manually from the GitHub Actions tab.

To rebuild HachiGen locally, run:

```console
npm run build:hachigen
```

Icon inputs:

- Generated icon consumed by Electron Builder: `manager/icon.ico`
- Build configuration: `manager/package.json`

When changing the icon, generate a fresh `manager/icon.ico` from the desired source image, then package HachiGen again. The source image is not packaged with the repo. `manager/icon.ico` is tracked so future builds use the same icon; `HachiGen.exe` and `manager/dist*/` are generated output and are ignored by Git.

### File Map

<table>
	<thead>
		<tr>
			<th>Area</th>
			<th>File</th>
			<th>Controls</th>
			<th>When to edit it</th>
		</tr>
	</thead>
	<tbody>
		<tr>
			<td rowspan="3">Electron app shell</td>
			<td><code>manager/main.js</code></td>
			<td>Creates the desktop window, registers backend actions, opens folders, and opens external links.</td>
			<td>Edit when adding a new backend button action or changing window behavior.</td>
		</tr>
		<tr>
			<td><code>manager/preload.js</code></td>
			<td>Safely exposes backend actions to the renderer as <code>window.hachiGen</code>.</td>
			<td>Edit when the UI needs to call a new backend function.</td>
		</tr>
		<tr>
			<td><code>manager/package.json</code></td>
			<td>Defines app metadata, script entries, Electron Builder settings, output file name, and icon path.</td>
			<td>Edit when packaging, dependencies, app metadata, or build outputs change.</td>
		</tr>
		<tr>
			<td rowspan="2">Backend logic</td>
			<td><code>manager/src/manager.js</code></td>
			<td>Install validation, configuration saving, Git updates, stashes, PM2 control, command deployment, and logs.</td>
			<td>Edit when changing what HachiGen does after a button is clicked.</td>
		</tr>
		<tr>
			<td><code>manager/src/shell.js</code></td>
			<td>Runs system commands, captures output, handles timeouts, and smooths over Windows command launching behavior.</td>
			<td>Edit when command execution, logging, quoting, timeout, or Windows command handling needs adjustment.</td>
		</tr>
		<tr>
			<td rowspan="4">Renderer UI</td>
			<td><code>manager/renderer/index.html</code></td>
			<td>The visible structure: sidebar, dashboard, setup form, update panels, and log panels.</td>
			<td>Edit when adding, removing, or rearranging visible UI elements.</td>
		</tr>
		<tr>
			<td><code>manager/renderer/app.js</code></td>
			<td>Button click handling, view switching, status rendering, update lists, configuration form loading, and log polling.</td>
			<td>Edit when changing UI behavior or how backend state is displayed.</td>
		</tr>
		<tr>
			<td><code>manager/renderer/styles.css</code></td>
			<td>Theme colors, layout, panels, buttons, status dots, forms, update labels, and responsive behavior.</td>
			<td>Edit when changing appearance or spacing.</td>
		</tr>
		<tr>
			<td><code>manager/renderer/assets/KenjiBotProfile.svg</code></td>
			<td>The profile image shown next to HachiGen in the sidebar.</td>
			<td>Edit or replace when changing the in-app brand image.</td>
		</tr>
		<tr>
			<td>Icon</td>
			<td><code>manager/icon.ico</code></td>
			<td>Generated Windows icon consumed by Electron Builder.</td>
			<td>Regenerate from the desired source image before packaging.</td>
		</tr>
		<tr>
			<td rowspan="7">Bot runtime</td>
			<td><code>index.js</code></td>
			<td>Main Hachi bot entry point.</td>
			<td>Edit when changing bot startup behavior.</td>
		</tr>
		<tr>
			<td><code>commands/</code></td>
			<td>Slash commands and message context menu commands. Optional <code>help</code> metadata is used by <code>/help</code>.</td>
			<td>Edit when adding or changing Discord commands or their help entries.</td>
		</tr>
		<tr>
			<td><code>events/</code></td>
			<td>Discord event handlers.</td>
			<td>Edit when changing how Hachi reacts to Discord events.</td>
		</tr>
		<tr>
			<td><code>database/models/</code></td>
			<td>Sequelize models for server settings, streamers, birthdays, command-monitor whitelists, and raid incidents.</td>
			<td>Edit when persistent bot data needs a new table or column.</td>
		</tr>
		<tr>
			<td><code>utils/helpCatalog.js</code></td>
			<td>Builds permission-aware help categories from loaded command modules.</td>
			<td>Edit when changing how <code>/help</code> groups, filters, or formats command metadata.</td>
		</tr>
		<tr>
			<td><code>utils/raidProtection.js</code></td>
			<td>Tracks short rolling raid buffers, applies quarantine/timeout/delete actions, stores incident evidence, and builds reports.</td>
			<td>Edit when changing raid detection, incident storage, or report behavior.</td>
		</tr>
		<tr>
			<td><code>utils/</code></td>
			<td>Shared helpers for birthdays, reaction roles, colors, crons, command loading, raid protection, help catalog generation, and logging.</td>
			<td>Edit when changing shared behavior used by multiple commands or events.</td>
		</tr>
		<tr>
			<td rowspan="5">Local runtime data</td>
			<td><code>.env</code></td>
			<td>Local secrets and API credentials.</td>
			<td>Created or edited by HachiGen; ignored by Git.</td>
		</tr>
		<tr>
			<td><code>config/config.json</code></td>
			<td>Local bot configuration.</td>
			<td>Created or edited by HachiGen; ignored by Git.</td>
		</tr>
		<tr>
			<td><code>database/*.sqlite</code></td>
			<td>Local SQLite databases, including command-monitor and raid-protection settings/state.</td>
			<td>Generated at runtime; ignored by Git.</td>
		</tr>
		<tr>
			<td><code>data/evidence/</code></td>
			<td>Local copies of available attachment evidence from raid incidents.</td>
			<td>Generated during raid incident handling; ignored by Git.</td>
		</tr>
		<tr>
			<td><code>logs/</code></td>
			<td>Runtime logs.</td>
			<td>Generated at runtime; ignored by Git.</td>
		</tr>
	</tbody>
</table>

## Branding

The Hachi source code is licensed under the MIT License. The Hachi name, logo, icons, official bot identity, and hosted service identity are project branding and are not licensed for use in a way that suggests an unofficial fork or derivative is the official Hachi bot.

## GitHub Pages

The `docs` folder contains the public legal pages for GitHub Pages:

- [Privacy Policy](docs/privacy-policy.md)
- [Terms of Service](docs/terms-of-service.md)
