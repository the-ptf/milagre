# Milagre

Milagre is an agent development environment: one app to run Claude Code, Codex, Antigravity and Kiro across Projects, Worktrees and computers. A host process (the daemon) owns agents, Chats and Git on each computer. The desktop app, the phone app and other paired computers are clients of that host.

## Words

- **You** are the agent changing Milagre. **We** are the maintainers you are talking to.
- **User** is a person using Milagre. **Agent** is a coding agent a user runs inside Milagre, which can include you.
- Every other domain term (Chat, Project, Worktree, Link, Routine, Subchat) is defined in `GLOSSARY.md`. Use its words, not synonyms.

## Where code lives

- `packages/core`: the host runtime. Providers, Chats, Git, MCP tools, Routines.
- `packages/shared`: the model and pure logic used by desktop and phone. Import through `@milagre/shared` exports.
- `apps/daemon`: the host process and the `milagre` CLI.
- `apps/desktop`: Electron. `app/` is the renderer (UI only), `electron/` is native windows, dialogs, notifications and updates.
- `apps/mobile`: the Expo phone app. Read `apps/mobile/AGENTS.md` before changing it.
- `apps/relay`: Cloudflare relay for phones and computers. `apps/site`: the website and its /docs. `apps/design-share`: shared Designs and Artifacts.
- `scripts/`: the test runner, Electron checks and release helpers.

Before working in an area, read the ADRs in `docs/adr/` that touch it. If your change contradicts one, say so instead of overriding it silently.

## Ways to hurt yourself

1. **Touching the running Milagre.** You are probably running inside it. Never stop, restart or connect to a Milagre, Electron, Vite or daemon process you didn't start, and never `pkill`/`killall` by name. Stopping the shared daemon kills your own agent and every other Chat. Stop only the PIDs you started.
2. **Writing to the live profile.** `~/Library/Application Support/Milagre` (`%APPDATA%\Milagre` on Windows) and `~/.milagre` hold real Chats. A dev copy you start uses `MILAGRE_USER_DATA_DIR`, `MILAGRE_WORKTREE_ROOT` and `MILAGRE_CHATS_HOME` pointing at a temporary folder, a throwaway Git repo as its cwd, its own Vite port (not 5180) and `MILAGRE_BACKGROUND=1`. From an agent shell, unset `ELECTRON_RUN_AS_NODE` or Electron starts as plain Node.
3. **Shipping a native mobile change.** A change to the mobile runtime fingerprint strands every later OTA. See "Mobile releases are OTA only".

## Hit every surface

The most common defect is a change that works where you tried it and is missing everywhere else. Before calling work done, check each entry and say which applied:

- **Desktop and phone.** Every change lands on both in the same task (see below).
- **Entry points.** A behavior in the Chat is usually also reachable from Settings, the command palette, a shortcut and the CLI.
- **Agents.** A capability a user can trigger is usually one an agent should reach through Milagre's MCP tools. Commands go through the shared dispatcher in `packages/core`, with a contract in `command-contracts.json`.
- **Providers.** Claude, Codex, Antigravity and Kiro each have an adapter. Decide per adapter, even if the decision is "not supported".
- **Computers.** A Project can live on another paired computer. Check the remote path, the relay and an offline computer.
- **Reverse states.** A way in needs a way out and a way to see it: archive and unarchive, snooze and wake, done and reopen.

### Desktop and mobile stay in sync

Every change on desktop also lands on mobile, and the reverse, in the same task. Skip it only when the user says to keep the change on one platform.

- Inspect both implementations before editing. Keep behavior, copy, states and fixes in sync; use each platform's native controls.
- Prefer shared logic in `packages/shared`. A missing counterpart is work to do, not an exemption.
- Verify on both platforms. If syncing is blocked, say what remains and why. This rule does not authorize a native build.

## Checks before a PR

