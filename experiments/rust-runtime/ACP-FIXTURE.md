# Isolated ACP owner fixture

This adapter is compiled only with `--features acp-fixture`. `AcpFixture::create(Scenario)` mints a private Project copy and runs only rust-acp's fixed repository fake scenarios. It accepts no executable, environment, existing profile, credentials, account, auth callback or MCP configuration. No real provider or production host is wired.

## Process and turn ownership

Each admitted host TurnId owns one FakeSession and one process. The session's local TurnId is bound to that host ID. All mapped events are plain RawJson; the owner performs the encoding boundary once. Native session-started IDs are deliberately not persisted: they cannot authorize resume or imply preserved context.

The adapter closes the session and drains its private executor before publishing the terminal and one Exited event. A successor process cannot receive the preceding process's untagged ACP frames. A wrong local turn closes the fixture. Tests prove late post-response text is absent, two direct adapter turns have distinct PIDs, and all recorded PIDs have been reaped when the terminal reaches the consumer. A close request is checked against the captured host generation; an old close cannot affect its replacement.

A startup failure emits StartFailed and Exited, leaving the owner to produce its one terminal. A native terminal emits one Agent terminal and Exited. Stop uses the session cancellation epoch and watchdog. Session startup is bounded to 500 ms, idle progress to 3 s, the turn to 5 s, and cancellation cleanup to 150 ms in these fixtures. An executor drain exceeding 3 s latches cleanup failure and closes admission, while the worker and private profile remain retained until supervisors finish. Killing a process never proves an answer was not delivered.

## Permissions and bounds

Only Allow once and Deny are supported. The small command card is explicitly fixture UI, not a port of the Node vendor permission/card policy. Persistent grants, questions, model/effort settings, images, host roles, resume and extra request configuration are refused. Native numeric/string request IDs are retained as typed RequestId values behind a generation-specific local card token; presentation strings are never used as native identity.

The worker admits answers through `admit_answer` and observes the returned session-owned receipt independently of the owner RPC observer. Dropping that receipt never retracts the session-owned command. Admission failure is proven not delivered and reports Failed; after admission, missing delivery evidence remains Uncertain. Only one answer is admitted to the ACP session at a time; eight more can wait in the adapter command lane, and at most 32 receipts remain admitted globally until consumed. Duplicate receipt IDs are refused. WrittenUnacknowledged maps to Accepted, meaning pipe-write acceptance only. NotSent or a missing unclaimed local request maps to NotWaiting. Explicit UnknownPermission maps to NotWaiting; Closed, Busy and configuration/admission refusals map to Failed because the session never attempted those writes. UncertainDelivery, Delivery::Uncertain and an abandoned observer remain Uncertain; none are retried. A receipt dropped before entry is Failed. A blocked native write followed by close is tested as Uncertain, including a stale card refusing to reach a replacement process.

There are at most 16 workers and 16 unconsumed turn reservations. Normal output has a 256-event / 4 MiB serialized-byte limit; overflow seals admission and stops work. Reserved output is restricted to the admitted starts, terminal/exit pairs and answer receipts/closures. The underlying session separately enforces its frame, retained-state, permission and event budgets. These are bounded allocations and serialized sizes, not measured process RSS limits.

## Owner compatibility boundary

The actual Node daemon and desktop runtime clients cover text, Allow, Deny, Stop, startup failure, independent Chats, late text and queued sends. A queued successor is preserved and held after the first completed answer. The owner's existing handoff-restore gate refuses a second send because this fixture has no resumable native context. No fake native ID or fixture bypass is used. Full queued continuation and same-Chat reuse are therefore **not implemented**. A fresh Chat can run with its own process.

The ordinary executable scenarios do not assert exact prompt contents. The private successful-Restore unit fixture below verifies native prompt receipts. The Node-client test verifies saved user text and queue state; direct adapter tests verify native event and process boundaries. No live model turn, provider performance comparison or application UI screenshot comes from these tests.

## Validation

```sh
cargo test --manifest-path experiments/rust-runtime/Cargo.toml --features acp-fixture
cargo clippy --manifest-path experiments/rust-runtime/Cargo.toml --features acp-fixture --all-targets -- -D warnings
```

Seven ACP integration tests include the five-scenario actual Node-client suite. Existing Claude/Codex/runtime suites remain enabled in the same feature build. This checkpoint does not replace the shared Node runtime, provider bootstrap, account routing, host policy or native session continuity.

The private ACP worker now catches unwinds around its session future. Dropping that future requests session shutdown; the worker continues driving the private executor and retains its profile until transport supervisors exit. It then publishes exactly one failed terminal (or StartFailed if initialization never completed) and one Exited event, and seals further admission. A three-case injected-panic test covers before spawn, active streaming and after answer admission; the last case preserves one Uncertain answer receipt and does not replay it. The test checks every observed PID is reaped before the completion sequence is consumed. This catches unwinding panics in the worker future, not process aborts or allocation failures.

A real blocked-two-answers session regression uses two distinct native permissions. It waits until inspect reports writingPermission = permission and queuedPermissionWrites = [permission-2], proving both decisions were claimed and the second native write is still queued. Stop returns UncertainDelivery for the stalled first receipt and Closed for the unsent second; the runtime maps these to Uncertain and Failed respectively. Permission closures report Uncertain and NotSent once, followed by one cancelled terminal, and the stopped session refuses replay. This tests classification against actual native session receipts; the normal adapter still admits only one native answer at a time.

A completion guard now owns cleanup and terminal/Exited publication. It is created before the caught worker future and retains the worker, profile and executor through drain failures. A drain unwind latches cleanup_failed, retries with exponential backoff from 10 ms to 1 s, and publishes no completion until the executor reaches zero supervised tasks. The failure flag stays visible after eventual reaping; failure notifications are latched, not emitted on every retry. Shared output, answer, worker-count and PID mutexes recover from poison.

Panic tests now also cover a drain unwind and an unwind immediately before publication. A separate test poisons all four shared mutexes, then runs a permission turn through settlement and process reaping. This fixture deliberately uses a provider-wide failure latch: one Chat's panic closes further admission and other workers stop at their next event/watchdog. A production adapter would need per-Chat failure isolation. Rust's process-wide panic hook still prints panic diagnostics; all injected fixture payloads are static and contain no prompt or credential data. Process aborts and allocation failures remain outside unwind supervision.

## Test-only successful restore

The actor unit fixture now enables owner Restore explicitly and drives two sequential ACP processes through the real Node client. It verifies durable preparing/done ordering, off-actor transcript execution, no-model changed filenames from an explicitly admitted fresh repository in the same Isolation, exact message counts, idempotent retry, child reaping and joined shutdown. See JOBS-INTEGRATION-PLAN.md. The fixed prompt-receipts child hashes each parsed stdin request. A cfg(test)-only monitor captures at most sixteen observations, each capped at 80 KiB and taken with a one-second inspection deadline before shutdown. The test checks one receipt per process, host TurnId/PID binding, exact ordinary and framed prompt text, UTF-8 byte counts, SHA-256 text and full-frame digests, and no duplicate request. This proves child parsing, not provider execution or interpretation. No executable enables Restore or admits that repository.
