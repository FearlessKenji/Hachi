Hachi Patch Notes

These notes are written for server owners and moderators. They include changes
that affect setup, security, day-to-day use, or visible bot behavior. For the
full developer history, see [CHANGELOG.md](https://github.com/FearlessKenji/Hachi/blob/main/CHANGELOG.md).

# Unreleased

# v3.4.1 - 2026-07-24

### Smart Links

- Removed the `Shorten Amazon Links` message context menu.
- Social-link replies now use platform-only labels such as `Instagram link`.

### Birthdays

- Birthday Board now only shows the `Set / Update Birthday` and `Sign Upcoming
  Card` buttons.
- Birthday Board entries now show only the date and member, without card-status
  labels.
- `/birthday card list` has been removed. Staff can still manage card links with
  `/birthday card set` and `/birthday card remove`.

### Patch Notes

- `/announce patch-notes` no longer adds `Part X/Y` labels when a release note
  is split across multiple Discord messages.

### Reliability

- Stream-provider outages now produce concise log entries instead of filling
  Hachi's logs with entire proxy error pages.

# v3.4.0 - 2026-07-24

### Smart Links

- A new profile-installable `Shorten Amazon Links` message context menu turns
  recognized product URLs into short, tracking-free regional Amazon links.
- Server administrators can enable automatic social-link fixing from `/setup`.
- Hachi replies without pinging and combines up to five cleaned, embed-friendly
  links from a message into one masked-link reply.
- The profile-installable `Fix Social Links` message context menu provides the
  same cleanup on demand, even when automatic fixing is disabled.

### Birthdays

- Birthday setup now supports separate channels for the birthday board,
  week-before pings, and birthday-day pings.
- Birthday boards can show today's birthdays and upcoming birthdays in the next
  two weeks.
- Members can set, view, or remove their birthday from the birthday board
  buttons.
- Staff can save RecoCards board links with `/birthday card set`, remove them
  with `/birthday card remove`, and review upcoming cards with `/birthday card
  list`.
- Week-before birthday reminders include a `Create a card` button for quickly
  opening RecoCards. Staff still attach the finished card link with `/birthday
  card set`.
- Week-before birthday reminders ping only the configured reminder role, not the
  birthday members being listed.
- Birthday cards only need the RecoCards board link. Hachi automatically derives
  the delivery link for birthday-day announcements.
- When staff add or remove a birthday card, Hachi refreshes the birthday board
  right away when a board channel is configured.
- Upcoming card links are available through an ephemeral selector so a birthday
  person's own card stays hidden until their birthday.

### Reliability

- Dependency security updates cleared the current `npm audit --audit-level=moderate`
  report.
- `/announce patch-notes` now catches up on every unsent release newer than the
  server's last sent patch-note version, sending older missed releases before
  the newest one.
- Twitch EventSub reconnect warnings now include a safe reason when Hachi rejects
  an unexpected reconnect URL.
- `/raid sync` now summarizes long channel error lists instead of failing with a
  generic Discord embed error.

# v3.3.3 - 2026-07-16

### Reliability

- Twitch role EventSub reconnects now validate Twitch WebSocket URLs before
  opening a replacement connection.
- `/raid audit` now avoids noisy explicit-allow warnings for Hachi's own role
  and normal voice Connect access.
- `/raid audit` and `/raid sync` now better explain when full quarantine sync
  needs either Administrator or category/channel Manage Permissions exceptions.
- `/announce patch-notes` stays focused on Hachi's server-facing patch notes,
  without adding HachiGen manager release notes to Discord update posts.
- Patch-note announcement posts now use one `## Hachi v...` heading instead of
  repeating a separate Hachi section heading.

# v3.3.2 - 2026-07-14

### Reliability

- Encrypted database writes now handle bot state updates correctly, including
  Kick live-notification status changes.
- Kick notifications now keep retrying for a replay link after a stream ends
  instead of giving up after one blocked or delayed VoD lookup.

### Security and Privacy

- Twitch verification now includes a privacy note clarifying that Hachi never
  sees Twitch passwords or stores OAuth tokens from member verification.

# v3.3.1 - 2026-07-12

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

# v3.3.0 - 2026-07-12

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
