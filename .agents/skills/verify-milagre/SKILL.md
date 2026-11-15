---
name: verify-milagre
description: Drive the real Milagre desktop app (Electron dev copy over CDP) and the phone app (iOS simulator on a host this run starts) the way a user does, and capture proof. Use to confirm a change works in the running app, to reproduce a bug end to end, before taking PR screenshots, or when asked to "verify", "QA" or "drive" Milagre. Starts and stops its own isolated copy; never touches the user's open Milagre.
---

# Verify Milagre

One helper, `scripts/verify-milagre.cjs`, starts a disposable copy of Milagre, drives it, records evidence and stops exactly what it started. The recipes per feature live in [features/](features/README.md). Read the feature file before driving that feature.

Run everything from the repository root. Shorthand used below:

```sh
V=.agents/skills/verify-milagre/scripts/verify-milagre.cjs
node $V help
```

For scripted regression checks (`npm test -- --only <name>`), use [test-milagre-app](../test-milagre-app/SKILL.md) and [test-milagre-mobile](../test-milagre-mobile/SKILL.md). This skill is the live, real-provider path.

## Hard rules

- Never stop, reload, connect to or drive a Milagre, Electron, Vite, Metro or daemon process this run did not start. The user keeps Milagre open, and a dev session lives on Vite 5180. No `pkill`/`killall` by name. `stop` only kills PIDs in the run's own state file and their children.
- Never use the development checkout (or any real Project) as the Project. `launch` makes a throwaway Git repository.
- iOS simulators boot only through `simslim` and must pass `simslim verify` (`~/.claude/rules/simulators.md`). `phone-sim` does both. Never `xcrun simctl boot`, Simulator.app or argent `boot-device` for an iOS simulator that is not booted yet.
- Pairing tokens never enter the transcript: `phone-pair` builds the link from the private connection file, and `stop` redacts tokens from copied logs.
- Evidence from this skill is test evidence. PR images still follow AGENTS.md (real providers, orphan `screenshots` branch, never in the PR's commits).

## Launch

```sh
node $V launch                                         # Project opened, ready at the composer
node $V launch --claude-config-dir "$CLAUDE_CONFIG_DIR"  # same, agents use that Claude account
node $V launch --onboarding                            # first launch: Dawn intro and onboarding
```

`launch` does all of this and prints the run id, ports, paths and PIDs as JSON:

- Scratch dir `$TMPDIR/milagre-verify/runs/<id>/` with a Git repo `verify-project` (README.md, notes.txt, one commit on `main`), an Electron profile, a Chats home and a Worktree root.
- Vite on the first free port from 5290 with `--strictPort` (refuses 5180), Electron on the first free CDP port from 9390, both detached with logs in the scratch dir.
- Electron runs with a clean environment (no `ELECTRON_RUN_AS_NODE`, no `CLAUDE_CODE_*` of the calling agent), `MILAGRE_BACKGROUND=1` (no window, Dock icon or focus change; `--show` puts it on screen), `--use-mock-keychain` and the three anti-throttling flags, so rAF and timers run in the hidden window.
- The profile gets `project-registry.json` marked scanned (no scan of the user's real folders) and, unless `--onboarding`, `recent-projects.json` naming the scratch repo. With `--onboarding` the app starts in an empty folder with empty Claude and Codex homes.
- Ready means usable: the splash is gone and `[data-prompt-editor]` exists (or `[data-onboarding]`). Then it records the daemon PID the app started on its profile.

Provider accounts: without a flag, the copy's agents use `~/.claude` and `~/.codex`. On this Mac those defaults can be at their weekly limit (the Chat shows a "hit its usage limit" card). `--claude-config-dir` / `--codex-home` point the copy at another account folder; only the path is passed. Pick the cheapest model in the picker (Claude Haiku) and prompts that need one short reply.

Startup takes about 8 s. A launch that fails part way leaves a run behind: run `node $V stop` before the next attempt.

## Doctor

```sh
node $V doctor
```

Read-only. Checks every recorded PID is alive, the Vite port is owned by our Vite, CDP shows the main window on our URL, the preload bridge is present, no startup error or splash, the current Project is the scratch repo, `document.visibilityState` is `visible`, the daemon answering on our profile is the one we recorded, and the checkout's HEAD has not moved since launch. Exit 1 on any `FAIL`. Run it before the first drive, after any failed step, and whenever the UI does something surprising. A run that fails doctor gets `stop` and a fresh `launch`, not more driving.

## Drive

Desktop commands act on the main window over CDP. Each prints what it did as JSON and appends to the evidence log.

| Command                                                                            | Use                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `click <css>` / `click --name "<label>" [--role button]` / `click --text "<part>"` | Real mouse press and release at the element's centre. Fails when nothing visible matches or another element covers the centre (a closed sheet, an overlay), the way a user's click would miss. `--nth n` picks among matches. |
| `rightclick ...`, `hover ...`                                                      | Context menus (sidebar rows) and hover-only buttons (Done, Snooze).                                                                                                                                                           |
| `type "<text>"`                                                                    | Inserts text into the focused field (composer, rename input, Terminal). Click the field first.                                                                                                                                |
| `press Enter\|Escape\|Tab\|ArrowDown\|...` (`--meta`, `--shift`)                   | Key presses. Escape closes pickers, menus and Settings.                                                                                                                                                                       |
| `wait '<js>' [--timeout ms]`                                                       | Polls a page expression until truthy. Use it instead of sleeps.                                                                                                                                                               |
| `eval '<js>'`                                                                      | Reads page state. Use it to read, not to act: actions go through click/type/press.                                                                                                                                            |
| `host <method> '<json args>' [--map 'v => ...']`                                   | Calls this run's daemon: the second, independent view of state (Chat messages, titles, Done). `$PROJECT` in args is the scratch repo path.                                                                                    |

Stable handles in this app: `aria-label` names (`New chat`, `Command palette`, `Stop agent`, `Allow once`), and data attributes (`[data-prompt-editor]`, `[data-composer-submit]`, `[data-permission-mode]` for the model picker, `[data-picker-row]`, `[data-chat-id="<id>"] [data-row]`, `[data-chat-menu] [role=menuitem]`, `[data-panel-toggle=terminal|changes|browser|details]`, `[data-update-settings]`, `article[data-from=user|assistant]`). Chat ids are not sequential; read them from `[data-chat-id]` or `host project:read`.

A complete desktop drive, from launch to proof:

```sh
node $V launch --claude-config-dir "$CLAUDE_CONFIG_DIR"
node $V doctor
node $V click '[data-permission-mode]'
node $V click --name Claude --role button
node $V click --text Haiku --role button
node $V press Escape
node $V click '[data-prompt-editor]'
node $V type 'Reply with exactly the word pong and nothing else. Do not use any tools.'
node $V click '[data-composer-submit]'
node $V wait '(() => { const a = [...document.querySelectorAll("article[data-from=assistant]")].at(-1); return a && !document.querySelector("[aria-label=\"Stop agent\"]") ? a.textContent : false })()' --timeout 120000
node $V shot chat-reply
node $V host project:read '["$PROJECT"]' --map 'v => Object.keys(v.state.sessions)'
node $V host chat:messages '["$PROJECT", 2]' --map 'v => v.messages.map(m => m.role + ": " + m.body)'
node $V stop
```

### Phone

The phone app runs on an iOS simulator against a phone host on this run's own daemon, so the phone and the desktop copy show the same Chats (the `mobile-host --desktop-data-dir` recipe).

```sh
node $V phone-host                       # bridge on the first free port from 8940
node $V metro                            # this checkout's Metro, first free port from 8960
simslim list                             # pick a shut-down iPhone; phone-sim boots it
node $V phone-sim --udid <udid>          # simslim boot + verify --except widgets,icloud,web
node $V phone-install --from <udid>      # copy a Milagre dev build from another simulator, pin it to our Metro
```

Then drive with argent (read the `argent-device-interact` skill first): `launch-app` with bundle id `com.victorlucas.milagre`, `await-ui-element` until `Bundling` is hidden, then `node $V phone-pair` and tap `Open` on iOS's "Open in Milagre?" alert. The phone lands on All Chats with the scratch Project. Take tap points from the element tree argent returns, never from pixels. `node $V phone-shot <name>` saves a simulator screenshot to the evidence dir.

`phone-install --from` needs a simulator that already has a Milagre development build (no `main.jsbundle`). Find one read-only: `xcrun simctl get_app_container <udid> com.victorlucas.milagre` on each booted simulator. The source is only copied; its app and pinned Metro port stay as they are. `phone-install` refuses to overwrite Milagre on a simulator this run did not boot. Building a new dev client is out of scope: it needs the user's approval (`apps/mobile/AGENTS.md`).

## Evidence

Everything lands in `$TMPDIR/milagre-verify/evidence/<run id>/`, outside the scratch dir, and survives `stop`:

- `actions.jsonl`: every command with its target, where the click landed, waited-for values and host answers. This is the action log that pairs each step with its result.
- `<name>.png` from `shot` and `phone-shot`; `<name>.txt` from `snapshot` (visible controls with role, name, state and data attributes).
- `electron.log`, `vite.log`, `metro.log`, `phone-host.log` (tokens redacted), copied at `stop`.
- `node $V note "<text>"` adds a line, for what the proof showed.

Proof standards:

- Drive the user's path: click the control, type into the field. `eval` only reads.
- Capture the action and the resulting state (a shot before and after, or the log line plus the shot).
- Check side effects from a second view: `host chat:messages` for a sent turn, the file on disk for a Terminal command or an approved tool call, `profile/preferences.json` for settings and pins, the phone for anything shared.
- A model reply is real provider output. Assert on what you asked for (`pong`), not on wording.
- Snapshots and screenshots can include account names and emails (model picker, Settings › Accounts). Keep them out of anything shared.

## Cleanup

```sh
node $V stop                 # or: node $V stop --run <id>
node $V runs                 # runs still on disk, with live and dead PIDs
```

`stop` reads the process tree under every recorded PID first, then SIGTERMs the phone host and Electron, sends `daemon:stop` to this run's daemon over its own socket (the daemon outlives the app by design and would otherwise keep the Project locked), SIGTERMs Metro and Vite, shuts down a simulator this run booted (`simslim shutdown`), waits, SIGKILLs only leftovers from that tree, reports ports still listening, copies logs to the evidence dir and removes the scratch dir. Evidence stays. `--keep-scratch` keeps the scratch dir for inspection. Run `stop` after every failed attempt too, so ports and processes don't pile up.

## Gotchas

- `type` inserts into whatever has focus. Click the field first; after a menu or Settings closes, focus may sit on `body`.
- The window is not focused in background mode, so a Chat you are viewing can still show the blue Unread dot after its turn ends.
- The composer's waiting state replaces the placeholder with "Steer the agent..." and turns Send into `Stop agent` (`[data-composer-submit]` stays the same element).
- Toasts (`[data-chat-toast]`) fade but stay in the DOM a moment; wait on the state change, not on the toast.
- xterm draws with WebGL: there are no `.xterm-rows` to read. Read Terminal output with `host terminal:read '[{"terminalId":"<data-terminal-tab>","after":0}]'`.
- Settings can list other computers this Mac knows about next to `<this Mac> (this Mac)`. Drive only this run's computer and Project.
- argent's tree misses iOS system alerts on a simulator argent did not boot; take one `screenshot`, tap the alert button once, then go back to `describe` data.
- The phone keeps a paired host in its keychain across reinstalls. On a simulator you reuse, expect the previous run's computer next to the new one.
- `--onboarding` checks agents against the empty scratch homes, so Claude and Codex show "Installed · not signed in". That is the expected first-launch state there, not a bug.

## Keeping the map honest

The feature map is maintained by pstack's `/maintain-verification-skill`: one source reader per feature file, one live pass through this skill, one PR of proven corrections. When you add a feature file, follow [features/README.md](features/README.md)'s entry contract so that pass can read it.
