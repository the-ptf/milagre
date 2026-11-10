# Development and releases

[Back to the README](../README.md)

## Development

```bash
npm ci
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run build
npm test -- --unit
npm run release:preview
```

Repository testing skills live in `.agents/skills`: `test-milagre-app` covers isolated Electron checks and screenshots; `test-milagre-mobile` covers device attachment, disposable hosts and native UI verification. These guide development of Milagre and are discovered as workspace skills. They are not bundled into the installed app.

The repo uses npm workspaces with one root lockfile. Run the existing commands from the repository root; `npm ci` installs every workspace. Set `DO_NOT_TRACK=1` in your shell: `@openuidev/lang-core` pings an analytics endpoint at install time otherwise. `npm test -- --only monorepo` checks package resolution and desktop packaging metadata. After building, `npm test -- --only test-desktop` opens the real app against temporary saved Chats and settings. On macOS, run `node scripts/test-desktop.cjs --packaged release/mac-arm64/Milagre.app` to check a local installer build too (use `release/mac/Milagre.app` for Intel).

`npm run dev` starts Vite and opens the Electron shell. The renderer is served locally at port 5180 during development. Its production build is in `apps/desktop/dist/`; installers remain in the root `release/` directory. The desktop package keeps its existing app identity and data paths, so saved Chats and settings need no migration.

An unpackaged app (`npm run dev`, the test scripts) reads two folder overrides and passes them to the background host it starts: `MILAGRE_WORKTREE_ROOT` for Milagre Worktrees (`~/.milagre/worktrees` otherwise) and `MILAGRE_CHATS_HOME` for the Chats home that holds Chats without a Project (`~/.milagre/chats` otherwise). Use absolute paths. A host that is already running keeps its folders, so stop it first. Packaged builds ignore both.

## Developing on Windows

`npm ci`, `npm run dev`, `npm run typecheck`, `npm run lint` and `npm test` run from PowerShell or Git Bash. No C++ toolchain is needed: `node-pty` and the other native modules ship prebuilt.

- Every checkout is LF, set by `.gitattributes`, because `oxfmt` and the pre-commit hook fail on CRLF. A clone made before that file existed needs one fresh checkout: with no uncommitted work, run `git rm --cached -r -q .` and then `git reset --hard`.
- `npm ci` does not download Electron's binary. The first `npm run dev` does, or run `node node_modules/electron/install.js`.
- Keep a dev copy off an installed Milagre's profile. Both use `%APPDATA%\Milagre`, so a dev copy attaches to the installed app's host and can replace it, stopping its agents. In PowerShell, `$env:MILAGRE_USER_DATA_DIR = "$env:TEMP\milagre-dev"; npm run dev`. This works on every platform. Set `MILAGRE_WORKTREE_ROOT` and `MILAGRE_CHATS_HOME` too to keep its folders apart.
- Many unit tests still assume POSIX paths and processes, so `npm test -- --unit` fails on Windows. CI runs the Windows-specific suites in `native-tests`; use `--only <name>` for the area you touched and compare with `main`. A daemon test that fails can leave a `cli.cjs serve` process with a temporary `--data-dir` running.

## Releases

Merges into `main` cut no release. Releases ride a train with two stops, both run by the **Publish** workflow (`scripts/plan-release.cjs` plans each one):

- **Beta** (`channel=beta`): ships the newest `main` commit whose CI passed (or the commit in `ref`) as a `vX.Y.Z-beta.N` prerelease. Its notes list the changes since the previous beta. It runs weekdays at 09:00 UTC, skipping when nothing user-facing landed, and on dispatch.
- **Stable** (`channel=stable`): rebuilds the newest beta's commit as `vX.Y.Z`, marks it latest and redeploys the Linux package repository. Its notes list every change since the previous stable. Only the newest beta can be promoted: an older one would move beta installs back.

Both build the macOS DMG and ZIP installers for Intel and Apple Silicon and the Linux AppImage, DEB and RPM, and create the release and its tag only after the builds pass. Installed builds check published GitHub Releases at startup, download updates in the background, and ask to restart when ready; the update card shows the release's notes.

Versions come from Pull Request titles, which use Conventional Commits. The line is the last stable plus the biggest change since it; betas count up within a line:

```text
fix: correct agent cancellation       # patch
feat: add worktree canvas             # minor
feat!: change the coordination API    # minor while on 0.x, then major
docs: clarify setup                   # no version of its own
```

After every green merge, CI rewrites one untagged **Next beta** draft release with what the next beta would ship. `npm run release:preview` prints the same from your `origin/main`.

Release installers require a Developer ID Application certificate and Apple notarization. The workflow checks Apple credentials before creating a release, signs and notarizes the app, and signs, notarizes and staples the DMG. It verifies signatures, notarization tickets, Gatekeeper acceptance and DMG integrity before uploading installers. See [macOS signing setup](agents/macos-signing.md) for the required GitHub Actions secrets.

For a local build without an Apple certificate, use `npm run package:mac:local`. This explicitly uses an ad-hoc signature and skips notarization; downloaded copies still require a manual security exception.

## README images

The README hero is a frame from the landing recordings in `apps/site/public/demo/` (`scripts/site-demo/record.cjs`): the desktop and iPhone takes at the same moment, framed like the site's hero, with the Browser and Computers stills below. After re-recording the site, take matching frames with `ffmpeg -ss <seconds> -i desktop.mp4 -frames:v 1`, compose them, put them on the orphan `screenshots` branch under `readme/` and link the README to that commit's SHA, as described in [AGENTS.md](../AGENTS.md).

`node scripts/capture-readme.cjs /tmp/milagre-readme` still captures the desktop renderer with mock Chats and a read-only mobile fixture, for a light-theme or New chat shot.
