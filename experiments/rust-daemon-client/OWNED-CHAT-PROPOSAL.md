# Proposed dedicated Chat client capability

Negotiation with GPUI Chat 11899, round 1. This is a proposal, not an implemented
API or an agreed production cutover. Backend/root owns this crate and the launcher;
GPUI owns its adapter and presentation. Neither depends on the other frontend.

## Available baseline

- Shared client `9aa5deb3` has owned app-fixture launch, six reads, paging,
  explicit snapshot acknowledgment, ordered notifications and ScriptedActions.
  GPUI keeps that client and app-fixture SHA-256
  `51e90342bf427d7160ff658f7e5c73e50ed7d9b4dad8148b80cc7688bc36a15d` until a new
  separately validated pin is published.
- Backend/desktop `4e0ecb47c` has a dedicated persistent Rust runtime and actual
  native Claude send, stream, permission allow/deny, save and renderer reload
  evidence. Backend process restart/resume was accepted separately.
- There is no public shared-client owned-runtime capability yet. Uncommitted
  configured content work is not an adoptable checkpoint or live-content pass.

## 1. Owned launch and reads

Add an off-by-default `owned-chat` feature. Proposed method names:

```text
OwnedChatGuard::create(new_root, private_launch_manifest).await
OwnedChatGuard::open(marked_root).await
guard.connect(options).await -> (Client, Hello, Notifications)
guard.chat_actions(&client) -> ChatActions
guard.shutdown().await -> owned-runtime cleanup report
```

The runtime executable is the fixed sibling `chat-runtime`; there is no runtime
executable override, arbitrary socket/profile constructor or Node fallback.
Creation captures explicit Claude executable, account, model and nonsecret launch
paths from the validated manifest. Opening uses the saved selection, not a new
ambient account. Existing production profiles and arbitrary Projects are refused.
Create requires a nonexistent root; open requires this runtime's marked root.

Reuse the shared client's identity/peer checks, bounded connector and retained
child lifecycle. Preserve production-profile exclusions before clearing the child
environment. Do not copy the desktop launcher's different crash-signaling policy.
Cleanup reports distinguish removed temporary wire/launch storage from retained
durable data. Pending or unknown cleanup retains ownership; it never authorizes a
replacement writer. The exact configured-root and receipt checks need new tests.

All async calls work without Tokio on the caller's thread. A retained guard may
mint another connection to its own child. Attaching to an independently launched
process needs a later broker/authority contract. Initially Tauri and GPUI reuse a
dedicated root sequentially; a second owner is refused. This first stage uses real
Claude and persistent dedicated Chats, not imported production Chat history.

## 2. Chat actions on that connection

Proposed `ChatActions` methods, all async:

```text
send(ExistingChat(id) | NewProjectChat, text, client_message_id, options)
send_status(client_message_id)
interrupt(chat)
respond_permission(chat, request_id, AllowOnce | AllowForChat | Deny)
answer_question(chat, request_id, answers, summary)
set_permission_mode(chat, Ask | Auto | Full)
send_queued_now(chat, queued_id)
remove_queued(chat, queued_id)
mark_unread(chat, bool)
```

Stage 2a covers send/status, interrupt, permission/question answers and mode.
Stage 2b covers queue operations and unread marking. These runtime routes already
exist; the shared typed capability and its acceptance tests do not.

The guard pins Project, provider, account and model. Options carry bounded typed
ordinary turn settings, including effort, reply style and TLDR; they do not admit
raw RPC, alternate scopes or environment. Text, identifiers, answers and encoded
requests are bounded before enqueue under limits no larger than the runtime's.
New Project Chat means the owner's first-send behavior, including starter reuse;
it does not promise an empty persisted Chat per New Chat button click.

`allow-for-chat` is the existing wire decision, not global or permanent permission.
Model is currently fixed at launch. Effort changes on the next send; no standalone
live model/effort RPC exists. Attachments, compact, steering and new Worktree or
remote-computer Chats remain explicitly unavailable in this first capability.

Actions hold a weak reference to one exact Client and require its explicit
`open_view`. Reconnection requires a fresh capability and snapshot. Preserve
`ISOLATED_SCOPE_ONLY`, remote answer receipts and typed disconnects. Dropping a
future abandons only the local wait; timeout/disconnect after submission can mean
the write happened. No automatic retry, replay, reconnect or fabricated success.
Interrupt targets the active run at owner dispatch, as protocol v1 does today.
Permission/question replies report the owner's answer settlement; they do not
mean the turn completed. Resolution and turn-terminal events still arrive on
Notifications.
The existing snapshot barrier, wire sequence and separate run sequence remain.
Scripted duplicate `message-sent` behavior is not a real-provider event contract.

## 3. Content, then broader sidebar and terminal services

Promote Designs/Artifacts ahead of unrelated later integrations after the current
native content checkpoint passes. Proposed separate `ContentActions` methods are
`list`, `get`, `asset`, `comments` and `apply`, over the existing artifact routes.
Renderer edits retain version-conflict errors and the one shared MCP/content owner.
Creation, deletion, comment writes and exports need their own supported methods;
no generic content-RPC escape hatch is implied.

Broader sidebar writes need configured-runtime implementation first: Done/reopen,
pin/order, rename, hide and Links. Unread-only patch is already implemented.
Preserve Node persistence and refusal semantics; do not invent version/CAS or
idempotency guarantees for commands whose server has none. Delegations and
Worktree/computer creation remain separate ownership work.

Rust PTY and isolated terminal services exist, but configured `chat-runtime` does
not yet compose them. The later `TerminalActions` surface follows existing
`list`, `profiles`, `set_shell`, `open`, `read`, `input`, `resize`, `close` wire
operations. Reconnect uses retained terminal identity, subscription and bounded
`read(after, limit)` catch-up. There is no current `terminal:attach` RPC. Agree
output ordering, gaps, per-Chat authority and shutdown before this stage ships.
GPUI's interim local PTY does not become another production owner.

Git/PR, simulator relay, settings, account switching, other providers, existing
production-data adoption and phone integration follow separate service contracts.

## Acceptance and publishing

First validate the new shared public API against a fixed native provider child in
a separate dedicated-runtime staging suite. Keep existing app-fixture authority,
tests and pins unchanged. Then exercise the same public API with the explicitly
selected real account and inspect the persisted result and cleanup.

Required cases include second-writer and wrong-root/peer/guard refusal; cancelled
launch waits; retained pending shutdown; six reads and snapshot acknowledgment;
pre-open action refusal; exact send IDs/status and no replay; permission/question
settlement and stale answers; disconnect; streaming under the event barrier; and
stop/reopen preserving transcript while changing the wire epoch. Native GPUI
composer/card behavior is a separate GPUI acceptance check.

Backend/root publishes a committed client revision, dedicated runtime binary hash,
contract and logs per accepted stage. No new runnable client pin is supplied by
this proposal. Tauri adoption stays independent and must preserve the same owner
and protocol contracts. Production host replacement is not authorized here.
