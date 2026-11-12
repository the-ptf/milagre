# Shared daemon client, owned-fixture checkpoint

An additive default-disabled `owned-chat` checkpoint now supplies a dedicated
persistent runtime guard and typed ChatActions. Its authority, bounds, exact tests
and remaining gates are in [OWNED-CHAT.md](OWNED-CHAT.md). Existing fixture APIs and
their pins are unchanged; the original fixture contract below still applies.

The dedicated `chat-runtime` success receipt is unchanged. Before any receipt,
startup refusal may be one LF-terminated JSON record (at most 4096 bytes in the
existing five-second admission deadline):

```json
{"protocolVersion":1,"pid":12345,"uid":501,"dataRoot":"/explicit/dedicated-root","startupError":{"code":"CHAT_ROOT_BUSY","message":"This dedicated Rust Chat data root is already running"}}
```

Both objects have closed schemas. PID/uid/requested root must match the exact
spawned child, and executable/root/launch-selection pins are checked again.
Only this Busy pair and `CHAT_RUNTIME_START_FAILED` / `The dedicated Rust Chat
runtime could not start` are accepted. Code/message are returned as `Error::Remote`
with the unchanged startupError object as payload. Unknown codes, fields, message
text, identities, malformed JSON, oversized or late records refuse admission.
No account/install diagnostic, stderr capture, socket path or authority grant is
included. A refusal never means cleanup completed: the same retained supervisor
still owns the exact child until confirmed reap, preserves Unknown on wait error,
and removes only its own identity-checked temporary launch storage afterwards.
Persistent data and the original active owner's wire profile remain untouched.

## Dedicated terminal actions (`owned-chat`, default off)

`OwnedChatGuard::terminal_actions(&Client) -> Result<TerminalActions>` requires
the exact guard/connection pair. The capability holds a weak Client, never
connects or reopens a view, and cannot select another daemon, Project, cwd or
shell. Every route requires successful explicit `Client::open_view` on that
connection. `project_current` alone does not satisfy this local gate. Chat IDs
are positive JSON-safe numeric IDs; list/open derive `<captured Project>#<id>`.
Backend membership/generation checks remain authoritative.

```rust,ignore
impl TerminalActions {
    async fn list(&self, chat: u64) -> Result<Value>;
    async fn profiles(&self) -> Result<Value>;
    async fn open(&self, chat: u64, size: TerminalSize) -> Result<Value>;
    async fn read(&self, id: &str, after: u64, limit: Option<u64>) -> Result<Value>;
    async fn input(&self, id: &str, data: &str) -> Result<Value>;
    async fn resize(&self, id: &str, size: TerminalSize) -> Result<Value>;
    async fn close(&self, id: &str) -> Result<Value>;
}
// Public fields, validated before enqueue. Default is 80 x 24.
struct TerminalSize { cols: u16, rows: u16 }
```