Run `npm run typecheck`, `npm run lint` and the tests for what you touched with `npm test -- --only <name>`. CI runs the full suite; run `npm test -- --unit` locally only when your change is broad. The lefthook `pre-push` hook runs typecheck and lint, plus `npm test -- --only test-desktop` when the push touches `apps/desktop/electron`. A change under `apps/desktop/electron` or to window, dock, menu or notification code also gets `npm test -- --only test-desktop` on your Mac: CI runs that macOS smoke on pushes to main only, so a PR is the last place it is caught before merge.

Every desktop copy an agent or check starts on a Mac someone is using runs with `MILAGRE_BACKGROUND=1` (macOS only): no window, Dock icon, focus change, notification or dialog, while CDP still sees the real UI. `test-desktop` and `test-project-links` set it; `MILAGRE_BACKGROUND=0` shows the app.

To see a change in the real app, use the `verify-milagre` skill in `.agents/skills`. It starts its own desktop (and phone) copy, drives it like a user and stops what it started.

### Tests

- Test behavior a user or caller can observe, at the lowest layer that fails on `main`. Extend an existing test before adding a new file.
- A bug fix in logic, state or protocol starts with a test that fails on `main`.
- Wait for a condition, never a fixed time: no `setTimeout(resolve, 500)` to let something happen. Inject the clock or seed when time or randomness decides the outcome.
- A flaky test gets fixed, not retried or given a longer timeout.

## Code

- Subtract before you add. Delete the dead path before building next to it.
- No comments, with five exceptions: license headers, doc comments on a public API, behavior forced by a dependency or platform we can't change, formatter pragmas, and issue links for a constraint code can't express. A comment explaining a surprise in our own code means the code needs a better name, function or type. Lint suppressions carry a reason after `--`.
- `DESIGN.md` is the design system: read it before changing UI. `apps/site/src/design-system.test.ts` fails when its token tables drift from the code. Shared UI primitives (scrolling, choices, popovers, sliders, blur) are in `docs/agents/ui.md`.

## Docs

| Doc                      | What's in it                                   |
| ------------------------ | ---------------------------------------------- |
| `GLOSSARY.md`            | Domain terms                                   |
| `docs/adr/`              | Decisions and why                              |
| `docs/architecture.md`   | How some subsystems work                       |
| `docs/development.md`    | Dev setup, the local daemon, Windows, releases |
| `docs/mobile-local.md`   | Phone setup and the shared host                |
| `docs/desktop-guide.md`  | Desktop features for users                     |
| `docs/local-mcp.md`      | Milagre's local MCP server                     |
| `docs/agents/ui.md`      | UI primitives and their checks                 |
| `docs/agents/release.md` | Packages, signing, distribution                |

- Don't commit plans, specs, research notes or agent scratch files. Keep them outside the worktree. The merged PR is the record.
- Don't document what the code says. Write down what it can't: why it's shaped this way, a constraint across packages, a trap that cost an afternoon.
- Integrate, don't append: rewrite the part of the doc that is now wrong. One fact lives in one place; other mentions link to it.
- A new decision is an ADR in `docs/adr/` with the next number.

## Issues

Issues and specs live in GitHub Issues; use `gh`. Read one with `gh issue view <number> --comments`. When a skill says "publish to the issue tracker", create a GitHub issue.

## Pull requests

Conventional Commit titles: the version comes from them. Plain language: `fix(desktop): archived Chats no longer reappear after a restart`.

### Screenshots

Every PR that changes something visible shows the before/after or each new state, taken from the real app: the desktop dev app, the phone app against Metro, or a packaged build, with real providers. Never use the `scripts/test-*.cjs` checks, fake SDKs or agent servers (`fakeSdk`, `fake-app-server`, `fake-acp-agent`), mockups or edited images. Name the source under "Screenshots from". If the real app can't show the state, say so and leave the image out.

Screenshots never go in the PR's commits. They live on the `screenshots` branch (no shared history with `main`, never merged):

