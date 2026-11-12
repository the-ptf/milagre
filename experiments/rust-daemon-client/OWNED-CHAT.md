# Dedicated Chat client, default-disabled checkpoint

Enable `owned-chat` to use `OwnedChatGuard`, `ChatActions`, `TerminalActions` and `GitReads`. They have no Tauri,
GPUI or caller-thread Tokio dependency. The existing fixture API stays unchanged.
This connects a persistent dedicated Rust Project, not an installed production
profile or arbitrary existing daemon. It does not complete the backend migration.

## Launch, reads and lifecycle

```rust,ignore
let guard = OwnedChatGuard::create(new_root, private_launch_manifest).await?;
// Later, after confirmed prior shutdown:
// let guard = OwnedChatGuard::open(marked_root).await?;
let (client, hello, mut notifications) = guard.connect(ClientOptions::default()).await?;
client.open_view(guard.project()).await?;
let snapshot = client.runtime_snapshot().await?;
// Apply snapshot.body to the frontend reducer first.
client.accept_snapshot(&snapshot).await?;
let actions = guard.chat_actions(&client)?;
```

The executable is the fixed sibling `chat-runtime` of the caller's executable.
Its parent and file must be owned by the same uid, non-writable by group/others,
and pass pinned identity checks; the executable must have only one hard link. The runtime's
receipt is bounded and tied to its exact PID, root, configured Claude provider,
account/model and derived private socket. Every connection verifies peer uid/PID
and rechecks pinned root, manifest, executable, Project and socket identities.

`create` requires a nonexistent root and an explicit absolute, single-link,
uid-owned 0600 launch JSON of at most 32 KiB. The runtime validates all launch
fields and stores the selected account/model and nonsecret paths. The captured
input is compared to the runtime's saved launch configuration before publishing
the guard. `open` requires the dedicated marked 0700 root and unchanged 0600
saved manifest. In-place manifest changes, replacement and symlinks refuse.
If the exact fixed child cannot start, it may instead emit one bounded, closed
startup-refusal record on stdout. `Remote {code: "CHAT_ROOT_BUSY", ..}` means the
dedicated root already has a writer, rather than a receipt EOF failure. Other
startup failures use `CHAT_RUNTIME_START_FAILED` with a fixed safe message, never
raw provider/account/install diagnostics. PID, uid, protocol, requested root,
executable and captured selection are rechecked. This record grants no endpoint
authority and is not proof of child termination. The existing supervisor retains
the rejected child and temporary launch storage until an actual reap; wait errors
remain sticky Unknown. It never removes the active owner's root/profile/socket.
Production profile exclusions are captured before the child's environment is
cleared. Neither account discovery nor secrets are read by this client.

`guard.connect` explicitly opens/reopens a connection to its own retained child.
It never starts another process or attaches by path/socket/PID. The same `Client`
provides all existing reads, paging and snapshot/notification behavior. A second
independent guard for a running root is refused by the owner. Tauri and GPUI may
reuse a dedicated root sequentially; simultaneous cross-process adoption needs
a separate broker/authority contract.

`guard.shutdown()` reports `OwnedChatShutdown::{Complete,Pending,Unknown}`. Complete
contains the existing temporary profile/socket/launch cleanup flags, exit code,
stop acknowledgment and separately observed `data_retained`. No durable root is
ever removed by the client. A Pending result retains ownership and includes the
supervisor's diagnostic reason; this first report preserves stop refusals as
text, rather than a new structured stop-error API. Re-observation is explicit.
Unknown never permits signaling, storage cleanup or a replacement owner. Last
authority drop requests stdin EOF when Stop has not already been acknowledged;
the retained supervisor waits for actual reap and never sends a signal.

## Connection-bound writes

`guard.chat_actions(&client)` checks exact authority identity and returns a weak
capability. It cannot retain the Client, including while an admitted call waits.
After disconnect/drop it returns `Disconnected`; reconnect needs a new capability.
Writes require that this exact Client completed `open_view`, independently of
whether a read happened to establish a backend view. Otherwise they return local
`ViewNotOpened` without sending an RPC. Backend `ISOLATED_SCOPE_ONLY` and other
remote errors still retain code, message and full payload.

Available methods:

| Method | Wire behavior |
| --- | --- |
| `send(target, text, client_message_id, options)` | Existing positive numeric Chat or `NewProjectChat`, using owner starter reuse/creation on first send. Pins Project, worktree 1, Claude, account and configured model. |
| `send_status(client_message_id)` | Existing owner status, no fabricated receipt or retry. |
| `interrupt(chat)` | Active run at dispatch time, as protocol v1 defines. |
| `respond_permission(chat, request_id, decision)` | `AllowOnce`, `AllowForChat`, `Deny` map to `allow`, `allow-for-chat`, `deny`. Chat-wide is not global/permanent permission. |
| `answer_question(chat, request_id, answers, summary)` | Optional map of question IDs to string choices/free text; None declines. No image/secret/bug-report APIs. |
| `set_permission_mode(chat, mode)` | Existing Ask/Auto/Full owner operation and settlement. |
| `send_queued_now(chat, queued_id)` | Existing owner queue-send behavior, including stopping a running turn when required. |
| `remove_queued(chat, queued_id)` | Existing owner queue removal and actual boolean result. |
| `mark_unread(chat, bool)` | Configured runtime's persisted unread-only patch. |

`SendOptions` defaults to Ask, concise replies, TLDR on, no effort override, fast
mode/ultracode off and no explicit queue request. Effort is bounded to 32 lowercase
ASCII letters, digits, hyphens/underscores. It applies on the send; there is no
live model/effort setter. Model is immutable for this launched selection.

All bounds run before enqueue. Text is 1 through 65,536 UTF-8 bytes; Chat IDs are
positive JSON-safe integers; client/request/queue/question IDs are 1 through 128
UTF-8 bytes without NUL. Question summary is at most 64 KiB; at most 20 questions
with 20 answers of at most 10,000 UTF-8 bytes each are admitted. Encoded arguments
must fit 256 KiB, so escaping can refuse an otherwise individually valid payload.
No string is silently trimmed or truncated. These limits are stricter than the
backend; its own native-frame and service bounds still apply.

The existing bounded I/O worker executes every action. Dropping an unpolled future
sends nothing; dropping a submitted future abandons only its local wait. Submitted
timeouts/disconnects remain uncertain, with no automatic resend, replay, reconnect
or cancellation claim. Answer replies report owner settlement, not completion of
the model turn. The accepted snapshot barrier and ordered Notifications carry
streaming, permission resolution and terminal events; run seq stays distinct from
global wire seq. The fixed provider's tested event sequence below is evidence for
that fixture, not an event list promised for every real-provider turn.

Attachments, compact, steering, new Worktree/computer Chats, account/model switching,
broader sidebar writes, content capabilities, Git mutations/PR actions and production-data adoption
remain separate checkpoints. TerminalActions below is its own capability. This
API contains no raw RPC method.

## Validation

```sh
cargo test --offline --locked
cargo test --offline --locked --all-features
cargo clippy --offline --locked --all-features --all-targets -- -D warnings
cargo fmt --check
python3 scripts/check-owned-chat.py
```

The staging script builds the dedicated test backend in this crate's ignored
`target/owned-chat-backend`, never the shared app-fixture or normal chat-runtime
output. It stages only its exact binaries and the client runner, records their
hashes, and removes the stage. The synthetic parent-HOME canary stays unchanged.
No real provider/account or production profile is used.

The first actual-process test uses the public create/open/connect API with explicit
synthetic account metadata and never launches a provider. Six reads, pre-view
refusal, same-child reconnect, second-writer refusal, new wire epoch, unchanged
empty state, two clean exits and retained durable data are asserted.

The second test uses a private test-only fixture launch mode that public constructors
cannot select. Public ChatActions run one fixed native child turn: new Project Chat,
duplicate send/status without replay, actual Bash approval, two text deltas and
completion, exact persisted two-message transcript, unread marking, daemon restart,
retained summary/native session/preferences/transcript, stale answers, interrupt
and missing queue behavior. Shutdown recovery clears a transient `suggestionTurnId`;
this test compares persisted transcript, summaries/preferences, next_id and Worktree,
not exact equality of that transient session marker. Both children exit 0 with all
temporary cleanup flags and data retention true. Questions/mode/queue full wire
shapes also have synthetic contract tests; a real native question, mode switch and
nonempty queue lifecycle are not claimed by these new process checks.

