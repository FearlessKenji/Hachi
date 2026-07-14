Hachi Patch Notes

These notes are written for server owners and moderators. They include changes
that affect setup, security, day-to-day use, or visible bot behavior. For the
full developer history, see [CHANGELOG.md](https://github.com/FearlessKenji/Hachi/blob/main/CHANGELOG.md).

# Unreleased

## Hachi

### Reliability

- Twitch role EventSub reconnects now validate Twitch WebSocket URLs before
  opening a replacement connection.

# v3.3.2 - 2026-07-14

## Hachi

### Reliability

- Encrypted database writes now handle bot state updates correctly, including
  Kick live-notification status changes.
- Kick notifications now keep retrying for a replay link after a stream ends
  instead of giving up after one blocked or delayed VoD lookup.

### Security and Privacy

- Twitch verification now includes a privacy note clarifying that Hachi never
  sees Twitch passwords or stores OAuth tokens from member verification.

## HachiGen

### Database

- Encrypted database sanitation can now clean selected findings without failing
  after creating the safety backup.

### Updates

- HachiGen now uses `1.0.1` for its packaged app metadata.
- Hachi and HachiGen now use separate release tracks, so small HachiGen updates
  can ship without changing the Hachi bot version.

### Navigation

- Sidebar navigation stays available while HachiGen is running manager actions.

### Logging

- Routine state refreshes no longer crowd the HachiGen log with repeated Git
  branch, remote, and stash checks.
- HachiGen keeps daily manager logs in the app data folder, including crash logs
  and automatic cleanup of older log archives.
- The visible Logs panel now focuses on readable manager activity instead of
  raw shell commands, while the app data logs retain the full sanitized details.
- Command output that tools send through stderr is now shown as a notice instead
  of looking like a manager error when the action succeeded.

# v3.3.1 - 2026-07-12

## Hachi

### Setup

- Hachi Updates is now the first button in `/setup`, making patch-note channel
  setup easier to find.
- Fixed Hachi Updates channel selection so saving an announcement channel no
  longer fails with a database binding error.

### Reliability

- Kick stream notifications now stop retrying the VoD lookup when Kick blocks
  the replay endpoint after a stream ends.
- If a Kick notification already has a valid VoD link, Hachi now clears the
  stale live state without making another blocked lookup.

## HachiGen

### Updates

- HachiGen now uses `1.0.0` for its packaged app metadata.

### Logging

- HachiGen errors now appear in its log as well as popup notifications.

# v3.3.0 - 2026-07-12

## Hachi

### Security and Setup

- Hachi now expects its database to be encrypted at rest. HachiGen can generate
  the database key, verify encrypted database access, convert an existing plain
  database, rotate the key, and export a key backup.
- Hachi now expects `.env` values to be stored encrypted. HachiGen saves Discord,
  Twitch, and Kick configuration values as encrypted entries and only decrypts
  them at runtime.
- Secret copy buttons are available in HachiGen for cases where a value needs to
  be reused outside the bot. Copied secrets are temporary and are never printed
  in logs.

### Configuration

- Config files now support multiple bot owner IDs and multiple guild IDs
  through `botOwners` and `guildIds` arrays.
- Older `botOwner` and `guildId` config files still work, but new saves from
  HachiGen write the plural array format.
- Guild command deployment now deploys to every configured guild ID.

### Hachi Updates

- Servers can now choose a Hachi Updates channel from `/setup`.
- Hachi patch notes are manual and user-facing. They come from this file instead
  of the full developer changelog.
- Bot owners can manually send the latest patch notes to opted-in servers with
  `/announce patch-notes`.

### Reliability

- Hachi now remembers when it leaves a server and keeps that server's data for a
  short cleanup window instead of deleting it immediately.
- Startup reconciliation repairs missing server rows and clears the left-server
  marker when Hachi rejoins before cleanup.
