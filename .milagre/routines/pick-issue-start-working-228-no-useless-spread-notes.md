# Issue #228: explicit iterable snapshots

This run completes the `unicorn/no-useless-spread` rule, as issue #228 requests one rule per PR. The umbrella issue remains open for its other rules. The original routine prompt already existed in `pick-issue-start-working.md` and was kept unchanged.

## Approach

The baseline had 63 diagnostics across 37 source/check files. The rule is now an error with zero diagnostics and no new suppressions.

- Native Promise consumers synchronously enumerate their non-null Sets or Map iterators. Their intermediate arrays are removed.
- Loops that call external callbacks, dispatch events, await cleanup, walk live DOM attributes or reorder the Chat LRU retain a snapshot through `Array.from`.
- Deletion-only native Set/Map loops with no callbacks walk their collection directly.
- VM-created test arrays retain host-realm normalization through `Array.from`. Removing that conversion failed deepStrictEqual even though values matched; the full suite caught it and the conversion was restored.

## Baseline audit

Counts refer to the pre-change diagnostic list.

| File                                                      | Sites | Treatment                                                                  |
| --------------------------------------------------------- | ----: | -------------------------------------------------------------------------- |
| `apps/daemon/src/mobile-push.cjs`                         |     1 | Pass native iterable directly to Promise consumer                          |
| `apps/daemon/src/phone-channels.cjs`                      |     1 | Keep callback/await snapshot with Array.from                               |
| `apps/daemon/src/phone.cjs`                               |     2 | Keep callback/await snapshot with Array.from                               |
| `apps/daemon/src/relay-host.cjs`                          |     2 | Keep callback/await snapshot with Array.from                               |
| `apps/daemon/src/relay-test-kit.cjs`                      |     1 | Keep callback/await snapshot with Array.from                               |
| `apps/daemon/src/server.cjs`                              |     1 | Delete captures directly; native Promise continuations run after traversal |
| `apps/desktop/app/src/components/agents/design-export.ts` |     1 | Keep live DOM attribute snapshot                                           |
| `apps/desktop/app/src/components/PromptComposer.tsx`      |     1 | Keep callback/await snapshot with Array.from                               |
| `apps/desktop/app/src/lib/chat-messages.ts`               |     2 | Keep resubscription and LRU traversal snapshots                            |
| `apps/desktop/app/src/lib/panel-resizing.ts`              |     1 | Keep callback/await snapshot with Array.from                               |
| `apps/desktop/app/src/lib/routines.ts`                    |     2 | Keep callback/await snapshot with Array.from                               |
| `apps/desktop/electron/notifications.cjs`                 |     6 | Keep notification callback snapshots; remove deletion-only copies          |
| `apps/desktop/electron/preload-computer-events.test.cjs`  |     1 | Keep callback/await snapshot with Array.from                               |
| `apps/desktop/electron/preload.cjs`                       |     3 | Keep subscription snapshots; remove remote deletion-only copy              |
| `apps/mobile/src/chat-pages.ts`                           |     1 | Keep resubscription and LRU traversal snapshots                            |
| `apps/mobile/src/design-catalog.ts`                       |     1 | Keep callback/await snapshot with Array.from                               |
| `apps/mobile/src/relay-transport.ts`                      |     1 | Keep callback/await snapshot with Array.from                               |
| `apps/relay/src/hooks.mjs`                                |     1 | Keep callback/await snapshot with Array.from                               |
| `packages/core/src/accounts.cjs`                          |     1 | Keep callback/await snapshot with Array.from                               |
| `packages/core/src/advisor-store.cjs`                     |     2 | Pass native iterable directly to Promise consumer                          |
| `packages/core/src/agents/codex-provider.cjs`             |     1 | Keep callback/await snapshot with Array.from                               |
| `packages/core/src/agents/permissions.cjs`                |     2 | Keep callback/await snapshot with Array.from                               |
| `packages/core/src/agents/questions.cjs`                  |     2 | Keep callback/await snapshot with Array.from                               |
| `packages/core/src/browsers-cdp.cjs`                      |     2 | Keep callback/await snapshot with Array.from                               |
| `packages/core/src/browsers.cjs`                          |     2 | Keep callback/await snapshot with Array.from                               |
| `packages/core/src/browsers.test.cjs`                     |     1 | Keep callback/await snapshot with Array.from                               |
| `packages/core/src/chat-title.test.cjs`                   |     1 | Pass native iterable directly to Promise consumer                          |
| `packages/core/src/local-mcp-operations.cjs`              |     1 | Pass native iterable directly to Promise consumer                          |
| `packages/core/src/local-mcp-server.cjs`                  |     1 | Pass native iterable directly to Promise consumer                          |
| `packages/core/src/project-state.cjs`                     |     1 | Flatten the nested fresh argument array                                    |
| `packages/core/src/routines/scheduler.cjs`                |     1 | Pass native iterable directly to Promise consumer                          |
| `packages/core/src/runtime.cjs`                           |     4 | Pass native iterable directly to Promise consumer                          |
| `packages/core/src/simulators.cjs`                        |     2 | Keep callback/await snapshot with Array.from                               |
| `packages/core/src/terminals.cjs`                         |     2 | Keep callback/await snapshot with Array.from                               |
| `packages/shared/src/chat-activity.mjs`                   |     1 | Keep callback/await snapshot with Array.from                               |
| `packages/shared/src/display-clock.ts`                    |     1 | Keep callback/await snapshot with Array.from                               |
| `scripts/mobile-ui.test.cjs`                              |     6 | Keep listener snapshots and normalize VM arrays into the host realm        |

