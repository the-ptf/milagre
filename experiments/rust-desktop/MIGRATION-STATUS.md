# Integration status (2026-11-11)

Local branch `poc/rust-tauri-local`, parent Chat `/Users/victor/Code/personal/milagre-ade#10904`. Nothing pushed. The migration is **not complete**: the installed Rust shell still needs the production Node owner. Keep the existing React UI and retained features. Only browser embedding, voice, floating inbox and decorative effects may be omitted.

Never restart/replace the production host, take over live locks, launch a second live writer or change the native mobile fingerprint without explicit approval. All experimental owner/provider checks use isolated copies, synthetic data or fake provider processes. A passing library test is not a production cutover.

## Installed app and actual WebKit evidence

- `~/Applications/Milagre Rust.app`, orange R icon, bundle `com.milagre.rust-poc`, shell checkpoint `440f06d1`. Later commits affect experimental backend code only. No replacement binary is needed until shell source changes.
- Signature verification passes. Release/installed Mach-O UUID: `8CDB99FC-A413-33EC-BB0B-DFD7048464E1`. Installed Rust PID16468 started November10 23:32:28; production host PID55108 started November10 08:32:04. Both rechecked unchanged. Production Electron is separate.
- `/tmp/milagre-rust-smoke.json`, November10 23:33:02: content isolation/raw native IPC denial, five workflow checks and three comparison captures pass. Workflow coverage: Changes panel/file list, eight terminal profiles, four providers/nine accounts, attachment controls and background download cancellation with zero writes. No interactive terminal or attachment send was exercised.
- `/tmp/milagre-rust-live-chat-evidence.json`: earlier real Claude QA Chat11013, one user send and one saved assistant reply, live text and completion, exact `RUST_BRIDGE_OK`, zero tools. Never resend to this nonempty QA Chat.
- Actual WKWebView captures: `/tmp/milagre-rust-{chat,designs,artifacts}.png`, 2880x1800 at1440x900 CSS. Evidence is private and outside Git. No screenshot is committed.

Interactive save/clipboard, notification delivery/click, cross-frame shortcuts, attachment sending, terminal UI actions, phone synchronization and upgrade/rollback remain unverified. `desktop:register` priority/standby, fully bidirectional preferences and Electron safeStorage/keychain wrapper migration remain blockers. Do not read or print live secrets or replace a missing master key.

## Current integrated backend checkpoints

| Area                   | Latest checkpoint and evidence                                                                                                                                                                                                    | Remaining boundary                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner storage/ChatHost | `072314da` forced-close safety; `1f810bf9` step/subagent/plan/task folds and asynchronous answers. Root60 tests,161 Node ChatHost steps,43 summary cases; prior620 saved reads,93 writer steps,96 ProjectStates steps.            | Isolated copies only. Independent review pending. Steering, handoff, compaction, Routines, wake turns and several special answer types remain gated.                                      |
| Codex provider         | `25cbcfe1` images, `337efd2a` classifier panic containment; root141 tests,579 event cases,189 policy cases,561 image cases; image fixtures regenerate unchanged.                                                                  | Real account/policy/tool/media wiring and supported execution environment required. No live owner run.                                                                                    |
| Claude provider        | `6395c24e`: output count/byte bounds, receiver drop, session-owned admitted steers, image I/O outside state lock; root103 tests.                                                                                                  | Review requires child snapshots to trim rather than kill normal turns. MCP callback bridge in progress. Analysis remains refused.                                                         |
| Wire/runtime           | `18a9cc5d`, `e8d84a46`, `10872b34`, `d22b9615`, `4f06b24b`: single actor, shared content, bounded teardown and fixture Codex adapter. Agent25 runtime tests and strict clippy pass; earlier root15 runtime/nine wire tests pass.  | New `1f810bf9` owner answer/close APIs require adaptation and a new root run. Fixture bridge has no real provider constructor or default wiring.                                          |
| Content/tools          | `d2ac471b` renderer capability/caller isolation; `a1db1911` bounded blocking workers and cancellation receipts; root28 tests. Prior native HTML/SVG/PNG, kit, intent and persistence ports pass27 store tests;63 Node tool calls. | Whole-host shared role capability and wake release are being implemented. Actual provider/packaging integration remains.                                                                  |
| Git/classifier         | Git21 tests/99 Node read cases, isolated mutation/read capabilities. Classifier `6d74f878` exact flags fixes abbreviations.                                                                                                       | New P1: inline-only flags wrongly consume a following option. Fix and generic actual-Git arity differential underway. Trusted shell/PATH/config remains required even after parser fixes. |
| Accounts               | `ecd99573`: isolated metadata service, atomic single-writer updates and owner/account/generation-scoped readiness. Root19 tests;300 Node calls and42 mutation steps regenerate unchanged.                                         | No production profile adoption, preparation/login, CLI inspection or runtime registration. Creation explicitly returns pending preparation/login.                                         |
| Usage                  | `bdbd2e88`: quota/cache transitions, transcript scans, pricing and reports. Root18 tests/109 actual Node cases regenerate unchanged.                                                                                              | Account-scoped commands, persistence and supervision in progress. No live credentials/network; Windows scan unsupported.                                                                  |
| Remote                 | `49539492`: consuming service authorization, leased raw frames, shared budgets and expiry. Root42 tests plus three compile-fail checks and both reciprocal Node checks pass.                                                      | Trusted authorization records, timers/non-frame reservations, proofs, listeners, HTTP forwarding and actual phone interoperability remain.                                                |
| Terminals/ports        | 38 terminal tests,30 port tests; actual disposable PTYs/listeners, process identity and protected-group checks.                                                                                                                   | Production roots/registry, Windows execution and provider integration remain.                                                                                                             |

