# Claude owner, MCP and policy integration inventory

Checked against Node sources, rust-providers' `POLICY-CONTRACT.md` and rust-owner's
`chat_host.rs` (`Provider: Send`, host `TurnId`, integrated as d3e001ba) on 2026-11-10.
This is an API inventory and proposed integration contract, not an implementation of those services.
Only `experiments/rust-claude` changed. Validation uses fake CLI processes and recorded Node traces.

## Implemented boundary

`ClaudeSession::new(SessionOptions)` returns the process owner and its `SessionEvents` consumer.
`start_turn(TurnRequest)` is async and returns `TurnStart { turn_id, steered, cancelled }`.
`interrupt`, `close`, `set_permission_mode` and `task_output` are async. `respond_to_permission`
and `answer_question` are synchronous, return whether a matching pending request existed and
require the owner to authenticate the Chat and request. Events are Node-shaped JSON; terminal
turn events do not themselves carry a host TurnId. `native_id` and `pid` expose session metadata.

The session consumes the native CLI stream directly. There is no Node SDK runtime or sidecar.
The event mapper covers top-level text/thinking, tool steps, tasks/drafts, errors, usage,
subagent lifecycle/transcripts/progress, background task sets and opt-in Read-image persistence.
Background work survives turn completion; close/crash settles it before terminal events.

Safety checkpoint 8ba16913 refuses every `analysis_only` start before spawning with
`SessionError::UnsupportedAnalysis`. Auto resolution of pending edits checks raw string paths,
canonical cwd/ancestors on the blocking pool, then rechecks mode and pending-card tokens under lock.
Missing/relative cwd and malformed or unresolved paths fail closed. A steer now checks eligibility
and size before admission; a session-owned task completes its requested mode and delivery after
admission even if the caller drops the receipt. Cancellation before admission has no side effects. The separate initial-start
abandon guard still closes that owned process. These choices are stricter than Node in the places
called out in README; fixture equality does not imply policy completeness.

## In-process MCP serving

`mcp::InProcessMcp` registers one immutable owner manifest and `McpDispatch` callback per server.
An owner-held `McpRegistration` supplies a generation-pinned handler and atomically attaches SDK
launch/initialize config. It refuses duplicate servers, existing handlers and reserved manifest
cache overrides. Other caller MCP servers/settings remain intact. Only manifest read-only tools
are preallowed; writes still require native permission. Successful `tools/list` replies must match
the registered names/effects exactly and receive `anthropic/alwaysLoad` metadata.

The callback wraps the owner's existing scoped `ContentOwner::Dispatcher::dispatch`; no provider
store, writer, socket or Node runtime is created. The dispatcher owns JSON-RPC negotiation, schemas,
role enforcement, effects and execution. The owner must route synchronous work onto its bounded
worker. Typed `DispatchError` values and panic containment expose only static bridge errors;
successful owner protocol replies remain trusted content and must already be safe to publish.

Requests, responses, concurrent calls and duration are bounded. Cancellation/drop/revocation
signals the callback, drops its future and discards late responses. Each handler keeps its original
registration generation, so name reuse cannot transfer grants or deliver the old call's payload.
There is no retry. A mutation may already have committed when cancellation, timeout or revoke wins;
discarding the reply does not undo it. The caller must reconcile that uncertainty with its owner.
Bytes already handed to the transport cannot be recalled. Notifications return the enclosing
control acknowledgement, without waiting for a JSON-RPC reply.

Eight fake-CLI bridge tests cover lifecycle, exact manifests, static errors, conflicts and limits.
Seven separate integration tests exercise actual ContentOwner initialize/list/call/schema errors,
notifications, revocation/shutdown, shared renderer visibility, the escalation 6+2 budget, stored
UTF-16 content, cancelled queued calls, committed mutations and late external outcome evidence.
`scripts/test-content-owner.py` builds those against pinned source `afba0d21` in a temporary snapshot.
The base crate has no ContentOwner dependency. One attached in-process handler per session is
supported; multi-handler composition, full host chat/worktree tools, account-specific discovery,
production owner worker and runtime adapter remain outside this checkpoint.

The callback can expose an owner-backed `DispatchReceipt` through `McpDispatch::start` without
changing existing `dispatch` implementations. Errors carry typed delivery evidence as static JSON
data and never authorize automatic replay. `CallStatus.external` is independent late evidence;
the adapter maps `mutation` and preserves the uncertainty already delivered to its caller.
Raw outbound replies avoid Value reparsing and keep lone surrogates, U+10FFFE and PUA losslessly.
Reply-buffer reservations cover two maximum-sized buffers per admitted call and remain held
until stdin delivery or discard. Defaults are 4 MiB per reply and 32 MiB shared capacity; owner
work/request memory and small protocol headers/indexes have separate bounds. Incoming lone-surrogate
arguments and direct legacy Value-returning handler calls remain unsupported.

Analysis-only startup remains refused. Host read-only roles alone cannot restrict native Claude
commands/settings/plugins; the full constrained launch policy must land before enabling them.
`mcp_off` remains best effort and is not a security boundary. No live MCP/provider turn was tested.

## Policy alignment with Codex

