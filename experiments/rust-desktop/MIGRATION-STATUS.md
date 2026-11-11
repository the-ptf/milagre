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

All tests below use isolated copies, scripted provider processes or disposable synthetic carriers unless explicitly identified as saved shell evidence. None removes the production Node owner.

| Area            | Integrated checkpoint and validation                                                                                                                                                                                            | Remaining boundary                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner           | `77201a3a`, `fc188ec6`, `18203711`: root77 tests/182 Node trace steps; root identity pinned and rechecked before writes, explicit outbound field policy, total sentinel decoding and mixed-fold rollback tests.                 | Earlier containment/boundary P2 fixes pass locally and independent review closes them. Corrected streaming remeasurement passes with matching digests and reported ranges. Steering/handoff/compaction/Routines remain gated.                              |
| Codex           | `25cbcfe1`, `337efd2a`: root141 tests,579 event cases,189 policy cases,561 image cases.                                                                                                                                         | Trusted execution conditions, account/tool/media wiring and real owner runs remain.                                                                                                                                                                        |
| Claude          | `ff07398a`: root132 tests plus8 actual ContentOwner checks againstafba0d21. Non-UTF8 non-JSON diagnostics remain nonfatal; bounded display-text fallback, strict protocol identities.                                           | Independent parser safety review closes the P2. Request-local denial still absent; invalid tool arguments end the session. Analysis roles refused and no real owner provider run.                                                                          |
| ACP             | `4075edf1`: root79 tests with fake-session,12 actual Node lifecycle fixtures and921 mapper traces; strict Clippy clean. Bounded lifecycle, mapper retention, cancellation and watchdogs.                                        | Feature-gated fixed fake only. Untagged late native updates prevent safe same-process successor attribution; runtime adapter will use one fake process per host turn and refuse reuse/resume. Vendor/auth/roles remain unported.                           |
| Runtime         | `b0356590`: root45 tests against corrected owner/Claude. Atomic scope, empty skills directory, fresh session after forget, deterministic queue handshake, saturated answer Stop, native write Allow/Deny and read-only refusal. | Fixed fixture authority only. Actual Design PNG feedback verified; automatic transcript image persistence unsupported. ACP fixed-fake adapter underway; no production constructor/routing.                                                                 |
| Content/tools   | `1e69dd81`, `894f40a5`, `afba0d21`: root36 tests; callbacks leave writer lane, receipts retain uncertain outcomes, worker health tracked.                                                                                       | Production chat handlers and packaging remain. Started writes must never replay automatically.                                                                                                                                                             |
| Git/classifier  | Git21 tests/99 cases; classifierbe363f96 root9 tests/405 cases and real Git arity probes. P1s closed.                                                                                                                           | Trusted shell/PATH/config and production owner integration remain. Arity proof is Git-version specific.                                                                                                                                                    |
| Accounts        | `09710e8f`: typed pending creation identity and abandon_creation release unpublished reservations without replay. Agent32 targeted tests; prior full recovery matrices retained.                                                | Root/independent re-review pending. Removal intent and ambiguous-I/O latch follow-up underway. Recovery requires retained capability; whole-owner restart/live login/routing remain.                                                                       |
| Registry        | `808c144d`: root20 tests/332 Node read comparisons/42 mutation steps. Independent review closes prior Link/Git/pruning P2s.                                                                                                     | New P2: outside-copy seed path wedges mutation/reachability. Explicit non-admitted Outside state fix underway. No runtime wiring or live adoption.                                                                                                         |
| Usage           | `25ebb2e6` composes supervised service/cache lifecycle with bounded reads, diagnostics, poison recovery and retries. Root56 tests; Clippy clean.                                                                                | Fresh temporary capability only; real transports, production adoption/routing and whole-process restart remain. Explicit shutdown required.                                                                                                                |
| Remote          | `ec313600`, `53c60712`: root79 tests,4 compile-fail checks,5 Node reciprocal/source checks; strict Clippy clean.                                                                                                                | New P2: registry removal deny-set rejects newly re-paired key. Epoch/composed-removal fix underway before timer/service checkpoint. Production listeners/recovery/phone interoperability remain. Shared known-key crypto lane still bounded but floodable. |
| Terminals/ports | 38 terminal tests,30 port tests, disposable real PTYs/listeners and identity checks.                                                                                                                                            | Production roots/registry, Windows execution and provider integration remain.                                                                                                                                                                              |

## Current API contracts and review gates

