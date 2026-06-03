# Twitch and Kick Discord Bot
This Discord bot will automatically send a message and tag the assigned role whenever a streamer goes live on Twitch or Kick.
The notifications update every minute by default while the streamer is live.

## How does it work?
This Discord bot uses [The Official Twitch API](https://dev.twitch.tv/docs/api/) and [The Official Kick API](https://docs.kick.com/). You are able to assign unlimited streamers to the bot. The bot fetches channel data in batches per server to limit API calls while checking if the streamers specified by that server are live. If the streamer is live, it sends a message in the assigned channel and tags the assigned role. You can choose the update times in the config file using crons. If the streamer is still live, the bot updates the message after the configured amount of time.


## Installation
First you will have to clone the project.
```console
$ git clone https://github.com/FearlessKenji/KenjiB0t
```

## Dependencies
After installing, in order for the bot to work properly you will have to install the required node packages outlined in package.json. Use the following command to install the dependencies.
```console
$ npm install
```

## Edit .env
Create a `.env` file in the main project folder.

- TOKEN - Enter your [Discord bot token](https://discord.com/developers/applications) here.
- twitchClientId - Enter the Twitch application client ID generated here: ([Twitch Developer Console](https://dev.twitch.tv/console/apps)).
- twitchSecret - Enter the secret token generated on the Twitch application page. Do not share this.
- kickClientId - Enter the Kick application client ID here: ([Kick Developer Console](https://kick.com/settings/developer)).
- kickSecret - Enter the secret token generated on the Kick application page. Do not share this.

## Edit config/config.json
Copy `blank_config.json` into the `config` folder and rename it to `config.json`.

- botOwner - Copy and paste your discord ID for top access commands.
- clientId - Copy and paste your application ID. You need this to register commands.
- guildId - Copy and paste your Discord server ID here. This is for private guild-access commands.
- twitchCron - Checks Twitch for specified live channels every minute by default.
- kickCron - Checks Kick for specified live channels every minute by default.
- statusCron - Changes bot status every 10 minutes by default. Can be modified in ready.js in the events folder.
- authCron - Updates Twitch and Kick auth tokens every hour by default. Generated tokens are stored in auth/tokens.json.

All of these fields are required.

Check [Cron Guru](https://crontab.guru/) for help setting up crons. Crons will always fire at a specific clock time regardless of startup time.

## Register Slash Commands
Before you can use the commands, you need to run 
```console
$ node deploy-global-commands.js
```
and/or
```console
$ node deploy-guild-commands.js
```

The global commands will be available in all servers. The guild commands will only be available in the server whose ID is matched with `guildId` in the config.


## Run the bot
After you updated `.env` and `config/config.json`, installed the dependencies, and registered the commands, you can run the final command.
Use the command in the same directory as the index.js file.
```console
$ node index.js
```
or
```console
$ npm run start
```

Alternatively, there is an executable provided that will run the second command with additional parameters to make running it easier.

## Setup notifications
Use `/setup` to configure the Discord channels and roles used for stream notifications.

The setup command opens an ephemeral panel with buttons for:
- My Stream
- Affiliate Streams
- Submit

Changes made in the panel are pending until you press Submit. Selecting channels, selecting roles, or clearing settings will update the panel, but nothing is written to the database until Submit is pressed.

## Add streamers
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

Congratulations! You have successfully setup the bot.
