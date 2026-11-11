# Fake ACP lifecycle proposal

This is an experimental local API, not an implementation of the owner's provider trait. The
`session` module exists only with the opt-in `fake-session` feature. `FakeSession::launch` accepts
fixed repository fake scenarios, resolves Node, and supplies only the scenario environment. It
cannot accept a vendor executable, profile, auth callback, MCP server or existing RPC handle.
The process starts lazily on the first accepted turn. No owner/runtime crate is changed.

## Admission and event ownership

- `send(text) -> Result<TurnId, SessionError>` admits one bounded text-only turn synchronously.
  It queues behind the active turn; it never steers. Rejection owns no turn and emits no terminal.
  Every accepted ID gets exactly one terminal, including queued turns discarded by Stop. This
  differs deliberately from Node's queued-send cancellation return without a terminal event.
- `SessionEvent::Agent { turn_id, event }` wraps the mapper/Node lifecycle event. Each turn keeps
  its original ID through startup, streaming, cleanup and failure. `Closed { last_turn }` is one
  process/session closure notification, not another turn terminal. There is no automatic restart.
- `cancel()` advances an epoch immediately. Work admitted before Stop is cancelled; a new turn
  admitted after Stop can run if the same process completed cancellation and remains usable.
  Cancellation during startup, timeout, stalled cleanup, process exit and consumer overflow close
  the session. `shutdown().await` also waits for process cleanup. Last-handle drop triggers shutdown.
- `Permission` carries the lossless wire ID, owning turn, original params and merged tool context.
  `answer(turn, id, AllowOnce | Deny | Cancelled)` cannot answer an old turn or a closed/claimed ID.
  AllowOnce never falls back to allow_always. Question UI/choice selection and persistent grants
  are not implemented. The fixture's first-choice question uses its first allow_once option only.

Before wiring, coordinate with owner10960 through the parent: replace/bind this local counter to
its logical `TurnId`, translate process closure without a duplicate terminal, choose bounded
admission/backpressure behavior and provide its `tick(now)`, `shutdown(force)` and
`forget(project, force)` semantics. The current fake actor owns a monotonic watchdog clock and a
5 ms timer. `mapper_now_ms` can fix presentation timestamps for deterministic fixtures; it never
controls watchdog deadlines. No owner trait or scheduler assumptions are encoded here.

## Permission delivery and cleanup

Only `session/request_permission` is owned. The transport rejects other methods with `-32601`
and emits a budgeted `UnsupportedRequest` diagnostic saying the refusal was queued. No host
filesystem or terminal capability is advertised. A single auxiliary write future serializes
answers and cancellation; no task is spawned per request. IDs stay claimed until completion.

`WrittenUnacknowledged` means the pipe write completed, not that the provider received or acted
on it. `Uncertain` covers an abandoned claimed answer, a failed/stalled write or process loss
while delivery may have started. Killing the process cannot retract a permission reply or prove
non-execution. Never replay an uncertain answer. `NotSent` is used only for an unclaimed request
that this session never attempted to answer. Dropping an answer future before the actor claims
it leaves the request pending; its request watchdog remains in force.

Turn completion cancels unanswered requests and removes their local records before the terminal.
It never starts a queued allow after observing the prompt's response. Completion/cancellation
racing an explicit in-flight answer stops the process with uncertain delivery. Permission closure
is emitted once; a subsequent answer is refused even if another turn later reuses that wire ID.

## Bounded work and state

| Resource                                       | Default                                                       |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Admitted active + queued turns                 | 8                                                             |
| Control queue                                  | 32 commands; turn payload reservations total 1 MiB            |
| Session output                                 | 1,024 events / 8 MiB retained-allocation charge               |
| Mapper + capability state                      | 2 MiB conservative charge, including map indexes              |
| Open calls / cached diff paths                 | 256 / 256; one update's content list is also capped           |
| Accumulated thinking                           | 256 KiB                                                       |
| Pending permissions                            | 16 / 1 MiB params and merged-context admission budget         |
| Session transport frame                        | 512 KiB, with the transport token/heap budgets still enforced |
| Initialize / create / resume / load            | 120 seconds each                                              |
| Absolute turn / idle progress / permission age | 30 minutes / 120 seconds / 10 minutes                         |
| Cancellation or final permission cleanup       | 3 seconds                                                     |