1. Owner `PROVIDER-CONTRACT.md`: every Agent/Exited event carries `TurnId`; `close_chat(chat, turn)` targets that generation. Answer calls enqueue with `AnswerId`. Accepted means transport acceptance, not tool execution. Failed/NotWaiting require proven non-delivery. Timeout, close or ambiguous writes are Uncertain: retain history, return `ANSWER_DELIVERY_UNKNOWN`, block retries until definitive settlement or generation close. Pending plus uncertain reserve capacity before handover (default256, runtime32); never evict unresolved live entries. No manual clear. Late definitive results update history without a second RPC reply.
2. `RawJson` provider events and Started results normalize once in `ChatHost::deliver`. Direct owner calls/notices use jsjson encoding. Runtime bc6d3a9d removes its old inbound conversion. Outbound text decoding is fixed in52bc1fb6; raw immediate-error encoding remains owner follow-up. Real U+10FFFE/PUA/marker strings must survive save/reload unchanged.
3. Classifier P1s are closed by `be363f96` and independent actual-Git review. Source classification still requires trusted shell, executable and Git configuration preconditions; it is not a standalone sandbox.
4. Whole-host policy and opaque owner-issued WakeLease checks are integrated. External callbacks now run outside the content lane;8 slots remain occupied until callback exit, including after cancellation. Commit checks must be used by trusted handlers. Cancellation does not undo a started write. Review of `894f40a5` found no P1/P2; callbacks used for owner/grant checks must remain nonblocking snapshots, never actor RPCs.
5. Claude f4f8ad94 trims oversized child histories and emits compact terminal child updates; adapters must merge by id and retain prior transcript rows. The separate EOF-proof test now uses production shutdown grace and verifies reaping; root117 tests pass. Callback MCP registrations are generation-bound. Raw stored-content replies, bounded serialized buffers and receipt-aware uncertain delivery are integrated in7a5e8c3b; inbound lone-surrogate display text is repaired by7fd81353 with bounded diagnostic and strict identities;125 root tests pass, independent review pending.

The prior owner containment/outbound and Claude diagnostics fixes now pass root tests; independent re-review is pending. Registry's previous P2s are closed, with a new outside-copy seed failure assigned. Remote re-pairing needs a removal-epoch fix. Accounts reservation abandonment is committed; removal/latch follow-up remains. Runtime review fixes pass45 root tests. All experiments remain gated from production wiring; panic containment needs unwinding.

## Agents and ownership

Persistent Worktrees are under `/Users/victor/.milagre/worktrees/milagre-ade/`:

| Agent                     | Worktree suffix                                 | Current work                                                                        |
| ------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------- |
| Review10929               | `review-rust-desktop-compatibility-migrat-02j0` | Review runtime22893f24 and accounts3c431d22; prior P2 fixes pending.                |
| Owner10960                | `rust-owner-backend-storage-migration-fyrb`     | Root containment, explicit outbound field schema and total sentinel decoding.       |
| Codex10975                | `rust-codex-provider-process-adapter-fmkj`      | Fake-only ACP session lifecycle and bounded state.                                  |
| Claude11046               | `port-claude-cli-stream-control-el8w`           | Half-emoji inbound parsing plus completed-child eviction.                           |
| Usage11038                | `port-milagre-terminal-owner-to-o6rs`           | Combined isolated usage/cache service lifecycle.                                    |
| Remote11150               | `port-milagre-rust-peer-and-fbnw`               | Reconnect flood resilience plus session revocation/idle deadlines.                  |
| In-session runtime_resume | shared parent                                   | Shared MCP passes43 root tests; native Design/PNG route next.                       |
| In-session content_resume | shared parent                                   | Registry Link/Git grants and unverifiable-pruning safety fixes.                     |
| In-session git_resume     | shared parent                                   | Recovery3c431d22 committed;32 agent tests; independent review.                      |
| Root                      | shared parent                                   | Integration, independent tests, progress/report; no overlapping agent source edits. |

Use scoped commits (`git commit --only`) because in-session agents share the index. Never delete another writer's index lock. Milagre CLI is not on PATH: `node apps/daemon/src/command.cjs command run NAME --chat '/Users/victor/Code/personal/milagre-ade#10904' --input @file --data-dir "$HOME/Library/Application Support/Milagre"`. `chat_read` requires full `projectPath#id`, not a bare number. Check status before restarting historical failed tasks.

## Comparison Artifact and measurements

Artifact1442139e, "Milagre Rust migration: working comparison", version13. Six real Electron/Rust screenshots remain. Corrected streaming results replace the earlier provisional table; independent review closes the owner containment/boundary and Claude diagnostics findings. Updated Status/Measurements pass340/720 previews without horizontal overflow or console errors.

Root independently rebuilt ed32aa05 and corrected18203711 into separate fresh Cargo targets, using the identical benchmark source copied into both. Executable hashes differ. Three alternating release runs per revision produced matching notice/run/saved-state digests for every workload. Median events/s (full range):

| Workload   | Before                | Fixed                       |
| ---------- | --------------------- | --------------------------- |
| long-reply | 9,375 (9,241 to9,869) | 196,404 (167,724 to242,119) |
| many-steps | 531 (513 to535)       | 32,431 (32,335 to34,185)    |
| subagents  | 1,319 (1,293 to1,338) | 2,004 (1,845 to2,074)       |
| multi-chat | 757 (754 to771)       | 16,190 (15,468 to16,844)    |

These are synthetic Rust-before/after results under concurrent development load, not Node/Electron or model/renderer performance. Root checks run before writes; saves are debounced. Raw samples/hashes: `/private/var/folders/wv/yw79bvld7gzd8gk7dn2bs0bw0000gn/T/milagre-streaming-fixed-46nq8z2s/results.json`; log `/tmp/milagre-rust-streaming-fixed-root.log`; runner `/tmp/milagre-streaming-fixed-audit.py`. An initial extraction attempt refused macOS /var alias paths before build; canonicalizing the newly created scratch root fixed the runner. Historical unsafe-optimization figures are superseded. The still earlier shared-Cargo-target measurement is INVALID because it reused one executable.

