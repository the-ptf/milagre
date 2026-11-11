# milagre-providers (experiment)

Rust provider process adapters for the Milagre backend migration. First provider: Codex
(`codex app-server`), ported from `packages/core/src/agents/`: `codex-rpc.cjs`,
`codex-provider.cjs` (without host I/O), `events.cjs` (`mapCodexNotification` and the Codex
messages), the Codex halves of `steps.cjs` and `subagents.cjs`, `process-tree.cjs` (Unix group
kill), the Codex helpers and `PendingPermissions` / `PendingQuestions` semantics of
`permissions.cjs` / `questions.cjs`, plus `toolMetadata`, `capOutput` and `addProgress` from
`packages/shared`.

Standalone crate (own `[workspace]`), no dependency on `experiments/rust-owner`. The owner is
expected to depend on it by path and drive it; this crate holds no Milagre storage.

## Layers

| Module                         | Role                                                                                                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex::rpc::CodexRpc`         | Process + JSON-RPC transport. `spawn(SpawnOptions)` returns the handle and a budgeted `EventReceiver<ServerEvent>`.                                                                                                                                                    |
| `codex::protocol`              | Envelope classification (`classify`), frames, method names, `codex_policy`, `thread_config`, input blocks.                                                                                                                                                             |
| `codex::approvals`             | Codex server request params to Milagre permission / question cards, and Milagre answers back to Codex replies.                                                                                                                                                         |
| `codex::events`                | `map_codex_notification(method, params, &mut CodexEventState) -> Vec<Value>`: Milagre `AgentEvent` JSON. Also `crash_message`, `login_message`, `missing_cli_message`, `codex_error_text`, `failed_with`, `is_terminal`, `RESUME_FAILED_MESSAGE`.                      |
| `codex::steps`                 | `codex_step`, `codex_step_result`, `thinking_step` / `thinking_end`, `tool_metadata`, `cap_output`.                                                                                                                                                                    |
| `codex::subagents`             | `codex_subagents`, `update`, `settle_subagents`, `add_progress`, `codex_plan_tasks`.                                                                                                                                                                                   |
| `codex::client::CodexClient`   | `connect` (spawn, `initialize`, `initialized`), `account_status`, `list_models`, `read_config`, `thread_start`, `thread_resume` (unarchive fallback), `thread_read`, `thread_turns_list`, `turn_start`, `turn_steer`, `turn_interrupt`.                                |
| `codex::session::CodexSession` | One thread: login check, thread start/resume, `send` (start or steer, steer-refused fallback), `interrupt` (grace, then kill), `respond_to_permission`, `answer_question`, `set_permission_mode`, `close`, subagent polling. `recover_codex_subagents` for idle Chats. |
| `queue`                        | The non-blocking, budgeted event queue both streams use.                                                                                                                                                                                                               |

## Session events

`SessionEvent::Agent(Value)` carries every Milagre event in the wire shape Node emits:
`session-started`, `turn-started`, `text-delta`, `step-started` / `step-output` / `step-completed`,
`context-usage`, `context-compacting` / `context-compacted`, `tasks-updated`, `subagent-update`,
`subagents-waiting`, `background-tasks`, `permission-request` / `permission-resolved`,
`question-request` / `question-resolved`. The one terminal event of each turn
(`turn-completed`, `turn-failed` with `notice` / `login` / `limit`, `turn-cancelled`) comes as
`SessionEvent::TurnEnded { turn_id, end, event }`. `SessionEvent::Notification` (raw frames) only
with `SessionOptions::forward_raw_notifications`. `SessionEvent::Exited` is always last.

## Guarantees (tested)

- Newline-delimited JSON; a final unterminated frame is read at EOF (as Node's readline does).
- Incoming frames over `Limits::max_frame_bytes` (64 MiB) stop the process with
  `ExitReason::ProtocolViolation`; outgoing ones fail with `RpcError::FrameTooLarge` unwritten.
- At most `max_pending_requests` (256) requests in flight; responses match by id in any order.
  More than `max_open_server_requests` (1024) unanswered server requests stop Codex.
- Event queues never block the reader (so awaiting a request while events pile up can't
  deadlock), and are budgeted (`QueueLimits`: 100k events / 256 MiB for transport events; the
  session's own queue likewise). Past the budget Codex is stopped (`ExitReason::ConsumerStalled`
  or a crash message naming the stall); the turn's end and the exit still get through.
- One writer task owns stdin: a frame is written whole or not at all. A request cancelled or timed
  out before its first byte is never written; one already being written finishes intact. A Codex
  that stops reading for `write_timeout` (10 s) is stopped (`ExitReason::InputStalled`), so no
  write, untimed `thread/start` included, waits forever, and `close()` never waits on the pipe.
- Per-request timeout (30 s default, `None` waits until exit). A dropped request future forgets
  its id. Late answers surface as `Diagnostic::UnmatchedResponse`; ids are never reused and
  nothing is ever resent.
- Server requests are answered once; withdrawn ones resolve as `cancelled`; everything open is
  cancelled when a turn ends (queued, never awaited). A user's answer that could not be written
  returns an error from `respond_to_permission` / `answer_question` and, if Codex still waits,
  the card stays open. Card ids are `String(id)` as in Node, made unique (`5#2`) if Codex sends
  both `5` and `"5"`.
