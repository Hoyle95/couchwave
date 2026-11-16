# Changelog

Changes to Couchwave, newest first. "Unreleased" is what's been added since the last release.

## Unreleased

### Added

- **Accounts**: joining takes the room password plus your nickname's own password, chosen the first time
  you use it, so nobody can join as you. Look-alike nicknames are refused, and "DJ" is reserved.
  Everyone logs in once more after updating; whoever logs in first with an existing nickname claims it.
- **Admin commands**: `--set-password`, `--delete-account` and `--logout-everyone`
  (see [docs/COMMANDS.md](docs/COMMANDS.md)). They work while Couchwave is running.
- **DJ**: `!dj on` in the chat keeps up to 10 songs queued, picked from YouTube's Mix of songs people asked
  for (never its own picks), always after people's songs. It asks in the chat when it has nothing to go on.
  Off by default; `!dj off` stops it.
- **History**: the last 100 songs played, under Activity, with thumbnails, who asked, when, a copy link, and
  a + to put a song back in the queue. Scrolls with the mouse wheel; names get up to 3 lines.
- **Vote to remove**: a bin on every queued song. Your own go straight away; anyone else's, and the DJ's,
  go once enough of the people online vote. The vote count shows on the button. If a song plays before
  enough people vote to remove it, their votes count as votes to skip it.
- **Vote to skip**: Skip is a vote ("1 out of 3 voted to skip"). Whoever added the song can skip it straight
  away. A song skipped by a vote shows in Activity as everyone's doing, not the last voter's.
- **`public` in config.json (not recommended)**: `"public": true` removes the room password, so anyone with
  the address can join (nicknames still have their own passwords). Off by default; see the warning in the
  README.
- **`votePercent` in config.json**: how many of the people online have to vote, to skip or to remove
  someone else's song: 60% by default, rounded up (2 of 3, 3 of 5). The DJ is never counted.
- **`maxVideoHours` in config.json**: how long any one video can be, 3 hours by default (`1.5` is an hour and
  a half, `0.25` a quarter of an hour). Longer links are refused before anything downloads, with the reason
  in the queue; searches pass over results that are too long, and playlists leave them out.
- **`downloadAhead` and `downloadsAtOnce` in config.json**: how many songs at the top of the queue are
  downloaded ahead of time (20 by default), and how many download at the same time (3). Both were fixed
  before.
- **Instant updates**: chat, votes, songs changing and people joining show up for everyone straight away.
- **Joined / left** in the activity log, with a sound (different from the message ding, and set by the same
  volume slider and mute button).
- **Audio only**: turn the video off just for you, to listen and save data.
- **Loading spinner** while the video loads.
- **Join screen**: eye buttons to show what you typed, and password managers can now fill in your login.
  The footer (GitHub link and credits) shows there too.
- **Tests**: `node --test` checks the whole app in under 10 seconds, without internet or your real data.
- **Docs**: installing is in [docs/INSTALL.md](docs/INSTALL.md), commands in
  [docs/COMMANDS.md](docs/COMMANDS.md).

### Changed

- **Moving through a song** (the time bar): only whoever added it can, so nobody can skip a song without a
  vote by jumping to the end. On the DJ's songs, nobody can.
- **Full screen, like Twitch**: video edge to edge with the controls over it (they fade when the mouse is
  still), and the chat down the right, which you can hide.
- **Song names keep their place** in the queue while they're searched for, and the best-matching result is
  picked, not just YouTube's first.
- **No drag-to-reorder**: the queue's order comes from people taking turns.
- **Chat no longer stalls while video plays**: songs are sent at a steady pace, so they don't fill the
  host's upload.
- **Titles with accents, dashes, emoji or other alphabets** display properly on Windows.
- **Safer logins**: browsers keep a signed login, never a password. Over `https://` (Cloudflare Tunnel, Caddy)
  it's marked HTTPS-only, so it's never sent unencrypted; plain `http://` on a home network works as before.
- **Names on the light theme** no longer have a black outline.

### Fixed

- **People flickering offline**: someone with Couchwave in a background tab or on a locked phone kept
  dropping off the online list and coming back (browsers slow such pages down). That also left them out of
  vote counts, so fewer votes than needed could remove or skip a song. An open page now always counts.
