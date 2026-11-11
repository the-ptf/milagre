# Owner actor integration boundary

The runtime still exposes saved-file reads, isolated content operations, PTYs, ports and Git fixture reads. `OwnedCopies` owns one `Mutex<ProjectStates>` and advances its clock only when a read arrives. It does not run ChatHost, providers, or periodic saves/sweeps. The separate `actor-runtime` now exercises the actor/timer/publication/shutdown-retry boundary on a synthetic Project and scripted provider only. The read/PTY/Git executables retain their existing behavior. Production integration below remains incomplete.

## One state owner and one publication order

Replace the `OwnedCopies` state container with a single owner actor that owns `ChatHost`, and therefore its `ProjectStates`. Do not keep a second `ProjectStates` beside ChatHost: that would duplicate in-memory state and contend for Project locks. Read requests, domain commands, provider completions, timers and shutdown all enter this actor through a bounded queue.

The existing `EventSink::transaction` lock must precede any owner mutation visible in snapshots. Hold that publication boundary while applying a completed domain transition, draining notices and state events, and publishing the matching wire events. Snapshot reads use the same order. This prevents an event watermark from advancing past a change absent from its snapshot. Provider I/O must run outside both this boundary and the owner state lock.

`ProjectStates::advance(now)` currently returns no error. Drain `take_events()` after advancing and after ordinary operations, including failures. Translate persistence changes and lazy-unload changes using the existing Node runtime event contract. A save failure is a state transition to report, not a reason to silently stop the clock or forget the dirty state. Do not advertise state-patch capability until its versions and snapshot watermarks are verified with the actual Node runtime client.

## Clock and shutdown

Use epoch milliseconds captured once plus monotonic elapsed time, so a wall-clock correction cannot move the scheduler backwards. A wakeable bounded timer sends ticks to the owner actor even without connected clients. Coalesce overdue tick messages; `ProjectStates::advance` already executes each due action in order. A clock abstraction and configurable intervals should make tests deterministic rather than sleeping for the production 60-second sweep.

The timer must hold a weak actor reference and stop when the actor stops. Shutdown first closes admission and drains accepted wire requests, as the wire server already does. Keep lifecycle pumping while sessions stop, fold their terminal events, flush/close states, then stop the timer, release content and terminal resources, and acknowledge `daemon:stop`. The exact provider/state/resource ordering must preserve persisted terminal events before ownership is released.

A failed flush retains state and ownership, keeps admission closed, and returns the failure. An explicit repeated stop may retry flushing. The current wire server permits another stop while closing; ordinary requests stay refused. Do not restore mutation admission automatically, drop the owner after a failure, or make shutdown success depend on a client remaining connected. Production profile handoff is a separate future operation requiring explicit authorization.

## Provider contract before wiring

Owner safety checkpoint `d3e001ba` now provides a `Send` nonblocking `Provider`, host-assigned `TurnId`, `Started`/`StartFailed`/`Agent`/`Exited` events, explicit interrupt/permission/question/close/shutdown methods, canonical Project identities and stale-turn checks. The actor should use that API. It must still enforce:

1. A bounded, nonblocking submission API. Acceptance records a `starting` run immediately; provider start, steering and interrupt complete asynchronously.
2. Explicit session create, close, exit/crash and cancellation outcomes. Dropping or cancelling a submitted start must settle its run and queue exactly once.
3. Session and turn identities on every event. Stale terminal events must never end a newer turn after Send now or restart.
4. Owner-only mutation of Project state. Provider tasks send events, never take Project locks or write saved state.
5. A defined overload policy and terminal-event reserve. Permission answers and final turn outcomes cannot be discarded under backpressure.

Provider adapters must obey the new immediate-return contract and its session/turn identities. Current owner feature gates and provider policy gaps must be resolved before a live provider is connected. The runtime must not patch the owner trait independently.

## Acceptance evidence for that next checkpoint

