# Milagre

Milagre runs Claude Code, Codex, Antigravity and Kiro across Projects, Worktrees and computers. A host process (the daemon) owns agents, Chats and Git on each computer; the desktop app, the phone app and paired computers are its clients.

**You** are the agent changing Milagre, **we** are the maintainers, a **user** is a person using Milagre. Every other term is in `GLOSSARY.md`; use its words.

## Where code lives

- `packages/core`: the host runtime (providers, Chats, Git, MCP tools, Routines).
- `packages/shared`: model and pure logic for desktop and phone, imported through `@milagre/shared`.
- `apps/daemon`: the host process and the `milagre` CLI.
- `apps/desktop`: Electron. `app/` is the renderer, `electron/` is native windows, dialogs, notifications and updates.
- `apps/mobile`: the Expo phone app. Read `apps/mobile/AGENTS.md` first.
- `apps/relay`, `apps/site`, `apps/design-share`: phone relay, website, shared Designs.

`docs/` holds one doc per subject (host, chat storage, providers, links, computers, routines, secrets, designs, development, release, UI). Read the one that owns your area. If your change contradicts it, say so.

## Ways to hurt yourself

1. **Touching the running Milagre.** You are probably running inside it. Never stop, restart or connect to a Milagre, Electron, Vite or daemon process you didn't start, and never `pkill` by name. Stopping the daemon kills your own agent.
2. **Writing to the live profile.** `~/Library/Application Support/Milagre` and `~/.milagre` hold real Chats. A dev copy you start gets temporary `MILAGRE_USER_DATA_DIR`, `MILAGRE_WORKTREE_ROOT` and `MILAGRE_CHATS_HOME`, a throwaway Git repo as cwd, a Vite port other than 5180, `MILAGRE_BACKGROUND=1`, and no `ELECTRON_RUN_AS_NODE`.
3. **Shipping a native mobile change.** A new runtime fingerprint strands every later OTA. Ask the user before writing a change that needs a native build (a native dependency, config plugin, native `app.json` field or SDK upgrade), and never start an EAS build, TestFlight upload or APK build yourself.

## Hit every surface

The most common defect is a change that works where you tried it and is missing everywhere else. Before calling work done, say which of these applied:

- **Desktop and phone.** Every change on desktop must also be applied on mobile, and every change on mobile must also be applied on desktop, in the same task. Skip syncing only when the user explicitly says to keep the change on one platform or not to sync it.
- **Entry points:** the Chat, Settings, the command palette, shortcuts, the CLI.
- **Agents:** a user action usually needs an MCP tool too, through the shared dispatcher and `command-contracts.json`.
- **Providers:** decide per adapter (Claude, Codex, Antigravity, Kiro), even if the answer is "not supported".
- **Computers:** a Project on another paired computer, over the relay, or offline.
- **Reverse states:** a way in needs a way out and a way to see it.

## Checks

CI is the gate: it runs typecheck, lint, every unit test and the Electron checks on each PR, and the macOS desktop smoke on main, in the merge queue and nightly. Nothing heavy runs on a push. Locally, run `npm run typecheck` and `npm run lint`, and `npm test -- --only <name>` for the one test you are writing or a check CI failed. Don't run the whole suite (`npm test`, `npm test -- --unit`) or `--only test-desktop` on your computer: several agents doing that at once is what freezes contributors' laptops.

To see a change in the real app, use the `verify-milagre` skill, and `stop` the run as soon as you have the evidence.

- Test what a caller can observe, at the lowest layer that fails on `main`. Extend an existing test before adding one.
- Wait for a condition, never a fixed time. Inject the clock or seed when time or randomness decides the outcome.
- Fix a flaky test; don't retry it or raise its timeout.

## Code

- Subtract before you add.
- No comments except license headers, public API docs, behavior forced by a dependency we can't change, formatter pragmas and issue links. A comment explaining our own code means it needs a better name or type. Lint suppressions carry a reason after `--`.
- UI follows `DESIGN.md` and the shared primitives in `docs/agents/ui.md`.

## Docs and issues

- Don't commit plans, specs, research or scratch files. The merged PR is the record.
- Document what the code can't say: why, cross-package constraints, traps. Rewrite the doc that owns the subject; don't append.
- Issues live in GitHub Issues (`gh issue view <n> --comments`).

## Pull requests

- Conventional Commit titles in plain language; versions come from them.
- Screenshots: every visible change shows before/after from the real app (dev app, phone against Metro or a packaged build, real providers). Never from `scripts/test-*.cjs`, fake SDKs, mockups or edited images. Say the source under "Screenshots from". Images go on the `screenshots` branch, not in the PR's commits.
- Lighthouse scores for `apps/site` never go down: run `npm test -- --only lighthouse` after a site change and find the regression instead of lowering `apps/site/lighthouse-budget.json`.

## Rules a check enforces

Read the error instead of remembering these:

- No AI attribution in commits or PRs: `check-attribution` (commit-msg hook, `conventional` check).
- Tests run the same in an agent shell, a hook and CI: `npm test` strips the agent env. Use `npm test -- --only <name>`, not `node --test`.
- Screenshots off the branch, desktop and mobile together, Lighthouse floors: the `PR policy` check (labels `single-platform`, `lighthouse-budget-approved`).
- Mobile fingerprint changes: the `Mobile fingerprint` check (label `native-build-approved`).
- File size: oxlint caps files at 800 code lines, functions at 250 and complexity at 40; files already over are capped at their size in the generated `.oxlintrc.size-baseline.json`. Split instead of raising a cap, then `npm run lint:baseline` (CI fails on a stale baseline). `npm run code-health` ranks files by size, churn and fixes.
- "Your computer" copy, one slider, one dismiss hook, no native folders, background Electron checks: unit tests.
