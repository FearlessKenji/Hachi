## Twitch and Kick Discord Bot

This Discord bot will automatically send a message and tag the assigned role whenever a streamer goes live on Twitch or Kick.
The notifications update every minute by default while the streamer is live.

## How does it work?

This Discord bot uses [The Official Twitch API](https://dev.twitch.tv/docs/api/) and [The Official Kick API](https://docs.kick.com/). You are able to assign unlimited streamers to the bot. The bot fetches channel data in batches per server to limit API calls while checking if the streamers specified by that server are live. If the streamer is live, it sends a message in the assigned channel and tags the assigned role. You can choose the update times in the config file using crons. If the streamer is still live, the bot updates the message after the configured amount of time.

## Features

- Twitch and Kick live notifications with configurable Discord channels and role pings
- Stream message updates while a streamer remains live
- VoD/end-of-stream updates when a previous live message can be matched
- Per-server notification setup for self streams and affiliate streams
- Birthday storage, birthday month lists, one-week reminders, birthday-day posts, and RecoCards card buttons
- Reaction-role panel creation, editing, message conversion, and cleanup when messages or channels are deleted
- Timestamp and dice rolling utility commands
- Guided Windows launcher support through `KenjiBot.exe`

## Commands

### Global Commands

| Command | Description |
| --- | --- |
| `/setup` | Configure stream notification channels and roles. |
| `/stream add` | Add or edit a Twitch/Kick streamer entry. |
| `/stream list` | List streamers configured for the server. |
| `/stream remove` | Remove a streamer entry. |
| | |
| `/birthday set` | Store your birthday for the current server. Numeric dates use American `MM/DD` format, such as `12/25`. |
| `/birthday view` | View a member's stored birthday. |
| `/birthday list` | List birthdays for a month, grouped by day. |
| `/birthday remove` | Remove your stored birthday from the current server. |
| `/birthday setup` | Configure birthday channels, roles, posting hour, and timezone. |
| | |
| `/reaction roles add` | Create a reaction-role panel. |
| `Edit Reaction Roles` | Message context menu to edit an existing reaction-role panel. |
| `Convert to Reaction Roles` | Message context menu to convert an existing message into a reaction-role panel. |
| | |
| `/roll` | Roll dice using RPG notation. |
| `/timestamp` | Convert a date and time into Discord timestamp tags. |

### Guild Commands

| Command | Description |
| --- | --- |
| `/ping` | Reply with bot latency. |
| `/time` | Reply with the current Discord-formatted time. |
| `/uptime` | Reply with the current bot uptime. |
| `/restart` | Restart the bot. |
| `/rules` | Post the configured rules embed. |

Global command updates can take time to appear in Discord. Guild commands are deployed only to the server matched by `guildId` in `config/config.json`, and usually appear much faster for testing.

## Requirements
- Node.js compatible with `discord.js` v14
- A Discord application and bot token
- A Discord server for testing guild commands

## Installation
First you will have to download or clone the project.
```console
$ git clone https://github.com/FearlessKenji/KenjiBot
```
## Executable
If you use `KenjiBot.exe`, dependencies are installed automatically and config files are set up during guided installation. Slash commands are also registered.

## Dependencies
Install the required node packages outlined in package.json with:
```powershell
$ npm install
```

## Edit .env
Rename `blank.env` to `.env` and fill in the required fields.

- TOKEN - Enter your [Discord bot token](https://discord.com/developers/applications) here.
- clientId - Copy and paste your application ID. You need this to register commands.
- twitchClientId - Enter the Twitch application client ID generated here: ([Twitch Developer Console](https://dev.twitch.tv/console/apps)).
- twitchSecret - Enter the secret token generated on the Twitch application page. Do not share this.
- kickClientId - Enter the Kick application client ID here: ([Kick Developer Console](https://kick.com/settings/developer)).
- kickSecret - Enter the secret token generated on the Kick application page. Do not share this.

## Edit config/config.json
If you run the bot manually, copy `config/blank.json` to `config/config.json` and fill in the required fields.

- botOwner - Copy and paste your discord ID for top access commands.
- guildId - Copy and paste your Discord server ID here. This is for private guild-access commands.
- twitchCron - Checks Twitch for specified live channels every minute by default.
- kickCron - Checks Kick for specified live channels every minute by default.
- birthdayCron - Checks whether any configured server has reached its local birthday posting hour. Runs hourly by default.
- statusCron - Changes bot status every 10 minutes by default. Can be modified in ready.js in the events folder.
- authCron - Updates Twitch and Kick auth tokens every hour by default. Generated tokens are cached in memory while the bot is running.

All of these fields are required.

Check [Cron Guru](https://crontab.guru/) for help setting up crons. Crons will always fire at a specific clock time regardless of startup time.

`.env` and `config.json` are ignored by Git. Do not commit bot tokens or private IDs you do not want public.

## Register Slash Commands
If you use `KenjiBot.exe`, slash commands are registered automatically during startup.

If you run the bot manually, register commands with:
```console
$ node deploy-global-commands.js
```
and/or
```console
$ node deploy-guild-commands.js
```

The global commands will be available in all servers. The guild commands will only be available in the server whose ID is matched with `guildId` in the config.


## Run the bot
After you update `.env` and `config/config.json`, Windows users can run the executable `KenjiBot.exe`

Keep `KenjiBot.exe` in the project folder so it uses the config files you edited. You can right click and make a shortcut to copy to the desktop.
The launcher checks for Node.js, Git, and PM2, walks you through missing setup values, installs dependencies, registers slash commands, and starts KenjiBot through PM2.
If the launcher detects local Git changes, it skips automatic updates so your work is not overwritten.

To run the bot manually, use the command in the same directory as the index.js file:
```powershell
$ node index.js
```
or
```powershell
$ npm run start
```

## Logs
This project creates logs in the logs folder and dates them. Logs of previous days are compressed. The `logs` folder and subsequent files are ignored by Git.
Logs may include startup events, server join or leave events, owner-control actions, and error details used for debugging.

## Command detail

### Setup notifications
Use `/setup` to configure the Discord channels and roles used for stream notifications.

The setup command opens an ephemeral panel with buttons for:
- My Stream
- Affiliate Streams
- Submit

Changes made in the panel are pending until you press Submit. Selecting channels, selecting roles, or clearing settings will update the panel, but nothing is written to the database until Submit is pressed.

### Add streamers
Use the `/stream` slash command to add users to the database. Usage:
```console
/stream add name: FearlessKenji discord: https://discord.gg/FearlessKenji
```
- name - Enter the streamer login name here. This name is the same as the name in the channel URL.  
Example:
  - URL = https://www.twitch.tv/fearlesskenji
  - name = fearlesskenji
- discord - This field is not required, but if the streamer has their own Discord server you can add the invite URL here.

After running `/stream add`, the bot opens an ephemeral panel with the streamer's current pending settings:
- Discord: Provided or Not provided
- Twitch Notifications: Yes, No, or Not Set
- Kick Notifications: Yes, No, or Not Set
- Your Stream: Yes, No, or Not Set

All of these options are available at once. Each selection updates the panel, but the streamer is not written to the database until Submit is pressed. If an option is still Not Set when Submit is pressed, the panel will ask you to select every option before saving.

Use `/stream list` to check which streamers are configured, whether they are labeled as self or affiliate, and which notification types are enabled.
Use `/stream remove name: streamername` to remove a streamer from the database.

### Birthdays
Use `/birthday set` to store your birthday for the current server. The bot accepts flexible month/day input such as:
```console
/birthday set date: 12/25
/birthday set date: December 25
```

Numeric birthday dates use American `MM/DD` order.

`/birthday add` to add your own birthday.
`/birthday view user: @member` to view a member's stored birthday.
`/birthday list month: January` to list birthdays for a month. Month input accepts names, abbreviations, or numbers, and the command provides month autocomplete.
`/birthday remove` to remove your stored birthday from the current server.

Administrators can configure automatic birthday posts with:
```console
/birthday setup channel: #birthdays week_role: @Staff day_role: @Birthday hour: 12pm timezone: America/New_York
```

- channel - Where birthday reminders and birthday-day posts are sent.
- week_role - Optional role to ping one week before a birthday.
- day_role - Optional role to ping on the birthday.
- hour - Whole-hour local posting time such as `12pm`, `noon`, or `13`.
- timezone - IANA timezone used for the server's birthday schedule. Has autocompletes.

The bot posts one reminder seven days before a birthday and one birthday message on the day itself. February 29 birthdays are celebrated on February 28 during non-leap years.

### Reaction roles
Use `/reaction roles add` to create a reaction-role panel. The setup flow asks for a target channel and title. You can optionally provide a message for the embed body; otherwise the bot uses a default message. The command then opens a public editor where you can add assignable roles.

Reaction-role embeds use a fixed yellow color.

Converting existing messages requires the Message Content intent to be enabled for the bot in code and in the Discord Developer Portal.

The editor uses a searchable role selector for adding roles. The setup message is public so the admin who started it can react to the message to assign emojis to roles in order. Removing one of those reactions updates the preview and shifts the remaining emoji order. Custom emoji must belong to the server where the command is being used.

When a panel needs multiple messages, continuation messages are created automatically and only show the role list.

Administrators can right-click an existing reaction-role panel and use `Edit Reaction Roles` to open the same setup editor with the current roles and emojis loaded.

Administrators can also use the `Convert to Reaction Roles` message context menu to parse an existing message into a bot-owned reaction-role embed. The converter keeps the leading message text, turns perceived category headings into embed fields, matches emoji lines to assignable server roles, supports common `:emoji_name:` shortcodes, and adds the matched reactions.

## GitHub Pages
The `docs` folder contains the public legal pages for GitHub Pages:

- [Privacy Policy](docs/privacy-policy.md)
- [Terms of Service](docs/terms-of-service.md)

Congratulations! You have successfully setup the bot.
