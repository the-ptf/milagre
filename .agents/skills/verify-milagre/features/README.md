# Milagre verification map

This directory is the maintained source for verifying Milagre's user-facing behavior with the `verify-milagre` helper. Read this index, then use the matching feature file as the recipe.

## Baseline preconditions

- Run from the repository root with `V=.agents/skills/verify-milagre/scripts/verify-milagre.cjs`.
- Start a run with `node $V launch` (add `--claude-config-dir <dir>` when the default Claude account is at its limit). The run owns a scratch Git repo `verify-project` with `README.md` and `notes.txt` on `main`, one commit, and no Chats.
- `node $V doctor` passes before the first drive.
- Never drive an instance this run did not start.

## Driving conventions

- Start each recipe from the baseline unless its preconditions say otherwise. Recipes that need a Chat create it through the composer.
- Prefer `aria-label` names (`--name`) and `data-*` handles over text or coordinates.
- Act with `click`, `type`, `press`. Read with `wait`, `eval`, `host`. Never change app state through `eval`.
- Use Claude Haiku and one-line prompts for anything that runs an agent.
- Phone recipes drive the simulator through argent with tap points from the returned element tree.

## Proof and skip reporting

- Capture the action and the resulting state: the `actions.jsonl` line plus a `shot` or `snapshot`.
- Confirm side effects from a second view: `host` (daemon state), the scratch repo on disk, `profile/preferences.json`, or the other device.
- Record the feature file and entry point with `node $V note`.
- Report an unreachable path with the command tried and the unmet precondition. Do not report a skipped entry point as verified through another one.

## Feature entry contract

Each feature file starts with an H1 and one paragraph on the user-visible behavior, then exactly four H2 sections in this order:

1. `Sub-features`: short IDs, one line each.
2. `How to get to it (user POV)`: every user entry point.
3. `Driving it with verify-milagre`: starts with `Preconditions:`, then labeled bullets pairing each user action with the exact command and the observable result.
4. `Gotchas`: traps that waste or invalidate a run.

## Features

- [Send a Chat message](./chat-send.md): new Chat, model picker, send, real reply, Stop, persistence.
- [Approve a tool call](./tool-approval.md): Ask mode approval card, Allow once, the file it writes.
- [Sidebar Chat actions](./sidebar-chat-actions.md): rename, pin, mark Done from the row and its context menu.
- [Command palette](./command-palette.md): search Chats and open one.
- [Terminal panel](./terminal.md): open a Terminal in the Chat's Worktree and run a command.
- [Changes panel](./changes-panel.md): uncommitted files and their diff.
- [Settings](./settings.md): Appearance mode, settings search, close.
- [First launch onboarding](./onboarding.md): Dawn intro, agent check, Project step, first Chat.
- [Phone pairing and shared Chats](./phone.md): pair the phone app with the run's host, open a Chat, send from the phone.

## Not covered yet

These user-facing features exist and have no recipe here. Add a file when a change touches one.

- Worktree Chats (New chat with a new Worktree), branch picker, Worktree setup command.
- Commit and open PR (composer PR pill, row menu `Commit and open PR…`), PR panel tabs. Needs a GitHub remote.
- Browser panel and agent browsers.
- Designs canvas and HTML artifacts.
- Canvas (Projects and Links), Links between Worktrees, Subchats and delegation.
- Routines and Heartbeats.
- Snooze, Delete, Reload Chat, undo toast (⌘Z).
- Attachments (paperclip, drag and drop), `@` file mentions, `/` skills.
- Dictation (needs a microphone and a speech model download).
- Accounts and usage limit switching, Settings › Models, MCP servers, Skills, Keybindings.
- Computers (pairing another desktop), relay and Tailscale routes.
- Linear integration (needs a Linear sign-in).
- Floating inbox (covered by `npm test -- --only test-desktop`).
- Android phone app (see the Android QA rig notes; the emulator flow differs: Metro via `debug_http_host`, `adb reverse` for the bridge).
- The `milagre` CLI (`npm run cli`).
