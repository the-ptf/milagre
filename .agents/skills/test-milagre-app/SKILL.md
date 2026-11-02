---
name: test-milagre-app
description: Verify Milagre's desktop UI with isolated Electron fixtures, realistic Chat state and screenshots. Use for desktop regression checks and interactive verification in this repository; use test-milagre-mobile for the native phone app.
---

# Test Milagre desktop

Read [AGENTS.md](../../../AGENTS.md) for cross-platform and PR requirements. Run commands from the repository root. For native phone behavior, also use [test-milagre-mobile](../test-milagre-mobile/SKILL.md).

## Choose the check

Inspect the changed flow and its existing `scripts/test-*.cjs` check before starting a new harness. The runner selects by filename substring:

```sh
npm test -- --list --only prompt-skills
npm test -- --only prompt-skills
```

Replace `prompt-skills` with the affected check, such as `subagents`, `handover`, `browsers` or `skills-settings`. `--only` selects matching unit files too; `--electron --only <name>` selects only Electron checks. Read skip messages: an unsupported-platform skip is not verification. Run Electron checks sequentially because some use fixed Vite ports. Inspect [the runner](../../../scripts/test-runner.cjs) for platform restrictions and build requirements.

For full-app startup, saved state and host ownership, use `npm test -- --only test-desktop`. It builds the renderer and launches the real app against temporary state. Component fixtures exercise real renderer components but may stub host calls; use a runtime/bridge test or the full app when the change concerns persistence or IPC.

## Keep test state separate

Launch every app copy off screen with `MILAGRE_BACKGROUND=1` (the full-app checks set it; macOS only, ignored elsewhere): it never shows a window, takes the Dock or focus, and CDP screenshots still show the rendered UI. A dev copy: `env -u ELECTRON_RUN_AS_NODE MILAGRE_BACKGROUND=1 MILAGRE_CHATS_HOME=<tmp>/chats-home MILAGRE_DEV_SERVER_URL=<url> "$(node -p 'require("electron")')" apps/desktop --user-data-dir=<tmp>/profile --remote-debugging-port=0`.

Existing Electron checks create temporary profiles and Projects. Reuse that pattern for new fixtures: set Electron `userData` before app readiness and use a disposable Git repository for the Project. The normal `npm run dev` command is not an isolated-state guarantee.

Never open the development repository or a real user's Project in a second test host. Ownership covers the common Git directory, so another Worktree of the same Project does not provide isolation. Do not remove live ownership locks to make a fixture start.

Seed states that distinguish the behavior being changed: a saved Chat for persistence, populated lists for scrolling, or active and failed operations for controls. Prefer host APIs for fixture changes. If an offline fixture must edit storage, stop its host first and inspect the current storage implementation; Chat messages may live in SQLite rather than the Project JSON.

## Exercise and capture

Use the repository's Electron harness and DOM assertions for repeatable checks. For interactive inspection, use available browser/desktop automation tools against this task's fixture; discover their actual APIs rather than assuming T3's `preview_*` tools exist. Confirm the running checkout and URL before interacting. Do not stop another task's listener to free a port.

Capture the state that demonstrates the change:

```sh
milagre_shots=$(mktemp -d "${TMPDIR:-/tmp}/milagre-ui.XXXXXX")
MILAGRE_SCREENSHOT_DIR="$milagre_shots" npm test -- --only prompt-skills
```

Inspect the images for loaded content, the intended state and clipped controls. A screenshot alone does not establish that a control worked: verify its observable result. Keep credentials, pairing codes and unrelated Chats out of captures. These harness screenshots are for checking your work only. PR images come from the dev app or a packaged build with real providers and live on the separate screenshots branch, as [AGENTS.md](../../../AGENTS.md) specifies.

Run the corresponding mobile checks when behavior is shared. Before a PR, run the root typecheck, lint and unit commands required by AGENTS.md. Report the checks actually run, skips, failures and evidence paths; distinguish scripted providers from real-provider verification.

Automated checks clean up their own fixtures. Keep an interactive preview and its terminal session available while the user is inspecting it. At teardown, stop only retained task-owned processes and remove only disposable state you created.