- Cancel safety: dropping every `CodexSession` (or a `start` future mid-way, e.g. during an
  untimed `thread/start`) kills the process tree. A `send` / `start_turn` whose caller stops
  waiting still ends its turn: Milagre interrupts it, or kills Codex after the grace when the
  turn never got an id.
- After a `turn/start` timeout the abandoned turn may still run: while the next `turn/start` is in
  flight, that thread's turn-scoped notifications are held and replayed once the new turn's id is
  known, so a late `turn/completed` or text of the old turn can't end or leak into the new one.
- On `Exited` the session also closes what is left of the process group (shells, MCP servers).
- `SpawnOptions` (and the options that hold it) never print the environment in `Debug`.
- stderr is drained into a 4000-byte tail, never parsed as protocol, only used for exit text.
- Exactly one `ServerEvent::Exit`; every waiter fails with its detail; later calls `NotRunning`.
  A process that closes stdout but keeps running is killed after `drain_grace`.
- The process leads its own group. `close()` SIGTERMs, then SIGKILLs after `kill_grace`, including
  members left after the leader exits. Dropping the last handle SIGKILLs the group.

## Conformance with Node

- `tests/fixtures/conformance/codex-event-traces.json`: `scripts/record-codex-traces.cjs` preloads
  into `events.test.cjs`, `subagents.test.cjs`, `codex-provider.test.cjs`,
  `chat-subagent-recovery.test.cjs` and `scripts/codex-event-scenarios.cjs`, and records state,
  clock reads and events for every `mapCodexNotification` / `settleSubagents` call. The Rust
  mapper replays all 579 cases with identical events and state (`tests/event_traces.rs`).
- `tests/fixtures/conformance/codex-contract.json` (`scripts/generate-conformance.cjs`): approval and
  question translation, policies, frame classification.
- `tests/session.rs` drives `CodexSession` against the Rust fake and the repository's Node fake
  (`packages/core/src/agents/fixtures/fake-app-server.cjs`).

## Integration sketch

```rust
use milagre_providers::codex::{client::ConnectOptions, session::{chat_thread, prompt_input, turn}, *};

let spawn = SpawnOptions::new(codex_path).cwd(&cwd).env(env_pairs);
let mut options = SessionOptions::new(ConnectOptions::new(spawn, app_version), cwd.clone());
options.resume_thread_id = saved_thread_id;
options.workspace_roots = workspace_roots.clone();
let policy = codex_policy(PermissionMode::Ask, &cwd, &workspace_roots, false, false);
let mut thread = chat_thread(Some(model.clone()), policy.clone());
thread.developer_instructions = Some(instructions);
let (session, mut events) = CodexSession::start(options, thread).await?; // LoginRequired -> events::login_message()
let mut message = turn(prompt_input(&prompt, &image_paths), Some(model), policy);
message.permission_mode = Some(PermissionMode::Ask);
session.send(message).await?;
while let Some(event) = events.recv().await {
    match event {
        SessionEvent::Agent(event) => publish(event), // permission-request -> later session.respond_to_permission(id, Decision::Allow)
        SessionEvent::TurnEnded { event, .. } => publish(event),
        SessionEvent::Exited(_) => break,
        SessionEvent::Notification(_) => {}
    }
}
```

