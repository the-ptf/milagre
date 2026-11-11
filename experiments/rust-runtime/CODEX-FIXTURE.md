# Isolated Codex owner bridge

`codex_fixture::CodexFixture` implements the owner's nonblocking `Provider` contract using
`milagre-providers::codex::CodexSession`. Its sole constructor creates a fresh private fixture
profile and runs the repository's `fake-app-server.cjs` with Node. It accepts no executable,
external Project/profile path, environment, credentials, role or MCP endpoint. No runtime
executable or installed desktop app registers this provider. This is integration evidence,
not a migrated production provider.

## Ownership and lifecycle

One async session task and its current-thread Tokio executor run on a dedicated thread per
Chat, with at most 16 live workers. Provider methods submit synchronously and never wait for
process I/O, initialization, turn start, interrupt or close. A session has one bounded start
slot; overlapping starts are refused, matching the current ChatHost steering gate. The owner
can durably queue a subsequent message and start it after the preceding terminal event.

Each worker fixes the host TurnId before submitting a native turn. Agent events and the single
terminal event retain that identity; exit carries the last admitted generation. Close signals
the captured session's watch sender and removes that slot immediately. A replacement session
gets new senders, so a delayed close cannot target it. A stale interrupt is ignored. Initial
resume is explicit; a reused session refuses a different native resume id until closed.

The bridge emits `Started`, then `message-sent`, then the native session's mapped events.
Native turn ids filter terminal events; duplicate ends are ignored. Startup failure emits
`StartFailed` and `Exited`; a stopped running session receives one final failure and one exit.
Early cancellation drops the library's cancel-safe startup future. Started sessions explicitly
await `close` and process reaping on their worker. Drop only signals workers; the owner actor
never joins them. `FixtureMonitor::wait_stopped` is a blocking test helper, not an actor API.
The profile remains alive through every worker and retained monitor.

## Bounds and refusal behavior

Start requests are limited to 1 MiB. The shared event queue admits 256 events / 4 MiB plus a
48-event turn/exit reserve and 32 reserved answer settlements. Overflow permanently closes admission, ends the affected session
and retains its terminal/exit events. Existing idle sessions are stopped by owner shutdown;
there is no automatic restart or replay. The underlying Codex transport and session retain
their own framing and queue budgets. These are serialized-size bounds, not exact heap limits.

The fixture accepts ordinary Ask mode, text prompts, model/effort and resume settings. Images,
reply/instruction assembly, enabled fast/TLDR/ultracode modes, roles, arbitrary configuration,
MCP and unknown fields are refused before spawn. Async permission and question answers enter a
separate eight-slot per-session lane, with at most eight in-flight tasks per session and 32
unconsumed settlements globally. Each admitted AnswerId settles exactly once as Accepted,
NotWaiting or Failed. Accepted means Codex confirmed writing the response. Close cancels and
settles queued/in-flight answers; stale session generations are refused. The owner actor keeps
its RPC reply pending until Notice::AnswerSettled and publication succeeds, with at most 32
pending replies. It never reports admission as success. Timeouts are supplied by the owner. Native Unicode is converted to the owner's escaped string codec;
real private-use/noncharacter text is preserved. Lone UTF-16 units are explicitly refused
before spawn because the provider transport currently uses serde_json's Unicode strings.

Step, plan, subagent and other mapped events are forwarded unchanged. The owner now folds these event types, but this integration suite has not verified every event
through the production UI. Provider policy/instruction/account assembly, live images/tools,
steering and complete end-to-end validation remain required before production integration.
This checkpoint makes no real-provider compatibility claim.

## Evidence

`cargo test --manifest-path experiments/rust-runtime/Cargo.toml --test codex_bridge`
executes the actual repository Node fake, with an environment containing only private HOME,
CODEX_HOME, the fixture scenario and LANG. Thirteen tests cover:

- Explicit resume, ordered text, sequential host generations and exactly one terminal event.
- Slow/stubborn interrupt, cancelled initialize/thread start, crash and failed resume. Tests
  identify children by their private fixture cwd and verify process death, not just worker exit.
- Immediate close followed by a replacement session, stale interrupt and old-generation exit.
- Unsupported policy/image/instruction configurations, confirmed approval/question answers, session and
  event-queue limits, terminal reserve, Unicode marker decoding and lone-unit refusal.
- Actual ChatHost integration: durable first send, durable queued send, mapped replies and
  graceful idle shutdown. Question tickets wait for native settlement and unknown requests
  preserve saved state. The native fake creates no real model turn and consumes no credentials.

The production Node client actor suite separately verifies delayed `true`, `false`, rejected
and timed-out answer RPCs, and a concurrent snapshot while an answer waits. Its scripted
provider delays answers by 80 ms; the fixture owner uses a 250 ms answer deadline. These are
explicit fixture timings, not production defaults.
