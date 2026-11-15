# Changelog

Changes to Couchwave. The newest are at the top; "Unreleased" is what's been added since the last release.

## Unreleased

### Added

- **Audio only**: a video button (camera icon) next to full screen turns the video off just for you, so
  only the sound plays and the video isn't downloaded (saves data). While it's on, the camera shows
  crossed out. Click it again to bring the picture back, in sync with the sound. It's remembered in your
  browser.
- **Loading spinner** on the video while the picture loads (after turning audio only off, when a song
  starts, or while it buffers), instead of a plain black screen.
- **Joined / left in the activity log**: shows when someone opens the site and when they leave (after a
  minute without their page checking in, or straight away when they log out). Reloading the page or a
  short drop-out isn't logged, and people already there aren't re-announced when the server restarts.
- **Log everyone out**: `node server.js --logout-everyone` makes everyone enter the password again,
  without changing it. Works while Couchwave is running.

### Changed

- **Safer logins**: the join screen now sends the password once, and the server answers with a login
  cookie, so browsers no longer keep the password itself. Everyone has to log in once more after updating.
