# milagre-claude (experiment)

Rust transport, event mapper and session state machine for the Claude Code CLI's stream-json control protocol, for Milagre's Rust backend
migration. It talks to the user's installed native CLI (`~/.local/share/claude/versions/2.1.322`)
directly. There is no Milagre-owned Node process: no `@anthropic-ai/claude-agent-sdk` sidecar, no
JavaScript at runtime. The CLI is the external provider runtime, separate from Milagre's host.

Standalone crate (own `[workspace]`). It depends on neither `experiments/rust-owner` nor
`experiments/rust-providers`, holds no persisted Milagre state, and is not wired into any live owner.

See [TRANSPORT-REVIEW.md](TRANSPORT-REVIEW.md) for the independent close, broken-stdin and initialize-buffer fixes.

## Protocol sources

Implemented from the documented protocol, not from the TS SDK's minified (licensed) code:

| Source                                                                                            | Revision                                                                                                                                                       | Used for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [anthropics/claude-agent-sdk-python](https://github.com/anthropics/claude-agent-sdk-python) (MIT) | [`3cf3446b0fa6c97042e85b245bba07459f22f946`](https://github.com/anthropics/claude-agent-sdk-python/tree/3cf3446b0fa6c97042e85b245bba07459f22f946) (2026-11-10) | `_internal/transport/subprocess_cli.py`: `_build_command` (argv), `connect` (env: `CLAUDECODE` removed, `CLAUDE_CODE_ENTRYPOINT`), `_LineFramer` / `_parse_stdout_line` (framing, non-JSON lines skipped, corrupt JSON fatal, EOF tail), `close` (stdin EOF, grace, SIGTERM, SIGKILL). `_internal/query.py`: `initialize` (hook callback ids), `_read_messages` (routing of `control_response` / `control_request` / `control_cancel_request`), `_handle_control_request` (`can_use_tool`, `hook_callback`, `mcp_message` replies and error texts), `_send_control_request` (`req_<n>_<hex>` ids, timeouts). `types.py:2317`: a canUseTool host passes `--permission-prompt-tool stdio`. |
| `@anthropic-ai/claude-agent-sdk` public type declarations                                         | 0.3.288 (`sdk.d.ts`, the version Milagre installs)                                                                                                             | `SDKControlRequest`, `SDKControlResponse` (`ControlResponse` / `ControlErrorResponse`, envelope-level `pending_permission_requests`), `SDKControlCancelRequest` (either side may withdraw its own request; no reply), `SDKControlPermissionRequest`, `SDKHookCallbackRequest`, `SDKControlMcpMessageRequest`, `SDKControlInitializeRequest/Response`, `SDKControlInterruptRequest/Response`, `SDKControlRequestUserDialogRequest` (never answer an undeclared kind), `PermissionResult`, `PermissionUpdate`, `CanUseTool` options (`requestId` is the control request id), `keep_alive`.                                                                                                 |
| `claude --help`                                                                                   | 2.1.322                                                                                                                                                        | Flag names and choices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Live probe (below)                                                                                | CLI 2.1.322                                                                                                                                                    | `initialize` reply shape, local control requests, mode names.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

The CLI is not a text-only interface here: every capability Milagre uses from the SDK (permissions,
AskUserQuestion, hooks, in-process MCP, interrupt, model/mode/flag changes) is a control message on
this protocol, and the transport exposes each one.

## Layers

| Module     | Role                                                                                                                                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frame`    | `LineReader`: newline framing bounded while a frame grows (`max_frame_bytes`), EOF tail, `parse_line` classification, `encode` with an outgoing limit.                                                                                                                                                          |
| `protocol` | `classify` into `Response` / `Request` / `Cancel` / `KeepAlive` / `Message` / `Malformed`; envelope builders; typed views (`PermissionRequest`, `HookCallback`, `McpMessage`) that keep the whole raw request; `PermissionResult`; `user_message`.                                                              |
| `launch`   | `LaunchOptions` -> argv + env, `InitializeOptions` -> `initialize` request (hooks, `sdkMcpServers`, agents, promptSuggestions, forwardSubagentText, ...).                                                                                                                                                       |
| `handlers` | Owner interfaces: `PermissionHandler`, `QuestionHandler` (AskUserQuestion), `HookHandler`, `McpHandler`, `OtherRequestHandler`, each with a `CancelSignal`.                                                                                                                                                     |
| `client`   | `ClaudeClient`: process, reader, writer, supervisor; request correlation; dispatch; cleanup.                                                                                                                                                                                                                    |
| `process`  | Process-group signals, stderr tail.                                                                                                                                                                                                                                                                             |
| `milagre`  | Ports of Milagre's current Claude shapes: `claudeRequest` (`permission_card`), `claudeResult` (`permission_result`), `claudeQuestionRequest` (`question_card`), `claudeQuestionResult` (`question_result`), `PendingQuestions.answer` (`settle_answers`), `CLAUDE_MODES` / `nativeMode`, `userMessage` content. |

## Session API

`ClaudeSession` owns one process and its turn lifecycle. The transport API below remains available
for lower-level integrations.

```rust
use milagre_claude::{ClaudeSession, SessionOptions, TurnRequest, LaunchOptions};
use serde_json::json;

let mut launch = LaunchOptions::new(claude_path);
launch.cwd = Some(worktree);
// The owner supplies environment/account routing, prompt, MCP definitions and allowed tools.
let mut options = SessionOptions::new(launch);
options.resume_id = saved_session_id;
let (session, mut events) = ClaudeSession::new(options);
let reader = tokio::spawn(async move {
    while let Some(event) = events.recv().await {
        // Forward AgentEvent JSON to the owner's existing event reducer.
    }
});
let started = session.start_turn(TurnRequest {
    content: vec![json!({"type":"text", "text":"Hello"})],
    model: "sonnet".into(), permission_mode: Some("ask".into()),
    ..Default::default()
}).await?;
// Starting while active steers; starting while cancellation is pending waits for the turn to end.
// TurnRequest also carries effort, ultracode, fast_mode, replies and an optional can_start check.
session.respond_to_permission(request_id, "allow"); // also allow-for-chat / deny
session.answer_question(question_id, Some(&answers)); // ids -> arrays of strings; None dismisses
session.set_permission_mode("auto").await;
session.interrupt().await;
session.close().await;
reader.await?;
```

- Events are in session order. A turn gets at most one terminal event; preparation can fail before
  `turn-started`, and `can_start == false` produces no turn events. Invisible notification-only
  implicit turns stay invisible. Prompt suggestions belong only to completed, unsteered turns.
- Starts, steering and public mode changes serialize. Close and interrupt remain independent so they
  can stop initialization or a blocked control request. Dropping an initial start closes its process.
  A steer first checks eligibility and frame size, then commits one session-owned delivery task;
  dropping its receipt cannot abandon that accepted message. A caller cancelled while waiting for
  admission has made no change. Dropping `close()` cannot abandon its process cleanup.
- Permission and question callbacks release the session before waiting. Withdrawal/turn end settles
  pending cards once; private card tokens prevent an old cancellation from resolving a reused id.
  Questions still appear in Full; steering dismisses them. Access/guard decisions are injected via
  `AccessPolicy` and `PreToolUseGuard`, not read from live Milagre state.
- Every session event producer shares a count and estimated-byte budget. A reserved terminal slot
  reports overflow and seals the queue; an independent watcher stops the CLI without a consumer.
  Dropping `SessionEvents` also stops the process and rejects later starts. Mapped batches,
  subagent snapshots and tracked children have limits. See the queue safety contract below.
- Intentional differences from Node: failed initialization closes the half-initialized session;
  steering reports failed sends, rechecks ownership after a mode change, and never acknowledges a
  rejected oversize frame; the first implicit text belongs to its new turn. Node's current
  `readMessages` maps that text before allocating the new id. The original Node trace remains in the
  fixture with this one correction explicitly marked in the Rust comparison.

## Transport API

```rust
use milagre_claude::{milagre, *};

let mut launch = LaunchOptions::new(claude_path).sdk_mcp_server("milagre");
launch.cwd = Some(worktree.clone());
launch.env_overrides = vec![("CLAUDE_CODE_ENABLE_TODO_TOOLS".into(), "1".into())];
launch.model = Some(model.clone());
launch.permission_mode = Some(milagre::native_mode(&chat_mode, false, false).into());
launch.allow_dangerously_skip_permissions = true;
launch.include_partial_messages = true;
launch.setting_sources = Some(vec!["user".into(), "project".into(), "local".into()]);
launch.system_prompt = SystemPrompt::Preset { append: Some(instructions) };
launch.resume = saved_session_id; // continuing after a crash = a new client with --resume

let handlers = Handlers { permissions: Some(perms), questions: Some(questions), hooks: Some(guard), mcp: Some(milagre_tools), other: None };
let (client, mut events) = ClaudeClient::spawn(&launch, handlers, Limits::default())?;
// Drain `events` on its own task from here on (see Backpressure).
let init = client.initialize(&InitializeOptions { prompt_suggestions: Some(true), forward_subagent_text: Some(true),
    sdk_mcp_servers: vec!["milagre".into()], hooks, agents, ..Default::default() }).await?;
let uuid = client.send_user_message(milagre::user_content(&parts)).await?;
client.set_model(Some("sonnet")).await?;            // set_model
client.set_permission_mode("acceptEdits").await?;   // set_permission_mode
client.apply_flag_settings(json!({"effortLevel": "high", "ultracode": false})).await?;
client.set_max_thinking_tokens(None, Some("summarized")).await?;
client.interrupt(false).await?;                      // reply: {"still_queued": [...]}
client.control("get_context_usage", Value::Null).await?; // any other subtype
let exit = client.close().await;                      // stdin EOF, grace, SIGTERM group, SIGKILL group
```

Events: `ClaudeEvent::Message(Value)` is every non-control stdout frame byte-for-byte as JSON (field
order preserved, unknown fields kept) for the `events.cjs` mapper; `Diagnostic` is never
fatal; `Exit(ExitInfo)` is last. `session_id()` follows `system/init`; `initialization()` keeps the
whole `initialize` reply, including envelope fields such as `pending_permission_requests`.

A permission handler built on the ports:

```rust
FnPermission(move |request, mut cancel| Box::pin(async move {
    let card = milagre::permission_card(&request);          // emit as `permission-request`
    let decision = tokio::select! {
        d = ask_user(card) => d,                             // allow / allow-for-chat / deny
        _ = cancel.cancelled() => milagre::Decision::Cancelled, // CLI withdrew it, or the process ended
    };
    Ok(milagre::permission_result(decision, &request.input, &request.suggestions))
}))
```

## Guarantees (tested)

- **Framing**: NDJSON; frames split across reads; `\r` and blank lines ignored; non-JSON lines are a
  `Diagnostic` (as the Python SDK skips them); a `{` line that does not parse, or a frame over
  `max_frame_bytes` (checked while it grows), ends the process as `ProtocolViolation`. An EOF tail is
  delivered when complete and reported as `TruncatedTail` otherwise.
- **Correlation**: ids `req_<n>_<hex>`, never reused; responses match in any order; error responses
  become `ClientError::Control { subtype, message, raw }`; at most `max_pending_requests` in flight
  (`TooManyPending`); per-request timeout (`Timeout`) also sends `control_cancel_request` for that id;
  a late reply is `Diagnostic::UnmatchedResponse`. Dropping a request future does the same.
- **CLI requests**: each runs on its own task. `can_use_tool` goes to the `QuestionHandler` for
  AskUserQuestion, otherwise the `PermissionHandler`; an allow without `updatedInput` sends the
  original input. Missing handlers answer as the Python SDK: `canUseTool callback is not provided`,
  `No hook callback found for ID: ...`, JSON-RPC `-32601 Server '...' not found`, `Unsupported control
  request subtype: ...`. MCP notifications get the `{"jsonrpc":"2.0","result":{}}` ack.
  `request_user_dialog` without a handler gets no reply. A duplicate id in flight is ignored. A
  handler panic becomes an error reply.
- **Cancellation**: `control_cancel_request` fires the handler's `CancelSignal` (`Withdrawn`) and its
  reply is discarded; on exit every open handler gets `Exited`.
- **No replay**: after exit, waiters fail with `Exited(ExitInfo)` (code, signal, 4000-byte stderr
  tail), later calls fail at once, nothing is resent. Messages the CLI wrote before exiting are still
  delivered, however slowly the owner drains, before the final `Exit`.
- **Reserved reply lane**: replies to the CLI's requests, request withdrawals and `close()`'s stdin EOF
  go through their own lane, sized for every request that can be outstanding and written before
  queued user frames. A reply that cannot be delivered (stdin already closed, lane full) stops the
  process (`ExitReason::ReplyLost`) instead of leaving the CLI waiting on an answer forever.
- **Stalled stdin**: a single write blocked for `stall_timeout` (30 s) kills the process
  (`ExitReason::InputStalled`); a frame is written whole or the process is stopped, so no half line is
  ever followed by another frame. A control request whose caller gave up before it was written is
  skipped; only one the CLI has seen gets `control_cancel_request`. A write/flush error while the
  process is live also stops it (`WriteError`) and settles pending requests.
- **Backpressure**: stdout messages go through a bounded channel (`event_capacity`); a slow owner
  slows the reader and then the CLI, nothing is dropped, order is kept. stdin writes go through a
  bounded queue; a full queue fails after `write_timeout` with `Backpressure`, nothing written.
  Outgoing frames over `max_outgoing_frame_bytes` fail with `FrameTooLarge`. Control replies and the
  CLI's control requests share stdout with messages, so **an owner awaiting a control reply must keep
  draining events concurrently**; `connect()` does this itself while `initialize` is pending and hands
  the buffered events back first (`EventStream`). Its additional buffer is bounded by
  `max_initialize_events` (1024) and `max_initialize_bytes` (8 MiB); overflow kills the process and
  returns `InitializeBufferFull`. After an exit, replies already in the pipe get
  `drain_grace` to reach their waiters, then every waiter fails even if nobody drains events.
  Diagnostics use `try_send` and never block; nothing fatal depends on them.
- **Process cleanup**: the CLI leads its own process group. `close()` closes stdin, waits
  `close_grace` (5 s, as the Python SDK, so the session file is flushed), SIGTERMs the group, waits
  `kill_grace`, SIGKILLs it. `kill()` SIGKILLs at once. Dropping the last `ClaudeClient` SIGKILLs a
  live group. After the leader exits on its own, members left in the group are stopped. stdout closed
  while the process runs: killed after `drain_grace` (`StdoutClosed`). Once the leader is reaped and
  `killpg(pgid, 0)` reports the group empty (ESRCH; EPERM counts as alive), the id is never signalled
  again, so a reused process-group id is not hit.
- **Secrets off argv**: by default the appended system prompt, `--settings` and `--mcp-config` (which
  can carry MCP server env and headers) are written to 0600 files in a 0700 temp directory, passed as
  `--append-system-prompt-file` / paths, and removed when the process ends. `LaunchOptions`' `Debug`
  redacts env values, settings, the prompt and MCP config. The live probe confirms CLI 2.1.322 accepts
  the file forms.

## Tests

```
cargo test                    # unit, fake-CLI integration, Node conformance
MILAGRE_CLAUDE_LIVE=1 cargo test --test live_claude -- --ignored --nocapture   # installed CLI, no turn
NODE_PATH=<checkout>/node_modules node experiments/rust-claude/scripts/generate-conformance.cjs  # refresh fixtures
NODE_PATH=<checkout>/node_modules node experiments/rust-claude/scripts/generate-events.cjs
NODE_PATH=<checkout>/node_modules node experiments/rust-claude/scripts/generate-session.cjs
NODE_PATH=<checkout>/node_modules node experiments/rust-claude/scripts/generate-images.cjs
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

- `tests/client.rs` runs `src/bin/fake_claude.rs`, a deterministic stand-in driven by a JSON script per
  test (expect a frame, reply, send a CLI request, cancel, exit, spawn a grandchild, ignore SIGTERM,
  stop reading stdin, close stdout). Nothing touches a real account or Chat.
- `tests/conformance.rs` compares the `milagre` ports with
  `tests/fixtures/conformance/claude-contract.json`, generated from `permissions.cjs` and
  `questions.cjs` (21 permission cards incl. caps at 20,000 UTF-16 units, MCP names, blocked paths;
  8 results; 6 question cards; 6 question results; 4 answer settlements).
- `tests/events.rs` compares 42 message sequences with Node `mapClaudeMessage`: streaming text,
  thinking, steps/results, tasks, design drafts, subagent artifact steps, usage/compaction, local
  commands, login/rate-limit errors and suggestions; child tasks/transcripts/status/progress and
  background sets. Its generator uses a deterministic clock. The transcript-tail case feeds 105
  messages and compares the final 100-row snapshots and cumulative progress.
- `tests/session.rs` covers 39 integration cases, including eight Node `ClaudeSession` traces:
  starts/steering, implicit turns, notification-only turns, suggestions, permissions/questions,
  settings ordering, can-start, resume/login/crashes, queue pressure, oversize sends, dropped startup,
  queued cancellation, accepted delivery, dropped close/receiver, session drop and interrupt grace. Fake processes only. Existing
  transport stalled-write/drop tests continue to ensure no partial frame is followed by another.
- `scripts/generate-session.cjs` runs the actual Node session with an in-memory query double. No real
  SDK is loaded, no process is launched and no profile is written. The only writes are the fixture.
- `tests/live_claude.rs` (opt-in, `#[ignore]`): spawns the installed CLI with HOME and
  `CLAUDE_CONFIG_DIR` in a fresh temp dir (no credentials, no user settings or transcripts read or written),
  an empty cwd, `--strict-mcp-config`, `--no-session-persistence`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. It initializes and sends local control requests only;
  no user message, so no model turn. Result on 2.1.322 (0.14 s): `initialize` answers without
  credentials (`account: {"tokenSource":"none","apiProvider":"firstParty"}`, 44 commands, 5 models,
  `session_state: "idle"`, `capabilities: ["ui_surface_v1", "mcp_call_result_not_for_model_v1",
  "mcp_call_check_permissions_v1"]`, envelope carries `pending_permission_requests` and
  `pending_user_dialog_requests`); `--permission-mode default` accepted (the help lists `manual`; the
  TS SDK maps `manual` to `default`); `set_permission_mode` default/acceptEdits, `mcp_status`,
  `interrupt` with no turn (`{"still_queued":[]}`) all succeed; an unknown subtype returns `Unsupported
  control request subtype: ...`; close exits 0.

## Gaps (not done here)

Owner integration and remaining mapping:

1. The standalone session is not wired to `rust-owner` or `rust-providers`; provider selection,
   durable turn ownership, persistence and desktop/mobile fanout still belong to that integration.
2. `events.cjs` text/thinking, tool steps/results, task lists, live design drafts, compaction/context
   usage, errors and suggestions are ported, including `claudeSubagents`/`settleSubagents`: nested
   launches, status updates, task lists, transcript/progress caps, foreground waits and background
   sets. Background work survives a normal turn end; close/crash settles it before terminal events.
   `claudeReadImages` persists returned image bytes only when the owner supplies a `ToolImageStore`;
   eleven Node traces compare event order and exact saved bytes. The mapper is not wired to the
   production owner yet.
3. In-process MCP server for linked tools (`createSdkMcpServer` + `runTool`): only the `mcp_message`
   hook exists; MCP `initialize` / `tools/list` / `tools/call` serving, `alwaysLoad`, annotations and
   `sdkMcpServerManifests` are not implemented.
4. Owner policy/config assembly: real `WorkspaceAccess` root tracking/learning, babysit and wake
   guard rules, `advisorPolicy`, QA agents, `sessionInstructions`, linked tools and settings discovery
   are not implemented. Access and pre-tool guard interfaces accept owner-supplied decisions, but
   do not supply safe analysis/advisor policies on their own. `analysis_only` sessions now fail
   before spawn with `SessionError::UnsupportedAnalysis`, regardless of mode or launch allow rules. Execution-advisor disallowed tools,
   question denial, SubagentStart context, MCP off toggles, prompt-suggestion gating, reply style,
   effort/ultracode/fast mode ordering and task output are implemented. `prompt_suggestions` is an
   explicit option; the owner must read the user's setting. Per-turn wake/babysit guard replacement
   and escalation accounting remain outside this checkpoint.
5. `promptImageBlocks` ordering (`[Image #N]` tokens) is not ported: the owner passes ordered parts.
6. Accounts: no `CLAUDE_CONFIG_DIR` routing or account switching; the owner sets the environment.

Protocol and process:

7. The TS SDK 0.3.288's exact argv/env was not reproduced byte-for-byte (its code is minified and
   licensed). Differences known: `CLAUDE_AGENT_SDK_VERSION` unset unless `sdk_version` is given;
   `CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH` / `_HAS_HOST_AUTH_REFRESH` / `CLAUDE_CODE_SDK_READS_SESSION_STATE`
   not set; the appended system prompt goes by `--append-system-prompt-file` rather than an
   `initialize` field; no `--await-initialize` / plugins. The env entrypoint is `sdk-ts` to match what
   Milagre's CLI sessions report today.
8. Live coverage is `initialize` plus local control requests. `can_use_tool`, AskUserQuestion,
   `hook_callback`, `mcp_message`, `control_cancel_request` in either direction, interrupt during a
   turn, resume and streaming of a real turn are verified against the fake only: a real turn needs
   credentials and is billed. The CLI-side handling of our `control_cancel_request` after a timeout is
   from the type docs, unverified live.
9. `elicitation` and `request_user_dialog` have no Milagre UI; no dialog kinds are declared in
   `initialize`, so the CLI should not send them.
10. Session-state frames (`requires_action`) and `pending_permission_requests` on `initialize` are
    exposed raw, not re-armed as cards.
11. Windows: no Job object or tree kill (process-group calls are Unix-only), no `.cmd` shim handling
    from `command.cjs`. Descendants that leave the process group (`setsid`) are not tracked. The
    process-group id check and the signal are two calls, so a group that empties and is reused in
    between could still be signalled (a window of microseconds, same as `rust-providers`).
12. Handler tasks are signalled, not aborted: a handler that ignores its `CancelSignal` keeps running
    after a withdrawal or exit (its reply is discarded). Tested not to delay the exit.
13. stderr is kept as a 4000-byte tail (as Node), not streamed.
14. `uuid()` is random but not cryptographic (ids only).
15. JSON ports approximate JS `String()` for non-string inputs (objects, nested arrays) and can
    differ from JS for non-finite or float-formatted numbers and for a lone UTF-16 surrogate at the
    20,000-unit cap.
16. Process-group helpers duplicate `experiments/rust-providers`; sharing them is left for the owner
    integration.

## Session safety review checkpoint

Analysis-only sessions are refused before spawn until the full advisor tools/settings/MCP policy
exists. Setting `analysis_only` cannot enable a partially protected CLI.

Auto mode resolves pending edits only after checking their raw string paths against an absolute,
existing cwd, canonicalized as supplied. New files use their nearest existing ancestor; symlink
escapes, dangling/looping links, empty paths, `..` in requested paths and missing/relative cwd fail
closed. A mode switch rechecks every waiting edit, so a path authorized when a card was created is
not cached through a later symlink replacement. Candidate request ids/tokens/paths are captured under
lock, checked on the blocking pool, then matched again against current mode and pending tokens
under lock before resolution. This deliberately tightens Node's lexical `insideRoot`, matching rust-providers
40425d7a's canonical rules. Filesystem changes after authorization still need OS/CLI enforcement;
this is not a filesystem sandbox.

Dropping an initial turn start still closes its owned process. Steering now has a distinct
admission boundary: wait for any earlier delivery, check `can_start`, validate the encoded frame,
then commit exactly one session-owned delivery task. No requested mode changes or pending-card
resolutions happen before admission. Dropping a future still waiting for admission discards it;
dropping the receipt of an admitted message cannot abandon that message or its requested mode.
The accepted task applies the mode, then sends the message. Failed native mode changes close with
an explicit error, and failed accepted delivery cannot disappear when the receipt is gone.
Questions are dismissed only after the user frame is queued. A successful receipt means stdin
queue acceptance, not CLI execution acknowledgement. Eligibility is not rechecked after admission.

Starts and public mode changes remain serialized. Close, interrupt and receiver-drop shutdown
remain independent. The owner must drain events promptly to avoid overflow; operations no longer
wait indefinitely for queue room. Startup latency, CLI delivery acknowledgement and per-turn
policy injection still need accounting in the owner's nonblocking `Provider`/`TurnId` adapter.

## Queue safety contract

`SessionOptions.event_capacity` defaults to 1024 (minimum 2); `event_bytes` defaults to 8 MiB
(minimum 2048). These totals include one reserved terminal event and 1024 reserved bytes. Every
producer, including permission/question callbacks, resolutions, implicit turns and close/exit
settlement, uses the same queue. Accounting estimates JSON heap payload plus per-value/map-entry
overhead without allocating a serialization copy. This is an output budget, not a process RSS cap.
Dequeued entries release their count and byte charges.

On overflow the accepted prefix remains ordered, followed by exactly one `turn-failed` with
`code: "claude_event_limit"`; later output is discarded. A watcher stops the CLI independently of
the consumer and session lock. A failed mapped batch is replaced by that explicit error; partial
batch events are not published. Background output can fail between turns; the owner must treat
this code as a session failure, not a second completion of the previous turn. Standalone mappers use `EventBudget` too. A session limits the
transport's pending message channel to one frame; input frames and in-progress parsing retain
the separate `Limits.max_frame_bytes` bound (64 MiB default).

`max_subagents` defaults to 128 tracked children across the session, including completed children;
`subagent_snapshot_bytes` defaults to 256 KiB per child. Exceeding either fails explicitly instead
of silently evicting a child. Child task indexes are capped relative to the child limit. Snapshot
batches, close/crash settlement and image event batches also obey count/byte limits, so repeated
full snapshots cannot grow a frame's mapped output without a bound. Ordinary Node traces remain
unchanged within these limits. Limits intentionally add failure cases not present in Node.

Dropping the only `SessionEvents` receiver clears buffered output, stops its CLI and unblocks
startup. Dropping the session cancels owned delivery tasks. No background task depends on the
owner draining output to perform shutdown.

## Read-image storage

Set `SessionOptions.image_store = Some(Arc::new(FileImageStore::new(private_media_directory)))`
or call `ClaudeMapper::set_image_store` directly. With no store, mapping does no image I/O. The
owner chooses and controls the directory, serves its files and manages retention; no shared global
temp store is selected automatically. `ToolImageStore::save(mime, base64) -> Result<PathBuf, String>`
also permits a host media-store implementation.

Only matched, consumed, top-level, successful, non-replay Read results produce viewed-image steps.
Bad or unwritable images skip individually, preserving the Read row and valid siblings. PNG, JPEG,
GIF and WebP use Node's signature checks, strict canonical base64 and 50 MiB decoded-size limit.
These are signature checks, not full image decoding. Source filenames are event metadata only;
they are never opened. Files are named by SHA-256 of the bytes, with Node's extension mapping.

The default file store creates directories with 0700 and files with 0600 on Unix, publishes complete
files atomically via hard links, deduplicates concurrent saves and refuses existing symlink,
non-file or corrupt hash entries. Parent directories must be trusted; this is not protection from
an attacker replacing the owner's directory tree. Filesystems without hard links return an error,
which skips the image. Standalone mapping remains synchronous. Sessions capture matched Read jobs
under the state lock, validate/save on the blocking pool, then publish only if the process generation
is still current. Close and receiver drop remain responsive during storage. Blocking filesystem
operations cannot be forcibly cancelled: an already-started save may finish after close, but it
cannot publish a stale event. Disk quotas, retention, crash-temp cleanup and Windows behavior
remain unimplemented or unverified.

`tests/images.rs` checks eleven Node traces including saved bytes, atomic concurrent deduplication,
private modes, corrupt entries, symlink refusal, oversized payloads and no-store behavior. The
session test proves returned bytes persist without opening the source path. The Node fixture
script redirects only its own image temp path and removes that fresh scratch directory afterwards.

See [INTEGRATION-GAPS.md](INTEGRATION-GAPS.md) for MCP serving, policy and owner adapter boundaries.