No experiment currently removes the production Node owner. ACP for Kiro/Antigravity, registry, Links/Routines, remaining MCP/chat services, account login and remote service lifecycle are still incomplete.

## Current API contracts and review gates

1. Owner `PROVIDER-CONTRACT.md`: every Agent/Exited event carries `TurnId`; `close_chat(chat, turn)` targets only that generation. `tick(now)` pumps before forcing interrupts. Forced forget/quit block new starts. Permission/question methods enqueue with `AnswerId`, then emit exactly one `AnswerSettled`. Runtime must hold a pending RPC until matching settlement; never return optimistic success. Timeout or closed session rolls back the recorded answer.
2. Classifier P1 is assigned to `git_resume`: `--pretty`, `--format`, `-U`, `--unified` have incorrect value arity. Reject swallowed option tokens and test every value-table entry against actual Git. Earlier exact-name checks alone did not close this class. No constrained live use.
3. Host policy `89abc632` has direct enforcement and atomic6+2 budget, but review requires one shared whole-host policy across endpoint registries and releasable owner-issued wakes. Current256 lifetime wake cap is not production-ready. `chat_respond`, Babysit and ExecutionAdvisor remain unavailable in the content host.
4. Content panic fix `58adbb76` holds on independent review. Faulted owners stop mutations; shutdown releases stores despite retained sessions. Later `d2ac471b` scopes caller failures and mints renderer authority. `a1db1911` keeps accepted writes single-owner off the async executor, with NotAttempted/Committed/Uncertain receipts. Never replay an uncertain write.
5. Claude review: trim oversized child histories with an explicit truncation marker instead of failing the parent; settling child statuses must not mask Stop or the actual terminal event. Callback-only MCP bridge binds each registration generation to the existing content dispatcher; no second store owner, unsafe preallows or fabricated handshake.

Sonnet is reviewing new owner safety/features and remote safety. Other findings are assigned; do not claim re-review passed before its report. Panic containment depends on unwinding; experiment Cargo profiles currently have no panic-abort setting, but packaging must preserve this.

## Agents and ownership

Persistent Worktrees are under `/Users/victor/.milagre/worktrees/milagre-ade/`:

| Agent                     | Worktree suffix                                 | Current work                                                                        |
| ------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Review10929               | `review-rust-desktop-compatibility-migrat-02j0` | Owner feature/async answer and remote safety review.                                |
| Owner10960                | `rust-owner-backend-storage-migration-fyrb`     | Next steering contract/Node fixtures; API proposal before changes.                  |
| Codex10975                | `rust-codex-provider-process-adapter-fmkj`      | Separate `rust-acp` foundation for Kiro/Antigravity.                                |
| Claude11046               | `port-claude-cli-stream-control-el8w`           | Callback MCP bridge, then child snapshot/terminal safety.                           |
| Usage11038                | `port-milagre-terminal-owner-to-o6rs`           | Account-scoped usage service and persistence/supervision.                           |
| Remote11150               | `port-milagre-rust-peer-and-fbnw`               | Synthetic host proof and authoritative service authorization records.               |
| In-session runtime_resume | shared parent                                   | Codex/actor async answer adaptation, then integration tests.                        |
| In-session content_resume | shared parent                                   | Shared whole-host role capability/wake lifecycle.                                   |
| In-session git_resume     | shared parent                                   | Urgent classifier arity fix; account service checkpoint committed.                  |
| Root                      | shared parent                                   | Integration, independent tests, progress/report; no overlapping agent source edits. |