## Review and local verification

Claude Opus 5.5 approved the bounded rule choice and snapshot strategy. GPT-6 Astra reviewed direct deletion, Promise consumption and reentrancy, then re-reviewed the VM realm correction.

Required static checks, full unit checks and real desktop/iPhone evidence are recorded in the PR. No new test cases were added. Temporary probes ran the production Chat and panel modules for self-resubscription, deferred listeners and updating two LRU windows exactly once. A scratch lint probe confirmed a redundant spread fails while an explicit snapshot passes.

The iOS fingerprint before the change was `f4e06634227845fd1879a6569989ac2bfe11e693`, matching the latest TestFlight build 33. Only JavaScript/TypeScript and lint/routine text changed. No native build, OTA update, deployment, public review page or artifact was created.

## Proposed routine improvements

1. Preserve a copy when it stabilizes callback membership, await boundaries, live DOM collections, LRU traversal or VM realm identity. Lint suggestions do not prove a copy is redundant.
2. Keep the exact routine prompt separate from run notes. Use available Claude/Codex advisors for review; do not require an unavailable model or add a new MCP for routine work.
3. Use `test-milagre-app`, `test-milagre-mobile`, `systematic-debugging` and `verification-before-completion`; keep real-provider smoke screenshots distinct from scripted check evidence.
4. Bound test concurrency on a simulator-heavy local Mac and record the command and any default-run timeouts. Do not weaken production behavior or increase timeouts merely to hide load.
5. Keep review evidence local and in the requested PR. Do not follow older notes that propose publishing a report, artifact or tunnel.

## Recorded results

- `npm run typecheck`, `npm run typecheck:mobile`, `npm run lint`, `npm run build` and changed-file `oxfmt --check` passed. The mobile workspace has no separate `lint` script; the root oxlint command covers it.
- `npm test -- --unit` exposed the VM array regression, which was fixed. Two default-concurrency runs also hit the existing peer usage fixture's 5-second daemon-frame deadline on this loaded Mac. That fixture and the initial review-demo timing failure passed in isolation. No timeout was increased.
- The complete 447-file suite passed with `node --test --test-concurrency=2 $(node scripts/test.cjs --unit --list)`: 5,249 passed, 12 skipped, zero failures (427.3 seconds).
- Electron checks passed: `test-desktop`, `test-find-in-chat`, `test-chat-attachments`, `test-browsers`, `test-simulators`, `test-artifacts`, `test-routines` and `test-panel-resize`. Existing mobile UI checks passed separately (311 cases); targeted permissions, questions, display-clock and preload checks passed (46 cases).
- Real desktop dev app: three Codex Chats, streaming, a `cat README.md` approval, repeated Chat switching, all three find matches, and the responsive 620px viewport. Temporary production-module probes verified bounded self-resubscription, deferred new listeners and exactly one update for each of two LRU windows.
- Real iPhone 17 Pro simulator, iOS 27, existing development client against this checkout at Metro 8918: a phone-originated reply synchronized with desktop; after restarting the local bridge and app, the saved Chat included the new `RECONNECT-OK` exchange. Later native automation failed before app launch at `launchctl setenv`; the task-owned clone was shut down, without restarting the machine-wide simulator service or other devices. No Android native run was made.
- iOS fingerprint after verification remains `f4e06634227845fd1879a6569989ac2bfe11e693`, equal to the before hash and TestFlight build 33.

The requested PR carries smoke screenshots from the real dev apps. These demonstrate unchanged UI while the internal iteration code runs; they are not before/after design claims. No separate report or public review page was published.