## Guarded sessions

[POLICY-CONTRACT.md](POLICY-CONTRACT.md) defines immutable session roles, the required owner
`CommandClassifier`, constrained linked-tool manifests and disabled-server-preserving MCP
fallback. Analysis, Babysit and Escalation cannot be lifted by Full mode or steering. Execution
advisors and arbitrary extra parameters return `UnsupportedPolicy`. This is an adapter contract;
host MCP dispatch must enforce the same constraints independently.

See [IMAGE-CONTRACT.md](IMAGE-CONTRACT.md) for opt-in output storage, private input preparation,
inline ordering, cleanup, budgets and the Claude-compatible `ToolImageStore` boundary.

## Not ported yet (owner or later work)

See [the owner integration inventory](INTEGRATION-GAPS.md) for policy, MCP and image contracts,
proposed boundaries and acceptance checks.

- Host media-store wiring, output retention/serving and unavailable-media UI; `sessionInstructions` text.
- The production babysit shell classifier, host MCP guard service, mutable per-turn role changes,
  `WorkspaceAccess.answer` auto-answers and read-only/dynamically acquired roots.
  Auto allows an edit without a card only when `workspace::inside_workspace` (a port of Node's
  `insideWorkspace`: canonical roots, nearest existing ancestor for new files, root itself
  excluded, errors fail closed) puts every file inside cwd / `workspace_roots`; the same check
  runs again when the mode switches to Auto. Unlike Node it is also used for a lone cwd (Node's
  `insideRoot` is lexical there). Cwd and roots are canonicalized as supplied, without lexical
  folding, so a `link/..` in either resolves to the actual kernel directory; missing cwd fails
  closed. `/tmp` aliases still resolve normally. On Windows, cwd/roots containing `..` also fail
  closed to avoid lexical folding when joining canonical verbatim paths. Deliberate security
  differences from Node: dangling symlinks,
  any requested `..` component (including an otherwise safe parent traversal), and missing,
  non-string, empty/whitespace-only or NUL-containing paths require a card. Display coercions
  such as a missing path rendered as `"undefined"` never authorize a write; a real string filename
  `"undefined"` is still a valid path. Mode is rechecked under the pending-card insertion lock
  after the asynchronous filesystem check, so a concurrent switch cannot use the old mode.
  This is a point-in-time path check, not a filesystem sandbox: a symlink swapped between the
  check and Codex's write can still redirect it. The owner must not treat Auto as isolation.
- MCP extras discovery and linked endpoint ownership. Adapter config fallback and constrained
  inherited-config discovery are implemented; execution advisors are explicitly unsupported.
- `canStart` (a turn cancelled before `turn/start`), `executionAdvisor` feature overrides.
- Windows: no Job object / tree kill (falls back to killing the child), no `.cmd` shim handling
  from `command.cjs`. Descendants that leave the process group are not tracked.
- JSON number formatting follows JavaScript for integers and plain decimals only (e.g. `1e21`
  differs); UTF-16 slicing drops a surrogate pair instead of keeping half of it.

## Tests

Policy fixtures: `node experiments/rust-providers/scripts/record-guard-fixtures.cjs` records
189 Node cases without spawning a provider. `tests/guards.rs` replays them and tests enforcement.

```
cargo test                      # unit, conformance, event traces, transport, session (Rust + Node fakes)
MILAGRE_CODEX_LIVE=1 cargo test --test live_codex -- --ignored --nocapture   # installed codex: initialize + model/list only
NODE_PATH=<checkout>/node_modules node experiments/rust-providers/scripts/record-codex-traces.cjs   # refresh event traces
NODE_PATH=<checkout>/node_modules node experiments/rust-providers/scripts/generate-conformance.cjs  # refresh contract fixtures
npx oxfmt experiments/rust-providers/tests/fixtures   # after regenerating
```