The third process test exercises the seven public TerminalActions routes against
one fixture-configured runtime without launching a provider. It explicitly opens
separate control/read Clients, applies and accepts each snapshot, opens the
daemon's `/bin/sh` PTY, proves actual octal-encoded shell output rather than input
echo, resizes to 120x42, reconnects a third reader to the same owner for catch-up,
observes `terminal:changed`, closes the terminal, rejects subsequent input, and
requires Complete cleanup with retained data.

Eight terminal socketpair tests cover all exact route shapes, scope, limits,
pre-open refusal, weak lifetime, missing capability, remote/timeout uncertainty,
snapshot-held notices, and a forced blocked read on a second connection while
control input completes on the first. The existing single-Client I/O worker
serializes RPC, so a long-poll read on the control Client blocks input/resize/Chat
actions. The caller must explicitly create the second connection through the same
guard, open/apply/accept on both, and drain both notification queues. There is no
implicit connection or multiplexing claim. Full signatures and bounds are in
[CONTRACT.md](CONTRACT.md#dedicated-terminal-actions-owned-chat-default-off).

The fourth process test uses a generated dedicated Project with no provider
execution. It observes repository absence through all four GitReads routes, then
uses the existing real PTY to initialize a synthetic local repository with an
explicit private HOME and synthetic author/committer identity. It compares actual
changes, history, uncommitted and full-commit diff-file/diff-files, an untracked
patch and unchanged working bytes, closes its PTY and requires Complete cleanup.
The stage observes six admitted daemon children and six cleanup records across
four tests. Two further startup attempts prove public typed Busy refusal and
an observed rejected child's launch-storage cleanup, while the first owner stays
usable and its data/profile/socket remain. Six Git socketpair tests cover exact supported wire options/captured cwd,
authority/view/disconnect gates, boundary validation, absent capability, weak
pending lifetime, exact remote errors and submitted timeout without replay.
Signatures and bounds are in
[CONTRACT.md](CONTRACT.md#dedicated-git-reads-owned-chat-default-off).

The fixed turn observed `message-sent`, `turn-started`, `session-started`,
`permission-request`, `permission-resolved`, two `text-delta` events and
`turn-completed`, with increasing wire sequence after the accepted snapshot.
## Real selected-account acceptance

Root also ran the public API through `examples/owned_chat_live.rs` with real
Claude Code and the previously selected account on a dedicated Project. One
Ask/default-settings send streamed the random marker `SHARED_RUST_LIVE_7a09c3`,
completed, and persisted exactly two new messages (total 2 to 4). The real owner
send-status receipt matched. No tool, signal, retry or replay was used. Fourteen
pending shutdown observations preceded confirmed exit 0, Stop acknowledgment,
removed profile/socket/launch storage and retained durable data.

Evidence: `/tmp/milagre-owned-chat-root-live.log` and
`milagre-owned-chat-live-stage-00fu3_3j/report.json` under the private system
temporary directory. The staged runner SHA-256 was
`af3f625c810fa8436a88d294ab6c213dd1f2c46895b575a76ce3d2d1334eec22`;
the normal configured runtime was
`c4a6c25ac01c44312b33b1db7963d16f99ddba0f3e9feba907fa5b60ceda2ea5`.
That runtime includes the content/late-cleanup checkpoint but does not install
the later in-progress terminal/Git services. These hashes identify tested
binaries, not a clean-source build attestation.

This adds real text/stream/persistence/cleanup evidence for the shared API.
Permission settlement remains fixed-native evidence in this new client suite;
real native permission buttons were accepted separately by the desktop. Real
questions, live mode switches, nonempty queue lifecycle, native GPUI adoption and
existing production-profile adoption remain required.

## Sidebar capability

`guard.sidebar_actions(&client)` adds typed rename, Done/reopen, keep and restore
for the exact opened connection. See [CONTRACT.md](CONTRACT.md#dedicated-sidebar-actions-owned-chat-default-off).
It is weak like ChatActions and has no raw patch/clock/path escape hatch. Current
frontend pin state remains local; `keep` only reveals a hidden Run Chat. Legacy pin
fields are not presented as a synchronization service. Older dedicated runtimes
can advertise `chat:patch` while admitting only unread; their field refusal stays
visible. Pair this API with a backend that implements CONFIGURED-SIDEBAR.md before
adopting it. No app, production profile or real provider is run by these tests.