| Claude interface today                                                                                    | Codex contract / proposed shared owner boundary                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PreToolUseGuard::deny_reason(&Value) -> Option<String>`                                                  | Wrap the same owner policy service as Codex `CommandClassifier::actions` and immutable `SessionRole`; denial alone does not provide remote-action classification or persistent-approval safety. Native PreToolUse runs in all ordinary modes; fallback checking in `can_use_tool` currently covers command cards only.                                                                                        |
| `AccessPolicy::answer(kind, files, mode) -> Option<AccessDecision>`; Allow may carry directories to learn | Supply validated canonical workspace ownership and read-only/dynamic roots, independently of display-card coercion. No concrete WorkspaceAccess/root tracking exists here. Callbacks currently run synchronously under the session lock; they must not block or reenter it.                                                                                                                                   |
| `analysis_only`                                                                                           | Refused before spawn. To enable it, port the entire Node advisor policy: empty native tools/settings/plugins, strict MCP config, dontAsk, no dangerous bypass, exact allowlisted read-only host tools and deny-by-default canUseTool. Do not enable it with prompt instructions alone.                                                                                                                        |
| `execution_advisor`                                                                                       | Only disallowed AskUserQuestion/Agent/Task, question denial and suggestion/subagent-context suppression exist. This flag is not a complete role policy and is not equivalent to Codex's refused ExecutionAdvisor. Keep the owner feature gate until the full contract is agreed.                                                                                                                              |
| Static optional guards and MCP handler                                                                    | Babysit/wake roles, guard replacement, command classification, exact authorized Chat/request pairs and escalation accounting are not implemented. Codex uses immutable session roles, requires a classifier for babysit, denies unknown syntax, enforces 6 calls plus 2 grace calls and prohibits unsafe config fallback. Reuse those facts and budgets; do not silently run an unsupported role as Ordinary. |

The Codex owner supplies `CommandClassifier`, `HostTool { name, read_only }`, `LinkedTools`
and `WakeRequest { chat_id, request_id }`. No shared owner trait was introduced by either
provider checkpoint. A future Claude implementation should consume the same trusted facts,
without importing the whole Codex transport or accepting raw config overrides for constrained
roles. Reuse Node babysit/advisor/escalation fixture decisions and add Claude-specific native
hook, permission callback and host-MCP bypass tests. Guard refusals must precede pending-card
creation, Full-mode auto-resolution and persistent permission learning. Policy errors must
refuse or fail startup, never retry as an unguarded session.

Coordination messages were sent to Codex Chat10975 and owner Chat10960. Their current checked-in
contracts informed this inventory; no API agreement or production adapter is implied.

## Nonblocking owner adapter

The owner `Provider` methods must return immediately and report `Started`, `StartFailed`,
`Agent` and `Exited` through `take_events` or delivery. Do not block the owner's actor on a
Claude future or hold its lock while draining provider events. A per-Chat worker should own the
session, accept bounded commands and continuously drain `SessionEvents`, including during startup,
mode changes and shutdown. Cancelling an IPC reply must not cancel an already accepted worker
command. Close and interrupt need a path that can run while startup or stdin is waiting.

Bind each accepted owner TurnId to the corresponding provider turn before forwarding its events.
The session emits `turn-started` before `start_turn` returns, so completion callbacks and event
pumping need explicit ordering. Steers retain the provider's active turn; stale terminal events
must keep their original owner TurnId rather than be retagged to the newest send. Chat-level
background/context events need their allowed unowned classification. Implicit provider turns
need an agreed host TurnId allocation contract; the current owner trait supplies ids only on
host-initiated starts. Gate this behavior until that contract exists.

Permission/question responses also need bounded command dispatch or a safe nonblocking registry:
the current synchronous methods acquire the session mutex. Image saving and automatic canonical
path checks now run outside that mutex, but trusted AccessPolicy callbacks still run under it. Returning `Ok(false)` must still mean the request is gone, not that the worker was busy.
The owner must authenticate and scope request ids and retain exactly-once settlement across
turn end, close, withdrawal and stale responses. There is no owner adapter in this checkpoint.

## Media boundary and remaining validation

`ToolImageStore::save(mime, base64) -> Result<PathBuf, String>` is optional on SessionOptions and
ClaudeMapper. `FileImageStore` validates and writes returned Read bytes in an owner-selected
private directory, with content hashes, atomic publication and Unix private modes. The source
path is metadata only. Node traces compare both events and exact persisted bytes. Failed image
writes preserve other events. No owner media route, retention/quota, input-image lifecycle,
`promptImageBlocks` ordering or general MCP image extraction is supplied.

Standalone mapping remains synchronous. Sessions capture image work under lock and perform it
on the blocking pool. Results are mapped only for the current process generation; close can finish
without waiting for storage. Already-started filesystem writes cannot be forcibly cancelled.
Automatic canonical-path checks likewise run on the blocking pool, then revalidate request tokens
and mode. Output queues and mapped batches now have shared count/estimated-byte limits with a
reserved terminal error and independent CLI shutdown; subagent histories are trimmed with a sticky `truncated` marker and tracked counts are capped.
Close/crash child updates contain empty transcript deltas; the adapter must merge those by id and
preserve retained rows, including when its own UI format uses transcript-tail replacement objects.
See README's queue safety contract for defaults and intentional differences from Node. Filesystem authorization remains point-in-time; neither path checks nor image storage
provide a filesystem sandbox. Windows and real billed provider turns remain unverified. The
opt-in live initialize/control test remains ignored throughout this work.