1. `git fetch origin screenshots`, then add the images in a folder named after the feature from a temporary worktree.
2. Commit and push to `screenshots`.
3. Link each image by that commit's SHA: `https://raw.githubusercontent.com/the-ptf/milagre-ade/<sha>/<feature>/<name>.png`.

The `scripts/test-*.cjs` checks save screenshots only when `MILAGRE_SCREENSHOT_DIR` is set; point it outside the repo.

### Mobile releases are OTA only

Every change to `apps/mobile` reaches phones as an EAS Update to the build already in TestFlight. A new native build needs the user's approval before you write the change that requires it.

- A change needs a build when it changes the runtime fingerprint: a dependency with native code, a config plugin, native fields in `app.json`, or an Expo SDK upgrade. JS, TS, runtime assets and copy never do.
- If your task looks like it needs one, stop and ask. Say what needs the build and whether a JS-only way exists.
- Never start an EAS build, TestFlight upload or APK build on your own.

How to check the fingerprint and publish an update: `apps/mobile/AGENTS.md`.

### Landing page Lighthouse budget

Lighthouse scores for `apps/site` never go down. The floors live in `apps/site/lighthouse-budget.json`.

- After a change under `apps/site`, run `npm test -- --only lighthouse`.
- Never lower a number to make a change pass; find what made the page slower. Raise the numbers when the page gets faster.
- `skipAudits` holds audits the site fails on purpose, each with its reason. Add to it only with the user's say-so.
- Heavy code (React, React Flow) loads after the first paint, on first interaction or when its section nears the screen.

## Rules a check enforces

Each rule below fails a check when broken, so read the error rather than remembering the rule.

| Rule                                                                                                                                                                               | What enforces it                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No AI attribution: no `Co-authored-by` trailer for Claude or Codex, no commit authored by one, no "Generated with" footer in a commit or PR description.                           | `.claude/settings.json` turns Claude Code's attribution off in this repo. `scripts/check-attribution.cjs` runs as the lefthook `commit-msg` hook and in the required `conventional` PR check; `git rebase origin/main --exec "node scripts/check-attribution.cjs --amend-head"` fixes a branch.    |
| Tests behave the same in an agent shell, a git hook and CI.                                                                                                                        | `npm test` runs every test and check without the agent shell's `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_HOME`, `ELECTRON_RUN_AS_NODE` or git's repository variables (`testEnv` in `scripts/test-runner.cjs`). Run one file with `npm test -- --only <name>`, not `node --test`, to get the same. |
| No images in a PR's commits outside the app's asset folders.                                                                                                                       | The `PR policy` check; screenshots go on the `screenshots` branch.                                                                                                                                                                                                                                 |
| Desktop and mobile change together.                                                                                                                                                | The `PR policy` check, unless the PR has the `single-platform` label (only when the user asked).                                                                                                                                                                                                   |
| The site's Lighthouse budget never gets looser.                                                                                                                                    | The `PR policy` check (label `lighthouse-budget-approved` to override) and `Site Lighthouse` on PRs that touch the site.                                                                                                                                                                           |
| A mobile change doesn't move the runtime fingerprint without approval.                                                                                                             | The `Mobile fingerprint` check, unless the PR has the `native-build-approved` label.                                                                                                                                                                                                               |
| Typecheck and lint pass before a push; electron changes get the desktop smoke.                                                                                                     | The lefthook `pre-push` hook (`scripts/pre-push-desktop-smoke.cjs`).                                                                                                                                                                                                                               |
| Phone copy says "your computer"; `RangeSlider` and `useDismiss` are the only slider and dismiss code; no native `ios`/`android` folders; Electron checks launch in the background. | Unit tests: `your-computer-copy`, `range-slider-only`, `use-dismiss-only`, `mobile-native-dirs`, `electron-checks-background`.                                                                                                                                                                     |