Each call maps only to its corresponding `terminal:*` route with one object
argument. No `setShell`, attach-with-arbitrary-path, or raw RPC is exposed.
Terminal IDs must be canonical lowercase UUID strings obtained from the daemon's
open/list result; they carry no independent authority. Columns must be 2..=1000,
rows 1..=500, `after` 0..=9007199254740991 UTF-16 units. An omitted read limit stays
omitted; an explicit limit is 4096..=1048576 UTF-16 units. Input is at most 65536
UTF-8 bytes (stricter than the daemon's 65536 UTF-16-unit limit). Empty input and
control bytes remain valid. Serialized arguments are capped at 512 KiB, including
JSON escaping, before enqueue. Returned JSON, output offsets/reset/ended flags,
remote error payloads and uncertainty are preserved unchanged.

All futures are executor independent. Dropping an unpolled call sends nothing;
dropping an admitted wait only abandons the local result. Actions and pending
waits do not retain a dropped Client. Disconnect returns `Disconnected`; an
unopened view returns `ViewNotOpened`. A missing route returns `Capability`.
No automatic retries/replays/reconnects occur. In particular, lost open/input
receipts can mean a terminal was created or input ran. Reconcile with explicit
list/read rather than replaying an uncertain mutation.

### Explicit read connection required for responsive controls

This checkpoint does not multiplex RPC. A daemon `terminal:read` can long-poll
for eight seconds and holds up every later RPC on that same Client, including
input, resize, stop and Chat actions. It is not an interactive-ready single-Client
transport. An integration must explicitly connect a second Client through the
**same retained guard**, use its TerminalActions only for reads, and keep controls
on the main Client. This creates another reader socket, not another daemon/PTY
owner. For each connection independently, explicitly open the Project, capture
and apply a runtime snapshot, accept its opaque receipt, and consume Notifications.
No connection is opened implicitly by TerminalActions. Both consumers must stay
drained, even if the reader's duplicate notices are otherwise ignored; an unread
bounded event queue can overflow and close that connection.

`terminal:changed` and any advertised `terminal:preferences-changed` notices use
the existing ordered, bounded notification stream and snapshot barrier. The
owner's internal Exited event is not forwarded as a `terminal:exited` wire event.
Terminal output is fetched using
`read` with the actual returned UTF-16 offset, not inferred from event timing.
Reconnection is explicit through the same guard, then reopen/apply/accept and
list/read catch-up. PTY lifetime belongs to the daemon; disconnecting a reader is
not terminal closure. Neither terminal-close acknowledgment nor connection drop
substitutes for the retained guard's final cleanup evidence.

## Dedicated Git reads (`owned-chat`, default off)

`OwnedChatGuard::git_reads(&Client) -> Result<GitReads>` is another exact-guard,
weak-Client capability. The four Git routes and two local PR diff routes require an explicitly opened Project view
on that Client. A successful `project_current` read is insufficient. Every call
derives `cwd` from the captured dedicated Project; the caller cannot supply it.
There is no raw argument object, mutation, remote PR action, Worktree-path selection,
parent-repository discovery or fallback. The backend independently verifies the
Project/repository identity and scope before and after each query.

```rust,ignore
impl GitReads {
    async fn changes(&self, base: Option<&str>) -> Result<Value>;
    async fn history(&self, options: GitHistoryOptions) -> Result<Value>;
    async fn diff_files(&self, options: GitDiffOptions) -> Result<Value>;
    async fn diff_file(&self, path: &str, options: GitDiffFileOptions) -> Result<Value>;
    async fn pr_diff_files(&self, base: &str, head: &str) -> Result<Value>;
    async fn pr_diff_file(&self, base: &str, head: &str, path: &str, old_path: Option<&str>) -> Result<Value>;
}
struct GitHistoryOptions {
    base: Option<String>, recorded_base: Option<String>,
    branches_version: Option<String>, limit: Option<u16>,
}
enum GitDiffMode { Uncommitted, Committed }
struct GitDiffOptions {
    mode: GitDiffMode, base: Option<String>, commit: Option<String>,
}
struct GitDiffFileOptions {
    diff: GitDiffOptions, old_path: Option<String>, untracked: bool,
}
```

These are public fields with Default implementations: optional fields absent,
mode Uncommitted, untracked false. Exact wire methods are `git:changes`,
`git:history`, `git:diff-files`, `git:diff-file`, with one object argument and no
extra keys. `recorded_base`, `branches_version`, and `old_path` become
`recordedBase`, `branchesVersion`, and `oldPath`. Optional fields remain absent
when not supplied; an explicitly empty base string is preserved. A false
untracked flag is omitted, matching the backend default. Commit selection needs
a full 40-character lowercase hexadecimal SHA-1 and Committed mode; an untracked
patch needs Uncommitted mode. Arbitrary range options and caller cwd cannot
be represented. Incompatible combinations refuse before enqueue rather than
being silently ignored.

Base/recorded-base strings are at most 1024 UTF-8 bytes without NUL. The opaque
branches-version is at most 128 bytes without NUL. History limit is 0..=300;
zero requests metadata without commit rows, and None preserves the daemon's
default. File/old-file paths are nonempty relative repository paths of at most
4096 bytes, without NUL, absolute/UNC roots or `..` components separated by `/`
or `\`. The backend still owns repository membership/symlink validation.
Encoded arguments must fit 64 KiB, including JSON escaping. No string is trimmed,
truncated or normalized. No public method accepts arbitrary `serde_json::Value`
input; output bodies preserve the daemon's actual metadata/patch/truncation/errors.

Futures use the existing executor-independent I/O thread, with the same weak
connection lifetime, view gate, bounded admission, remote payload preservation,
submitted-timeout uncertainty and no replay/retry/implicit reconnect semantics.
Git reads share that Client's serialized RPC queue. Keep terminal long-polls on
the explicit separate reader connection described above. Existing notification
barriers apply unchanged; GitReads does not create another subscription or owner.
Repository absence is preserved as the daemon's `isRepo:false` result (or its
`GIT_NOT_REPOSITORY` refusal for a patch), never an invented empty repository.

The explicit local PR methods use `pr:diff-files` and `pr:diff-file` with full
lowercase 40-character SHA-1 `base`/`head`, comparing merge-base(base,head)..head.
`old_path` becomes `oldPath`; paths keep the same bounded literal relative-path
contract. No fetch, GitHub authentication, PR detail lookup, review write or remote
API is added. Missing local commits return the backend's fetch-needed/empty-patch
result rather than silently fetching. The ordinary Git diff capability does not
accept this internal PR range mode. Existing snapshot receipt/event barriers stay
unchanged; integration tests explicitly open the view, apply/accept a snapshot,
then call these methods. Reconnect remains explicit.

`milagre-daemon-client` is the backend-owned protocol-v1 client boundary agreed with the GPUI workstream in Chat #11899. It is independent of Tauri, GPUI and the caller's async runtime. This checkpoint adds a separate connection-bound ScriptedActions capability to the owned-child launcher and protocol engine. Bounded deferred Project-state hydration remains available. Real `app-fixture` reads, live hydration, paging, reconnect and lifecycle checks run separately from the default test suite. **It is not production authority or a complete GPUI adapter.** No installed app or runtime imports this crate yet.

## Authority and owned-child launcher

`FixtureGuard::launch()` and `FixtureGuard::launch_populated()` are the only public constructors. Both canonicalize the current executable and launch only its fixed sibling `app-fixture`. The first passes no arguments. The second passes the fixed `--populated-transcript` preset, which completes three Scripted turns across two Chats before binding. It accepts no caller transcript or other configuration. The selected preset must match the exact receipt; default launches refuse unexpected preset metadata. The sibling and parent must be owned by the current user, non-symlinks and not writable by group or others; the executable is a regular, executable, single-link file. Held descriptors and path identities are checked before spawn and again before admission. This is a cooperative same-user launch boundary, not executable signing or a sandbox against a malicious same-user process racing path checks.

The lifecycle worker creates a private mode-0700 `/tmp/milagre-client-launch-*` root, supplies its own HOME, XDG config/cache, TMPDIR, fixed system PATH and locale with `env_clear()`, and keeps the exact `Child` plus stdin. The daemon creates and owns its separate disposable profile. The launcher reads at most 4,096 bootstrap bytes in five seconds, validates the closed receipt schema, version, exact child PID, UID, fixed scripted/gated actor metadata, canonical generated paths and all four receipt identities. The socket must equal the protocol's SHA-256-derived path. Before and after every connection it validates pinned profile, Project, socket-directory and socket identities. macOS `getpeereid` and `LOCAL_PEERPID` must identify the same user and exact retained child. Other platforms cannot obtain public fixture authority.

`FixtureGuard::endpoint()` mints an opaque connection grant; `FixtureInfo` paths and PID are diagnostics only. There is no arbitrary executable, profile, socket, stream, environment or connector callback API, ambient discovery, Node fallback or daemon restart. Synthetic connector authority exists only inside `cfg(test)`. No copied production profile or credential is read.

An endpoint and its connection worker retain the same authority `Arc`. Reconnect is explicit: retain the guard, obtain another endpoint, connect, reopen views, apply a fresh snapshot and acknowledge it. There is no automatic reconnect, recovery, retry or replay. Multiple readers do not create another writer. Dropping one Client closes only its socket; it does not stop a guard-owned fixture.

### Shutdown and uncertain ownership

`FixtureGuard::shutdown()` seals new connections and asks the exact verified endpoint for `daemon:stop`. Its deadline is three seconds from queue admission. Socket admission is nonblocking with deadline-driven polling; queued connections carry their original admission deadline. A full listener backlog either refuses immediately or expires within that deadline. `Pending {stop_acknowledged, reason}` means termination is unconfirmed and retains Child, stdin and storage. A later call can inspect progress. An acknowledged stop is never followed by a signal, forced wait or premature stdin close. `Complete(Cleanup)` requires an actual successful reap; its fields separately report exit code, stop acknowledgment, daemon profile/socket absence and launch-storage removal. A nonzero exit or missing cleanup flag is never presented as a clean shutdown.

The launcher never signals any PID or process group and never removes the daemon profile. Only the daemon owns that cleanup. The launcher removes its own generated HOME/root only after confirmed reap and a fresh identity check. A replacement seen by that check is retained. Removal then uses path-based `remove_dir_all`: a malicious same-user swap between check and removal remains outside this cooperative boundary. Descriptor-relative recursive cleanup is not claimed. Cleanup results are cached once; a false removal flag remains visible and later shutdown calls do not retry deletion. Last-authority drop returns without waiting: if no stop was acknowledged, its lifecycle worker closes the exact child's stdin to request EOF shutdown, then retains ownership until reap. With an acknowledged stop it keeps stdin. Dropping a pending launch future similarly abandons only the result; the worker admits or rejects the child and runs the same teardown. Bounded caller return does not imply bounded child termination.

Any wait error except EINTR latches `Unknown`. That child is never probed, signalled or waited on again. Unknown state and descriptors are deliberately retained for the process lifetime, with no unproven cleanup. The parent process must keep children waitable: no SIGCHLD ignored, SA_NOCLDWAIT, or global wait-any reaper. Waiting for one's own child by handle is compatible. The library does not install signal handlers or a global child reaper. Receipt/identity failure closes stdin and follows the same signal-free retention policy; unknown or still-running cleanup is not silently claimed successful.

## Facade

All async methods use an internal standard-library I/O thread and executor-independent one-shot futures. A caller can use a GPUI executor, Tauri executor or `futures::executor::block_on`; no caller-thread Tokio runtime is required.

| API                                                        | Wire behavior                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Client::connect(endpoint, options)`                       | Returns `(Client, Hello { wire, capabilities, owner }, Notifications)` after `daemon:status`. Protocol 1, expected owner PID, `closing: false`, string capability/method lists and both paging capabilities are required. Status metadata is diagnostic, never authority. |
| `project_current()`                                        | `project:current([])`; preserves the Project body and checks the generated Project path.                                                                                                                                                                                  |
| `project_read(path, with_state)`                           | `project:read([path, {state: bool}])`.                                                                                                                                                                                                                                    |
| `state_read(scope)`                                        | `state:read([scope])`, returning actual `state`, `version` and `epoch`.                                                                                                                                                                                                   |
| `chat_runs()`                                              | Global `chat:runs([])`, returning `{runs, seq}`. Run sequence is distinct from global wire sequence.                                                                                                                                                                      |
| `chat_messages(scope, numeric_id, {before, turns, limit})` | `chat:messages([scope, numeric_id, options])`; absent options stay absent. IDs/options must be JSON-safe unsigned integers. Returns the actual raw body and metadata. No cursor fields are invented.                                                                      |
| `open_view(path)`                                          | Explicit `project:open([path])`. It may recover or persist owner state. It is not a mutation-free read.                                                                                                                                                                   |
| `runtime_snapshot()`                                       | Captures and assembles `daemon:snapshot([{paged:true}])` plus `daemon:snapshot-page`. Returns `RuntimeSnapshot {body, event_seq}` with a private receipt.                                                                                                                 |
| `accept_snapshot(&snapshot)`                               | Local acknowledgment only, after the caller applies the snapshot. No RPC.                                                                                                                                                                                                 |
| `disconnect()`                                             | Closes this connection. Never stops the fixture owner.                                                                                                                                                                                                                    |

Only the exact generated Project scope is admitted for requests and hydration. Notification scopes and raw snapshot bodies remain advisory; consumers must filter them when needed. The Client exposes no raw RPC or Chat/content write method. Scripted Chat writes require the separate capability below; content writes remain absent. Omitted, malformed, unsupported and foreign inputs fail visibly. Unknown fields in successful raw bodies and remote errors are preserved through `serde_json::Value` for version 0.1. Lossless JavaScript lone-surrogate JSON requires a separate boundary decision; this serde-based client rejects such frames rather than substituting characters.

## Scripted send and interrupt capability

`FixtureGuard::scripted_actions(&client)` returns `ScriptedActions` only when the Client belongs to that exact guard authority. Equal Project paths or PIDs do not authorize a different guard. The capability holds a weak reference to the existing Client connection. It opens no socket and does not retain the Client, including while a submitted action awaits its result. Dropping the last Client or explicitly disconnecting makes later calls fail with `Disconnected`. Explicit reconnect requires a new capability; the old one remains disconnected.

Both methods return executor-independent futures and use the Client's existing bounded I/O worker. They require no Tokio runtime on the caller's thread:

```rust,ignore
let actions = guard.scripted_actions(&client)?;
client.open_view(guard.project()).await?;
let snapshot = client.runtime_snapshot().await?;
// Apply snapshot.body to your reducer before releasing later events.
client.accept_snapshot(&snapshot).await?;
let receipt = actions.send(1, "Hello", "unique-client-message-id").await?;
let stop_receipt = actions.interrupt(1).await?;
```

`send(chat, text, client_message_id)` pins the generated Project, `provider: "kiro"`, `model: "scripted"` and `permissionMode: "ask"`. There are no provider, model, environment, path, steering, approval or raw request options. Chat IDs must be positive JSON-safe integers, text 1 through 2,048 UTF-8 bytes, and client IDs 1 through 128 UTF-8 bytes. Encoded argument JSON must fit 3,072 bytes, including escaped control characters and the generated path, leaving room for the RPC envelope within the fixture's 4,096-byte frame limit. These checks run before queue admission and return `InvalidInput {field, message}` without truncation or trimming. The normal per-connection frame limit also applies.

`interrupt(chat)` targets that Chat's active run when the owner dispatches the request. Protocol v1 does not bind it to a previously observed turn ID. Before explicit `open_view` on the same connection, both methods preserve remote `ISOLATED_SCOPE_ONLY`. Missing advertised methods return `Capability`. Neither call opens a view, reconnects, retries or replays. Dropping an unpolled future sends nothing; dropping a submitted future abandons only its local wait. A timeout with `submitted: true`, or a disconnected submitted call, is not evidence that the owner did nothing. A caller must reconcile state before deciding on another operation. Reusing an ID invokes owner idempotency rules; this client never retries on its own.

The raw owner receipt is preserved. In the actual fixture check, sends returned `{"sessionId":1}` / `{"sessionId":2}` and interrupt returned `null`. None is proof of terminal completion. Observe the subsequent owner events and transcript.

### Notification contract and actual fixture evidence

Actions use the same ordered Notifications stream and snapshot barrier as reads. Source ordering in `rust-runtime/src/actor.rs` publishes the command's owner notices before returning the command reply to the wire layer. On a new nonqueued send, the owner `message-sent` is thus enqueued before the send reply. Provider ticks can enqueue further events before or after that reply. Deferred state hydration and consumer scheduling can delay notification delivery past resolution of the action future. Consumers must use wire sequence and the accepted snapshot, not the order in which their futures wake.

The fixed Scripted provider's normal turn produces these `agent:event` types in order:

1. `message-sent` from owner admission, with state.
2. `session-started`, with state only when that event changes owner state. A populated Chat with the same native session ID omits it.
3. A second `message-sent` from the Scripted provider's explicit scheduled event, without state.
4. `text-delta` containing `Scripted isolated reply`, without state.
5. `turn-completed`, with state.

The repeated `message-sent` is fixture behavior, not a second persisted user message or a claim of real-provider parity. A `fixture:blocked-start` send produces owner `message-sent` and `session-started`; explicit interrupt produces `turn-cancelled`. Because this preset emits no text delta before interruption, it saves an assistant message with an empty body and outcome `cancelled`. This is not a rule that interruption discards already-streamed text. This preset does not produce `turn-started`. The actual public-API test asserts these filtered sequences exactly, the same-connection view refusals, increasing global wire sequence, transcript bodies/client IDs/outcomes and all cleanup flags. The normal and blocked sends plus interrupt produced run sequences 1 through 8 and global sequences 2 through 9 in the recorded run. Those absolute numbers are evidence, not fixed identifiers.

`project:open` on a newly ready Project can publish `project:state` before its reply; an already-ready Project may return without a new notice. The initial accepted snapshot covers any earlier publication. Persistence, unload and other Project broadcasts may add `project:state` among later events, so their count is not a per-send contract. The test retains their order but filters them when comparing the agent sequence. A `stateTooLarge` marker is hydrated under the existing bounded current-state contract; it is not a historical state at that event's sequence. The fixture evidence records event order and receipts separately. Physical reply/event interleaving is source-derived above, not measured by timestamps in the evidence log.

## Ordering, resync and failures

`Notifications` is one ordered consumer of `Notice::Event {wire_seq, scope: Option<String>, channel, payload}` and one terminal `Notice::Closed(error)`. Wire sequence must increase on a connection, but gaps are allowed. Events are held from handshake and whenever snapshot capture starts. Starting another snapshot also holds already queued, unread events.

`runtime_snapshot()` validates the manifest and body watermark. It does not release events. `accept_snapshot` requires the exact connection and latest capture generation, refuses foreign, altered-watermark and stale receipts, and prevents accepted watermarks from regressing. Accepting the same current receipt twice is a no-op. Equal watermarks across successive captures are valid when the daemon emitted no event. It discards held events at or below the accepted global watermark, then releases later events in arrival order as their state becomes available. Events arriving subsequently at or below the accepted watermark are also discarded. A higher run `seq` never affects this barrier. Concurrent captures serialize; a later capture invalidates every earlier receipt, including an earlier accepted one. Hold overflow produces one terminal Closed notice; it never silently drops events above the watermark while keeping the connection usable. A failed or timed-out capture keeps the hold until the caller explicitly captures and accepts a fresh snapshot or disconnects. Acceptance remains a queued local operation and can return Busy or expire behind wire work; a valid acceptance does not wait for its subsequent hydration read.

Result paging (`result-pages-v1`) is internal and accepts the wire's positive safe numeric or nonempty string page IDs. Snapshot paging (`snapshot-pages-v1`) is separate. Invalid page count, aggregate bytes, JSON, manifest identity and snapshot watermark mismatches fail without a partial result. The page reply has no echoed identity; only the requested manifest identity is validated. The whole operation, including queue wait and pages, shares one deadline. Once the original request returns a page manifest, even a later page timeout before its own write reports `submitted: true`. A timed-out submitted request may still have executed; its later response is ignored and nothing is retried.

Errors preserve `Remote {code, message, payload}`. Launcher failures retain a fixed `Launch {code, message}` classification. Local cases include `Disconnected`, `Busy`, `TimedOut {submitted}`, `Capability`, `Protocol`, `InvalidScope`, `StaleSnapshot` and `StateTooLarge {hydration}`. `Cancelled` is reserved for a future explicit local cancellation handle; dropping a future provides no result and only abandons its local wait. It does not free an admitted request early, cancel owner work, send a nonexistent cancel RPC, or trigger replay. Dropping an unpolled async call admits nothing.

### Deferred oversized Project events

An event carrying `stateTooLarge: true` stays in the bounded notification queue. While a snapshot is held, no hydration runs. A valid acceptance first discards covered events using the snapshot's actual `eventSeq`; a covered oversized marker therefore issues no read. The first remaining unresolved event blocks every later notification, including other scopes, so no terminal or streaming envelope overtakes it.

The existing I/O worker freezes the already queued prefix and performs one `project:read([ownedProject, {state:true}])`, including result paging. It validates the exact returned Project path and object state. Every same-Project state-bearing envelope in that frozen prefix receives the fetched state and loses `stateTooLarge`; all original global sequences, channels, other payload fields and envelope order remain. Unrelated and state-less envelopes are unchanged. The state replacement follows `apps/daemon/src/runtime-client.cjs`'s `release` and `experiments/rust-desktop/src/transport.rs`'s `hydrated_batch`, but this client preserves all envelopes instead of coalescing Project states and holds the entire global suffix instead of a per-Project subset. State-bearing events arriving during the read, even ones with a complete state, require a later hydration batch before delivery. This prevents an older queued full state from replacing the freshly fetched state.

The attached state is current deferred state, **not historical state at the envelope's `wire_seq`**. Project reads provide no event watermark. The client does not invent one, discard later events based on a read, or claim that hydrated payloads provide a global point-in-time snapshot. Only `runtime_snapshot` and its accepted receipt establish that barrier.

All frozen entries remain charged to the same queue count and byte limits. Replacement size is preflighted for the entire batch before cloning states into envelopes or publishing any of the batch. One batch runs between caller operations, so a sustained stream cannot starve queued capture or acknowledgment work. A live hydration deadline starts when its unresolved event is queued; snapshot-held events start their deadline only on acceptance. Waiting behind the current caller operation and all hydration pages consume that deadline. There is at most one internal read in addition to admitted caller operations, never a hydration thread per event or an unbounded task queue.

Any hydration failure, including remote refusal, missing method, timeout, invalid result, disconnect or expansion overflow, closes the connection once with the actual error and discards the unresolved suffix. An unsupported or foreign scope closes with `StateTooLarge`; it never authorizes a read outside the generated Project. No empty-state fallback is published. Reconnect and snapshot resync remain explicit. State patches, reduced Chat payload negotiation, computers, Links, remote endpoints and production authentication are not claimed. Existing Tauri transport has not been replaced.

## Bounds and worker lifetime

Defaults are at most 32 accepted caller operations (queued plus active), 16 MiB per wire frame, 1,024 queued/held events and 16 MiB serialized event bytes, 1,024 pages and 128 MiB assembled result bytes, and a 30-second operation deadline. Options may only reduce these bounds. Admission credit releases before reply publication, including rejection; a caller awakened by completion can immediately use the returned slot. This first engine serializes wire operations; it is not yet the Tauri transport's concurrent RPC multiplexer. Notification bytes include serialized event envelopes and hydrated state copies. Both notification and assembled-result bounds measure serialized bytes, not parsed heap allocation or process RSS. One bounded terminal error slot is additional to the event queue. Overflow closes the connection; an already released prefix remains ordered, while events held behind an unaccepted snapshot or unresolved hydration are discarded. Keep the Notifications consumer alive while using the Client; dropping it does not currently unsubscribe and unread events can still fill the bounded queue.

The socket worker owns no writer or child. Dropping the last Client sets stop and shuts down its exact socket without blocking the caller on a join. The worker retains authority until its reads/writes finish and its loop exits. An exit guard seals the socket and notification queue on normal return or panic unwinding. It emits one `Closed(Disconnected)` if no earlier cause was recorded, so a worker panic does not leave `Notifications::next` pending forever. This does not cover process abort or termination. I/O uses bounded timeouts; OS scheduling and a blocked filesystem remain outside wall-clock guarantees. The launcher connector has a three-second response bound and a 32-control queue. The worker is not a replacement for the retained-child supervisor. A dropped connection attempt also drops the eventual Client result and closes that socket. No background request or reconnect loop survives through a public discovery service.

## Validation and remaining work

Run `cargo test --offline --locked`, `cargo clippy --offline --locked --all-targets -- -D warnings`, `cargo fmt --check` in this crate. The ordinary suite has 56 passing tests, four compile-fail doctests and one ignored real-daemon test. Ignored is not passing evidence. Synthetic tests cover exact requests, read shapes, result/snapshot pages, snapshot receipt identity, monotonic global barriers, dropped waits, bounded admission, publish-after-credit-release, operation-level paging timeout accounting, late replies, remote refusals, overflow, covered-marker suppression, deferred hydration and its failure paths, frozen-prefix state replacement, global ordering, worker panic termination, fragmented frames, reconnect and local cleanup. Launcher tests cover acknowledged Pending, sticky Unknown, EINTR, no post-reap probe, path/socket/executable replacement, unsafe modes, exact peer PID mismatch, nonblocking/CLOEXEC setup, saturated-listener connect and shutdown deadlines, bounded receipt/deadline and explicit identity-checked storage cleanup. Compile-fail examples pin absent path/socket constructors and private snapshot receipts.

For the real macOS check, first have the runtime owner build `experiments/rust-runtime/target/debug/app-fixture` from the agreed source. Then run from the repository root:

```sh
python3 experiments/rust-daemon-client/scripts/check-owned-fixture.py
```

The script has no executable or profile override. It builds only this crate's test runner offline/locked, stages that runner beside the fixed runtime binary, records both SHA-256 hashes and the checkout HEAD (explicitly not a source-to-binary attestation), and runs exactly the ignored `launcher::tests::owned_fixture_end_to_end` test. The private staging directory is removed and a synthetic parent-HOME canary must remain unchanged. The fixture is never launched inside an installed app.

The real test covers all six reads plus explicit open, snapshot acknowledgment, socket-mode tamper refusal and restoration, reconnect to the same PID, and three private scripted sends that force result and snapshot paging beyond the runtime's 4,096-byte frame limit. This older hydration setup still uses a private test-only raw helper. The fifth child below independently tests the public ScriptedActions capability. While the original reader remains connected after accepting its snapshot, it observes three completed turns with state and at least one restored state body larger than the 4,096-byte frame limit, in increasing global sequence. It then checks transcript total six and the summary after reconnect, and requires stop acknowledgment, exit 0 and absence of daemon profile, socket and private launch root. A second child survives Client drop, accepts another reader, and cleans up after last-authority drop. A third real child is paused after receipt/peer admission and before result publication; dropping the launch waiter and releasing the test-only barrier must clean up without signals. A fourth child uses the populated preset: two real owner summaries (4 and 2 messages), titles/model/outcome/timestamps, discriminating before/turns/limit paging, snapshot-first admission, same-PID reconnect and complete cleanup with zero client sends. The runtime also has a deterministic no-actor test proving startup notices are drained before admission. Evidence markers report these checks separately. A fifth child uses the public capability for two sends and one interrupt, proves both pre-open refusals, exact real agent sequences, four stored messages, typed disconnect and complete cleanup. This is fixture compatibility evidence, not production-provider execution or native UI evidence.

Remaining gates: measured concurrent multiplexing; shared adoption by Tauri and the off-by-default GPUI adapter. Hydration failures still require explicit reconnect/resync. GPUI owns presentation DTO mapping and reducers, not endpoint authority. The separate default-disabled `owned-chat` capability now provides dedicated-runtime launch and typed Chat actions; [OWNED-CHAT.md](OWNED-CHAT.md) records fixed-native permission checks and root's real selected-account text/stream/save/cleanup acceptance. Full production account/profile adoption remains gated. Design/Artifact authoring follows the native content gate.

## Dedicated Sidebar actions (owned-chat, default off)

`OwnedChatGuard::sidebar_actions(&client) -> Result<SidebarActions>` mints another
weak capability only for that exact guard and Client. It uses executor-independent
futures and the existing bounded I/O worker, not a caller-thread Tokio runtime.
Every method requires this connection's explicit `open_view`, positive JSON-safe
numeric Chat ID, and the captured Project. It exposes no arbitrary patch, account,
model, Worktree, directory, delete/archive or caller-clock field.

| API | Exact `chat:patch` fields |
| --- | --- |
| `rename(chat, title)` | `{title}`; unchanged string, at most 16,384 UTF-16 units. Empty clears explicit title. |
| `mark_done(chat, true)` | `{done:true,unread:false}`; the backend supplies its clock and completes targeting routines first. |
| `mark_done(chat, false)` | `{done:false}`; no routine is restarted. |
| `keep(chat)` | `{kept:true}`; keeps a hidden Run Chat visible without storing `kept`. |
| `restore(chat)` | `{archived:false}`; restores and clears Done, never archives or deletes. |

Each request is `[captured_project, numeric_chat, fixed_patch]`; encoded arguments
must fit 128 KiB. Unicode titles are validated without truncation or trimming.
Ordinary Rust strings cannot carry lone UTF-16 surrogates. Unknown/absent Chat
validation and flush-before-success remain the backend's responsibility. Requests
against older runtimes preserve their remote refusal; method advertisement alone
does not establish that all these new patch fields are implemented.

Modern React pins remain device-local (`chat-pins.ts`). A frontend may use `keep`
when pinning a hidden Run Chat and keep its own pin ordering. This capability does
not expose legacy persisted `pinned`/`pin_order` as a new pin sync service.

Capabilities and submitted waits do not retain the Client. Dropping an unpolled
future sends nothing; dropping a submitted future cancels only its local wait.
Missing advertised `chat:patch` returns `Capability`; closed connections return
`Disconnected`. There is no retry, reconnect, implicit view open or replay. Remote
errors and arbitrary nested details are preserved unchanged. Direct metadata edit
failures remain errors. The dedicated backend returns the accepted Chat send
receipt after a later metadata-save failure and retains its persistence warning;
it does not make the unchanged frontend treat that accepted send as unsent.
Submitted transport failures still require status reconciliation before retry.

The six socketpair tests cover exact wire fields, UTF-16 boundaries and JSON-safe
Chat IDs, no enqueue on invalid/unpolled calls, guard mismatch, explicit view,
weak pending lifetime, missing capability, raw remote details and submitted timeout
without replay. These are client contract checks. They do not claim real backend
or frontend Sidebar adoption, device-local pin persistence, or installed UI proof.
