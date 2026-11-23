# Working on Couchwave

Couchwave is a self-hosted "watch YouTube together" server for small groups of friends. It runs on Node.js
with yt-dlp and ffmpeg, and has no npm packages and no database: keep it that way. What's where in the code is
in [docs/FEATURES.md](docs/FEATURES.md#for-developers); how people install and run it is in
[docs/INSTALL.md](docs/INSTALL.md).

## Who reads what

- **The people who run Couchwave are self-hosters, not developers.** Activity lines, log messages, command
  output, docs and the changelog are written for them: plain words, short sentences, what happened and what to
  do next. Say "Nothing was changed." when a command refuses.
- The README and docs stay generic: never put anyone's own server address, hosting setup or names in them.

## Making changes

- Code comments are only short section headers, `// ---------- Name ----------`. How things should behave is
  described in `docs/`, not in comments.
- Files in `lib/` can need each other: each adds what it shares with `Object.assign(exports, …)` at the end and
  reaches into the others when it runs (`room.queue`, `downloads.pump()`), never by copying them at load time.
  The room's shared state lives on `room` in `lib/room.js`.
- The page's security policy blocks inline scripts: give an element `data-click="name"` (or `data-submit`,
  `data-dblclick`, `data-enter`) and add `name` to `ACTIONS` in `public/js/app.js`.
- The page's scripts in `public/js/` are plain scripts sharing one scope, loaded in order by `index.html`
  (`core.js` first, `app.js` last, which starts the page). A new file goes in `index.html` before `app.js`;
  while loading, a script can only use what earlier files made.
- `VERSION` near the top of `server.js` is the one place the version lives. The footer, `--version`, `--status`,
  the new-version check and `--update` all read it.
- Every change people would notice goes in [CHANGELOG.md](CHANGELOG.md) under `## Unreleased`, in `### Added`,
  `### Changed` or `### Fixed`, written for the people who run Couchwave. README-only changes don't need one.
  Update `docs/INSTALL.md` and `docs/FEATURES.md` in the same change when behaviour changes.
- Don't commit or push until asked. Work on `main`. End commit messages with the attribution lines in use.

## Tests

- `node --test` runs everything (about 30 seconds). Each test gets its own throwaway server in a temporary folder
  with stand-ins for yt-dlp, ffmpeg and ffprobe (`tests/fakes/`), so it needs no internet and never touches a
  real install. Add or adjust tests with every change, and run the whole suite before saying it works.
- The page is tested in a real headless Chrome or Edge (`tests/page-browser.test.js`, driven by `tests/browser.js`
  over DevTools, no npm packages). Changes to the page get a test there too. It blocks every site but Couchwave.
- One test per behaviour: extend the test that covers a feature rather than adding a near-copy. Commands for
  whoever runs Couchwave are in `tests/commands.test.js`; tests that start Couchwave themselves use `appCopy` and
  `run` from `tests/helpers.js`.
- The `COUCHWAVE_…` environment variables in `tests/helpers.js` and `lib/` exist only for the tests (fake tools,
  a faster clock, a fake GitHub, a fake disk or systemd).
- Every push runs the tests on Linux and Windows (`.github/workflows/tests.yml`); changes to `install.sh` or
  `install.ps1` also run the installers on fresh machines (`install.yml`), and changes to the server or the Docker
  files build and try the Docker image (`docker.yml`). Check those runs after pushing:
  Linux and Windows differ in file watching, line endings and process handling, and CI machines are slower.
- A test that fails only under load is usually measuring the wrong thing: fix what it measures rather than
  just raising a time limit.
- Avoid real YouTube in tests and checks: YouTube answers bursts of requests with bot checks. When a real run is
  needed, keep it tiny and stop it as soon as the answer is known.

## Changing a Couchwave that's running

- `start.cmd` runs `node --watch server.js`, so saving `server.js` or anything in `lib/` restarts it. Make big
  changes in a copy, run the tests there, then copy them in an order where every moment works: new and support
  files first, `server.js` last, then wait for `Running on` in `data/server.log`. Page changes show on refresh.
- cmd.exe reads a running batch file by position, so `start.cmd` may only be changed while it runs if every
  byte up to and including its `node --watch` line stays the same (`lib/update.js` follows the same rule).
- To try something as a real user, use a throwaway nickname and delete it afterwards with
  `node server.js --delete-account <name>`.

## Windows quirks

- Some shells won't run a batch file from the current folder by name: give its full path.
- Git Bash's `unzip` and `grep -c $'\r'` miscount line endings: count `\r` bytes with Node instead.
- A headless browser used for a check needs `--mute-audio`, and all of its processes must be ended afterwards
  (ending the first one isn't enough).

## Releasing

Use the `/release` command (`.claude/commands/release.md`). It has every step, from `VERSION` and the changelog
to testing the published zip.
