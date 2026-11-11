# milagre-providers (experiment)

Rust provider process adapters for the Milagre backend migration. First provider: Codex
(`codex app-server`), ported from `packages/core/src/agents/codex-rpc.cjs`,
`codex-provider.cjs` (process lifecycle only), `process-tree.cjs` (Unix group kill),
and the Codex helpers in `permissions.cjs` / `questions.cjs`.

Standalone crate (own `[workspace]`), no dependency on `experiments/rust-owner`. The owner is
expected to depend on it by path and drive it; this crate holds no Milagre state.

## Layers

| Module                         | Role                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `codex::rpc::CodexRpc`         | Process + JSON-RPC transport. `spawn(SpawnOptions)` returns the handle and an unbounded `ServerEvent` stream.                                                                                                      |
| `codex::protocol`              | Envelope classification (`classify`), frames, method names, `codex_policy`, `thread_config`, input blocks.                                                                                                         |
| `codex::approvals`             | Codex server request params to Milagre `permission-request` / `question-request` JSON and Milagre answers back to Codex replies.                                                                                   |
| `codex::client::CodexClient`   | `connect` (spawn, `initialize`, `initialized`), `account_status`, `list_models`, `read_config`, `thread_start`, `thread_resume` (unarchive fallback), `thread_read`, `turn_start`, `turn_steer`, `turn_interrupt`. |
| `codex::session::CodexSession` | One thread: login check, thread start/resume, `start_turn`, `steer`, `interrupt` (grace, then kill), `respond_to_permission`, `answer_question`, `close`. Emits `SessionEvent`s.                                   |

## Transport guarantees (tested in `tests/transport.rs`)

- Newline-delimited JSON; a final unterminated frame is read at EOF (as Node's readline does).
- Incoming frames over `Limits::max_frame_bytes` (64 MiB) stop the process with
  `ExitReason::ProtocolViolation`; outgoing ones fail with `RpcError::FrameTooLarge` unwritten.
- At most `max_pending_requests` (256) requests in flight; responses match by id in any order.
- Per-request timeout (30 s default, `None` waits until exit). A dropped request future forgets
  its id. Late answers surface as `Diagnostic::UnmatchedResponse`; ids are never reused and
  nothing is ever resent, including after a timeout, a cancel or an exit.
- Server requests are tracked until answered, withdrawn (`serverRequest/resolved`) or exit,
  and can be answered once (`RpcError::UnknownServerRequest` after that).
- stderr is drained on its own task into a 4000-byte tail, never parsed as protocol, and only
  used for the exit detail (same text rules as codex-rpc.cjs, including the ENOENT message).
- Exit, stdout EOF, a read error or a protocol violation produce exactly one final
  `ServerEvent::Exit`; every waiter fails with the detail; later calls get `NotRunning`.
  A process that closes stdout but keeps running is killed after `drain_grace`.
- The process leads its own group. `close()` closes stdin, SIGTERMs the group, SIGKILLs it after
  `kill_grace`, and also stops group members left after the leader exits. Dropping the last
  handle SIGKILLs the group.

## Integration sketch

```rust
use milagre_providers::codex::{client::ConnectOptions, session::{chat_thread, prompt_input, turn}, *};

let spawn = SpawnOptions::new(codex_path).cwd(&cwd).env(env_pairs);
let mut options = SessionOptions::new(ConnectOptions::new(spawn, app_version), cwd.clone());
options.resume_thread_id = saved_thread_id;
let policy = codex_policy(PermissionMode::Ask, &cwd, &workspace_roots, false, false);
let mut thread = chat_thread(Some(model.clone()), policy.clone());
thread.developer_instructions = Some(instructions);
let (session, mut events) = CodexSession::start(options, thread).await?;
session.start_turn(turn(prompt_input(&prompt, &image_paths), Some(model), policy)).await?;
while let Some(event) = events.recv().await {
    match event {
        SessionEvent::PermissionRequest(card) => { /* show card; later session.respond_to_permission(id, Decision::Allow) */ }
        SessionEvent::QuestionRequest(card) => { /* later session.answer_question(id, QuestionOutcome::Answered(..)) */ }
        SessionEvent::Notification(raw) => { /* map items/steps here (events.cjs is not ported) */ }
        SessionEvent::TurnEnded { end, .. } => { /* turn-completed / turn-failed / turn-cancelled */ }
        _ => {}
    }
}
```

## Not ported yet (owner or later work)

- `events.cjs` `mapCodexNotification`: items to Milagre steps, thinking, token usage, 401 to
  login notice, crash text. Notifications are forwarded raw instead.
- Subagent polling (`thread/turns/list`, `recoverCodexSubagents`).
- Babysit guard (`babysitDenial`, the `writes_remote` predicate is injected and the session passes
  `|_| false`), wake escalation, `WorkspaceAccess` auto-answers, permission-mode auto-allow
  (`PendingPermissions.setMode`).
- MCP extras / linked tools and the `requestThread` config retry ladder; advisor config.
- Image temp files, generated/tool image saving, `sessionInstructions`.
- Steer-or-start fallback when `turn/steer` is refused (returns the error to the caller).
- Windows: no Job object / tree kill (falls back to killing the child), no `.cmd` shim handling
  from `command.cjs`. Descendants that leave the process group are not tracked.

## Tests

```
cargo test                      # unit, conformance, transport (Rust fake), session (Rust + Node fakes)
MILAGRE_CODEX_LIVE=1 cargo test --test live_codex -- --ignored --nocapture   # installed codex: initialize + model/list only
NODE_PATH=<checkout>/node_modules node experiments/rust-providers/scripts/generate-conformance.cjs  # refresh fixtures from Node
```

The session tests also run against `packages/core/src/agents/fixtures/fake-app-server.cjs` (the
fake the Node provider tests use) when `node` is on PATH.
