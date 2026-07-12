# Hachi Patch Notes

These notes are written for server owners and moderators. They include changes
that affect setup, security, day-to-day use, or visible bot behavior. For the
full developer history, see `CHANGELOG.md`.

## v3.3.0 - 2026-07-12

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

- `config/config.json` now supports multiple bot owner IDs and multiple guild IDs
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