Use scoped commits (`git commit --only`) because in-session agents share the index. Never delete another writer's index lock. Milagre CLI is not on PATH: `node apps/daemon/src/command.cjs command run NAME --chat '/Users/victor/Code/personal/milagre-ade#10904' --input @file --data-dir "$HOME/Library/Application Support/Milagre"`. `chat_read` requires full `projectPath#id`, not a bare number. Check status before restarting historical failed tasks.

## Comparison Artifact and measurements

Artifact `1442139e`, “Milagre Rust migration: working comparison”, version5. Tabs: Status, Screenshots, Measurements. Six real matching Electron/Rust captures retained;340/720 preview widths have no overflow. Assets/source ignored under `.milagre/rust-comparison-report`. Electron evidence is the real production renderer/preload in a limited background capture shell connected to the unchanged owner, not the whole installed main process. Rust evidence is the installed WKWebView app.

Five runs,55 RSS samples,50 CPU intervals. Median of run RSS medians: limited Electron922.4MiB; Rust plus three verified WebKit helpers514.8MiB; shared Node359.8MiB. Rust was not steady-state, other agents varied and hidden-window visibility differed. These are observations, not a full-app speedup or memory-reduction claim. Raw `/tmp/milagre-rust-paired-observation/summary.json`.

Two saved Designs under private `/tmp/milagre-real-design-copy` match Node/Rust HTML and same-engine Chromium pixels; this is not independent cross-engine proof. Cold/warm startup, equivalent foreground latency/FPS, standalone process-tree footprint and upgrade/rollback metrics remain unmeasured. Final Artifact must show matched actual screenshots and retained/omitted/unported/unverified features. Do not replace phone-readable results with local file links.

## Verification and continuation

Recent root logs: `/tmp/milagre-rust-owner-features-root.log`, `/tmp/milagre-rust-remote-safety-root.log`, `/tmp/milagre-rust-accounts-service-root.log`, `/tmp/milagre-rust-accepted-tools-root.log`. Earlier root logs for Codex141, Claude103, usage18 and classifier8 remain under `/tmp/milagre-rust-*`. Latest owner/remote/account/tools checks passed; runtime must be rerun after new owner API adaptation.

Full repository baseline previously passed7226 tests,18 skipped,660 files; typecheck/lint passed. Shell39 tests pass with one optional live test skipped. Only broaden checks when changes justify it. No PR/push. Keep desktop copies background on an occupied Mac. Any future iOS simulator must use simslim boot+verify; none was booted for this migration.

Task phase review; backend/native parity tasks remain in progress. Heartbeat `f3fd7e41` every10min expires November17. Keep it until genuine full completion. Never replace the production host to make a test pass. Complete isolated integration, then qualify standalone ownership, existing-data upgrade/rollback, phone compatibility and equivalent-workload performance before declaring completion.

## Latest integration and open negotiation

Integrated Claude MCP `acb4b7ba`, usage commands `75a6761f`, and gated steering conformance `8ee1e69a`. Root base Claude111, usage31, tools31 and classifier9 tests pass. Actual Git value-arity and Node trace regeneration pass for classifier `be363f96`. The new steering-notice build failure is fixed by bda8858d with explicit unsupported handling; root28 runtime tests now pass. WakeLease harness compatibility63bca8d1 is integrated as c8ac1b57; all three actual ContentOwner/fake-CLI tests pass against latest shared policy1e69dd81. Logs: /tmp/milagre-rust-runtime-current-root.log and /tmp/milagre-rust-claude-content-current-root.log. Neither check uses a real provider or production owner.

Owner negotiation opened: Codex approval write can outlive a cancelled future, so timeout/close cannot prove non-delivery. Proposed `AnswerOutcome::Uncertain`, retained answer, `ANSWER_DELIVERY_UNKNOWN` and duplicate retry suppression. Definitive failure/rollback only when non-delivery is proven. Raw provider events should normalize once at owner boundary; runtime currently encodes, so both sides must change together. Steering preserves Node failed-steer behavior but stays gated until delivery and terminal ordering are proved. Sonnet new refused-quit queue and quadratic-streaming P2s are assigned to owner, with measured release harness requested.