Five earlier shell observations:55 RSS samples/50 CPU intervals. Median of run RSS medians: limited Electron922.4MiB, Rust plus3 WebKit helpers514.8MiB, shared Node359.8MiB. Rust was not steady-state, other agents varied and hidden-window visibility differed. These are observations, not a full-app speedup/memory reduction. Raw `/tmp/milagre-rust-paired-observation/summary.json`.

Two saved Designs in `/tmp/milagre-real-design-copy` match Node/Rust HTML and same-engine Chromium pixels, not independent cross-engine proof. Cold/warm startup, equivalent foreground latency/FPS, standalone process footprint and upgrade/rollback remain unmeasured.

## Current validation and continuation

Root tests after integrating the latest checkpoints:

- Registry20 at808c144d: `/tmp/milagre-rust-registry-grants-root.log`; strict Clippy `/tmp/milagre-rust-registry-grants-clippy.log`.
- Design route at0998ba6a: full runtime43 tests in `/tmp/milagre-rust-runtime-design-root.log`; native MCP PNG240x240 pixels, saved versions1/2, renderer version3 and actual owner artifact steps. No automatic transcript image step is claimed.
- Latest safety integration: owner77, Claude132, ACP79(feature enabled), runtime45, all passing in `/tmp/milagre-rust-{owner,claude,acp,runtime}-safety-root.log`. Owner/Claude/ACP strict Clippy pass;12 Node ACP lifecycle traces verify in `/tmp/milagre-rust-acp-session-node-root.log`. Claude8 ContentOwner checks pass in `/tmp/milagre-rust-claude-parser-content-root.log`.

- Claude127: `/tmp/milagre-rust-claude-heartbeat-root.log`;8 real isolated ContentOwner tests: `/tmp/milagre-rust-claude-retention-content-root.log`.
- Runtime43: `/tmp/milagre-rust-runtime-heartbeat-root.log`. Actual production Node clients drive scripted providers, including queued turns and the shared native MCP content route.
- Usage56: `/tmp/milagre-rust-usage-heartbeat-root.log`.
- Remote79 plus4 compile-fail checks: `/tmp/milagre-rust-remote-heartbeat-root.log`. All5 Node scripts pass, including fresh reciprocal signatures, phone envelopes and new registry/window predicates.
- Claude/usage/remote strict Clippy: `/tmp/milagre-rust-{claude,usage,remote}-heartbeat-clippy.log`.
- Accounts32 is an implementation-agent result, not a new root rerun. Accounts log `/tmp/milagre-accounts-recovery-final.log`; reservation leak fix underway.

Historical owner70 tests remain valid test results but missed the newly reviewed containment regression. Earlier full repository baseline7226 tests/18 skipped/660 files and shell39 tests/1 optional live skip are checkpoint results, not fresh whole-repository checks. No PR or push, no simulator boot, no mobile fingerprint change.

Task phase review. Heartbeatf3fd7e41 remains enabled every10min throughNovember17. Installed shell source still matches440f06d1; signature passes. Production hostPID55108 and RustPID16468 retain their recorded start times. Saved WebKit smoke passes at its November10 timestamp; no fresh interactive workflow run is claimed. Backend-only commits do not require replacement of the installed shell.

Next: independently re-review owner/Claude safety fixes, validate registry outside-copy and remote re-pair fixes, retain corrected streaming evidence, finish ACP session orchestration and runtime scope/permission checks, then production registration/lifecycle, existing-data upgrade/rollback and real phone interoperability. The shared Node owner remains required.

## Latest review and validation follow-up

Sonnet closes owner root containment, explicit outbound identities and rollback P2s, plus Claude non-UTF8 diagnostics. ACP4075edf1 has a new P2: dropping an admitted answer observer can kill the healthy session even after writing; fix assigned10975. Its runtime adapter remains opt-in/fixed-fake, one process per host turn, and refuses/holds successor turns at the existing owner handoff gate. No fabricated resumable session id or gate bypass.

Registry8b2a0370 distinguishes Outside from Gone and unverifiable, preserves outside-copy seeded rows during inside mutations and never grants them. Root22 tests pass (`/tmp/milagre-rust-registry-outside-root.log`); re-review requested. Accounts76c169d6 adds Removing intent and uncertain-I/O latch; root34 top-level tests pass with two long fault/crash matrices deliberately skipped (`/tmp/milagre-rust-accounts-reservation-removal-root.log`). An extra child test line in that log is nested, not a 35th top-level test. Agent full36 tests include300 injected errors and87 abrupt exits. Removal and abandon fixes are under review. AccountService read accessors now return Result; pure Accounts/Selection unchanged.

Remote removal/re-pair epoch fix remains assigned before service integration. Owner release/Drop root checks and lifecycle P3s are assigned separately. The installed Rust app and production host remain unchanged; no push or mobile/native build.