There is one actor task plus the transport's four tasks, at most one primary RPC future and one
auxiliary write/request future. Commands never wait for channel capacity; admission returns Busy.
Each update is checked before large thinking appends and against the retained-state bounds before
emitting mapped output. A bounded frame/working copy can temporarily exist beyond retained-state
charges. These are allocation budgets, not application RSS measurements or limits on caller-owned
copies from `inspect`/event consumption.

Thinking appends in place. Calls/diff paths have indexes while snapshots retain Node insertion
order. Pending diffs are grouped once per update; repeated paths no longer repeatedly clone the
whole diff list. Turn finalization clears calls, steps, diff cache and thinking. Retained index
capacity remains charged, and multi-turn tests check that it does not grow with completed turns.

On output overflow, admission seals and the process stops. Reserved delivery is limited to the
already-admitted turn terminals, pending permission closures and one Closed event. It cannot be
used for further streaming data. Watchdogs and control commands continue despite peer traffic.
Idle progress pauses for a displayed permission; permission age and the absolute turn deadline
continue. Irrelevant updates do not refresh progress.

## Ordering and parity boundary

`SpawnOptions::response_boundaries` is opt-in and defaults false for existing raw clients. The
transport queues a `ResponseBoundary { method }` before resolving a matched response. The session
has one primary request at a time, so this marker separates pre-response notifications from
replayed/late post-response frames without putting response bodies into the event queue. Server
errors respect the same boundary. Process-exit errors wait for the ordered Exit event so preceding
text is delivered first. Load history is suppressed through its response boundary.

Twelve fixtures execute the actual Node `AcpSession`, `PendingPermissions`, questions and mapper
implementations against the repository fake ACP agent. They compare lifecycle events in order,
raw permission requests and final mapper state: two-turn reuse, thinking, successful/failed tools,
permission/edit/question flow, plans, Kiro credits/partial tool context, load replay and Stop.
Node host instruction generation, vendor bootstrap, guards and MCP discovery are replaced with
explicit inert fixture dependencies. Native paths normalize to `/checkout`, turn IDs and the
mapper clock are deterministic, and a source-hash/result drift check runs in the Rust tests.
Permission cards are recorded for future work; the Rust raw-request API does not claim card UI
or policy parity. Instructions, images, model/effort selection and vendor mode switching remain
outside this checkpoint.

Wrong-session updates are dropped. Idle text is dropped and queued post-response text is drained
before another turn starts. **ACP has no universal turn ID:** a same-session untagged late update
that arrives after the next prompt starts remains indistinguishable from new work. Parent/child
routing and vendor metadata rules need owner-reviewed attribution before any runtime integration.
Do not reuse the currently active owner turn as a blanket attribution rule.

## Policy and remaining gates

Policy is immutable. Auto, Full, Babysit, Advisor, Escalation and AnalysisOnly all fail before
spawn; only the fake Ask flow is available. There is no command/workspace policy, linked-tool
manifest, MCP dispatch guard, persistent approval store or execution isolation. No mode fallback
or MCP retry can bypass these refusals because neither is exposed by this session layer.
Resume falls back to load only when capabilities require it or the server explicitly returns
method-not-found/session-not-found. Transport errors never trigger fallback or replay. Login and
subscription errors terminate without authentication. Saved IDs are not silently reset.

Provider `_meta`, source labels and Routine/heartbeat references are untrusted presentation data.
The owner must validate associations against its authoritative tool manifest and records before
persisting/routing them. They never authorize commands, files, linked tools or wake scope.
Vendor account/bootstrap/private profiles, detached descendants/Windows Jobs, instructions/images,
subagent routing, restart/resume ownership and the provider trait integration remain blocked.
