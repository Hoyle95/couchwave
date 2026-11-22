---
description: Release a new version of Couchwave (beta pre-release), then test the published zip
argument-hint: <version, like 0.4.0>
---

Release Couchwave **v$ARGUMENTS beta**. Go step by step, and stop to ask before anything that changes
GitHub (pushing, publishing). If no version was given, suggest one from the changelog (new features: a minor
version; only fixes: a patch) and ask.

## 1. Ready?

- On `main`, nothing uncommitted, `main` the same as `origin/main` (`git status -sb`).
- The latest **Tests** run on GitHub passed on Linux and Windows (`gh run list --workflow Tests --limit 1`).
- `node --test` passes here.
- `## Unreleased` in CHANGELOG.md has entries. Read them, and anything not yet released in the docs.

## 2. Set the version

- In `server.js`: `const VERSION = '$ARGUMENTS-beta';`. This one line is the version everywhere: the footer
  under the page, `--version`, `--status`, the daily "a newer Couchwave is out" check and `--update` all read it.
- In CHANGELOG.md, rename `## Unreleased` to `## v$ARGUMENTS beta (YYYY-MM-DD)` (today's date) and start it
  with a short paragraph like the earlier releases: what's new in a sentence, then **Download
  `couchwave-v$ARGUMENTS-beta.zip`** from the release (not "Source code"), then **Updating?** and how (see the
  notes in step 4). Above it, add a fresh `## Unreleased` with `Nothing yet.`
- Check README.md and docs/ for anything still described as unreleased or planned.
- Run `node --test` again.

## 3. Commit and push (ask first)

- Commit as `Release v$ARGUMENTS beta`, push, and wait for the **Tests** run on that commit to pass on both
  systems (`gh run watch <id>`). Fix anything it finds before going on.

## 4. Release notes

Write them from the changelog, in the same shape as the last release (`gh release view --json body`), for
people who run Couchwave:

- one line on what this release is,
- **Get it:** download `couchwave-v$ARGUMENTS-beta.zip` below (not "Source code"; it appears a minute or two
  after the release, once the tests pass); the zip has no folder inside; new here, follow the setup guide,
- **Updating?** double-click `update.cmd` (Windows) or run `node server.js --update`, or run the one-line
  install again; settings, data and logins are kept. Installs older than the first release with `--update`
  update by unzipping over the old files or with the one-line install,
- **Highlights**: the main changes as short bullets, important fixes first,
- **Known issues**, if any,
- a link to the changelog at the tag: `https://github.com/Hoyle95/couchwave/blob/v$ARGUMENTS-beta/CHANGELOG.md`.

Show the notes and wait for a yes.

## 5. Publish (ask first)

```sh
gh release create v$ARGUMENTS-beta --target <the FULL 40-character commit hash> --prerelease \
  --title "V$ARGUMENTS BETA" --notes-file <notes file>
```

`--target` needs the full hash (`git rev-parse HEAD`). Publishing starts four workflows by itself:

- **release-zip.yml** runs the tests on Linux, builds `couchwave-v$ARGUMENTS-beta.zip` (with `git archive`,
  leaving out `.github`, every `.cmd` with Windows line endings) and attaches it. Never build or upload a zip by
  hand. If it fails on a flaky test, `gh run rerun <id> --failed` attaches the zip once it passes.
- **install.yml** waits for the zip, then runs both one-line installers on fresh Linux and Windows machines.
- **docker.yml** tries the Docker image, then publishes it for amd64 and arm64 as `ghcr.io/hoyle95/couchwave`
  with the version (`$ARGUMENTS-beta`) and `beta` tags. The package on GitHub must be public (Package settings,
  Change visibility) for people to pull it without logging in.
- **discord-release.yml** posts the announcement.

Watch them with `gh run list --limit 5` and `gh run watch <id>` until all pass.

## 6. Test the published release, as a user would

Work in scratch folders, on spare ports, never on a real install. Use the test stand-ins or keep real tool use
tiny.

- Download it: `gh release download v$ARGUMENTS-beta -p 'couchwave-*.zip'`. Its SHA-256 must match the
  `digest` GitHub lists for the asset (`gh api repos/Hoyle95/couchwave/releases/tags/v$ARGUMENTS-beta`), since
  `--update` refuses a mismatch.
- Every `.cmd` in the zip has Windows line endings (count `\r` bytes with Node).
- **A fresh install:** unzip into an empty folder, write a `config.json` with a spare port, start it
  (`start.cmd` on Windows, `node server.js` elsewhere). Check `node server.js --version` and `--status` say
  v$ARGUMENTS-beta, the page loads, and after joining with a throwaway nickname the footer shows
  `v$ARGUMENTS-beta`. Stop it with `stop.cmd` / `node server.js --stop`.
- **An update:** take a copy of the previous release (or of this one with `VERSION` set lower), start it, run
  `node server.js --update --yes`: it should download, check, try out and install v$ARGUMENTS-beta, restart, and
  keep the copy's data.
- Clean up every scratch folder and process.

## 7. Report

Say what was released, that the zip, installers and announcement went out, and what the release tests showed.