Use fresh marked copies and scripted provider processes only. Prove a debounced save and idle unload occur without a subsequent read; publish and snapshot preserve sequence order; save failures remain dirty/owned and can be retried; a blocked provider start leaves other Chats and Stop responsive; stale completion cannot close the next turn; disconnect/reconnect preserves an active turn; timer/drop/shutdown release only the test process's resources; failed shutdown retains locks until a successful retry. Compare state, disk and wire events against the existing Node implementation. Real credentials, production sockets and live provider turns are outside this fixture checkpoint.

## Scripted checkpoint implementation

`src/actor.rs` uses one owner thread, a 64-request / 8 MiB queue and coalesced monotonic ticks. Snapshot handling reads a cache updated inside the publication transaction; it never queues work to an actor that might be waiting on the same publication lock. This avoids the lock inversion a synchronous snapshot request would create. Domain callbacks return at once; the synthetic provider delivers its bounded scheduled events on subsequent ticks.

The fixture has no external provider/session processes. It cancels its synthetic turns before close, records failures without releasing retained owner state, and permits repeated stop while closed to normal commands. It does not implement production suspend/resume or a nonresponsive provider's force-close deadline. Owner checkpoint `37264274` fixes session-generation, idle terminal-event, lost interrupt-end and forgotten-Project gaps. The actor now uses required `TurnId` on every event, calls `ChatHost::tick`, and tests those paths with a scripted provider. No real provider adapter is connected.

The Node client suite and four admission/provider-budget/publication unit tests are the evidence for this checkpoint. Actual Node timer/event equivalence remains covered at the owner library trace boundary; this new integration suite exercises the actual production wire clients against scripted provider events, not a live model or a complete Node runtime oracle.

The actor now retains unsent wire events on publication failure, closes admission, and refuses cached snapshots until restart. Durable stop remains available. A failed stop keeps pumping provider lifecycle events so delayed cancellation can complete. `state:read` gets its revision after cache publication. Forced destruction after a failed stop is explicitly crash-equivalent, not a successful durable shutdown.

Executable teardown uses `Server::finish` to wait for EOF/request references and actual temporary-profile destruction. A successful stop acknowledgment alone cannot guarantee background-thread destructors run before a Rust executable returns from `main`. `finish` does not remove arbitrary paths and returns a timeout if its retained fixture handles do not drain.

## Codex process bridge fixture

`codex_fixture::CodexFixture` now implements this nonblocking provider boundary for the
repository's Node fake app-server only. Sixteen integration tests cover process lifecycle,
generations, bounded admission/events and a real ChatHost durable queue. No executable wires
it by default. See [CODEX-FIXTURE.md](CODEX-FIXTURE.md) for the exact constructor restrictions,
confirmed async answer settlement, unsupported owner behavior and validation scope.

The actor handles `agent:respond-permission` and `agent:answer-question` through the owner's
AnswerTicket contract. Pending replies stay in a bounded map until the matching settlement
notice and publication complete. Timeout, provider refusal, session closure or publication
failure reject/resolve those replies without claiming acceptance early. The Codex fixture
uses a separate bounded answer lane and carries TurnId on close and every answer admission.

The uncertainty contract now distinguishes proven non-delivery from possible delivery. The
actor returns `ANSWER_DELIVERY_UNKNOWN` on an uncertain settlement, ignores late AnswerResolved
for RPC purposes, and configures a combined 32-slot pending/uncertain capacity. Owner messages
stay recorded across timeout or session closure. RawJson events/results are normalized only
inside ChatHost, so adapters never double-escape native Unicode markers.

Outbound fixture requests decode the owner codec before reaching Codex. Only text prompt/answer
copies replace lone UTF-16 units with U+FFFD; their saved originals remain lossless. Opaque
identities stay strict. A bounded Node-fake receive probe verifies actual provider payloads and
an owner reopen verifies the original disk records.

Answer-history eviction increments a saturating constant-space counter exposed as `daemon:snapshot.diagnostics.answerHistoryForgotten`. It emits neither stderr lines nor another answer RPC result. The actor retains no per-eviction Chat or answer strings; the count means delivery remained unknown when late-reconciliation history was discarded.
