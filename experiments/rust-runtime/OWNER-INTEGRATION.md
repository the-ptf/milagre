# Next owner integration boundary (proposal, not implemented)

The runtime still exposes saved-file reads, isolated content operations, PTYs, ports and Git fixture reads. `OwnedCopies` owns one `Mutex<ProjectStates>` and advances its clock only when a read arrives. It does not run ChatHost, providers, or periodic saves/sweeps. The following is the proposed next boundary, not evidence of a working owner.

## One state owner and one publication order

Replace the `OwnedCopies` state container with a single owner actor that owns `ChatHost`, and therefore its `ProjectStates`. Do not keep a second `ProjectStates` beside ChatHost: that would duplicate in-memory state and contend for Project locks. Read requests, domain commands, provider completions, timers and shutdown all enter this actor through a bounded queue.

The existing `EventSink::transaction` lock must precede any owner mutation visible in snapshots. Hold that publication boundary while applying a completed domain transition, draining notices and state events, and publishing the matching wire events. Snapshot reads use the same order. This prevents an event watermark from advancing past a change absent from its snapshot. Provider I/O must run outside both this boundary and the owner state lock.

`ProjectStates::advance(now)` currently returns no error. Drain `take_events()` after advancing and after ordinary operations, including failures. Translate persistence changes and lazy-unload changes using the existing Node runtime event contract. A save failure is a state transition to report, not a reason to silently stop the clock or forget the dirty state. Do not advertise state-patch capability until its versions and snapshot watermarks are verified with the actual Node runtime client.

## Clock and shutdown

Use epoch milliseconds captured once plus monotonic elapsed time, so a wall-clock correction cannot move the scheduler backwards. A wakeable bounded timer sends ticks to the owner actor even without connected clients. Coalesce overdue tick messages; `ProjectStates::advance` already executes each due action in order. A clock abstraction and configurable intervals should make tests deterministic rather than sleeping for the production 60-second sweep.

The timer must hold a weak actor reference and stop when the actor stops. Shutdown first closes admission and drains accepted wire requests, as the wire server already does. Then stop the timer, stop/drain provider sessions, fold their terminal events, flush/close states, release content and terminal resources, and acknowledge `daemon:stop`. The exact provider/state/resource ordering must preserve persisted terminal events before ownership is released.

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
