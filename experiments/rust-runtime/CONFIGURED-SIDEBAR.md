# Dedicated runtime Chat metadata

The `chat-runtime` feature extends its existing `chat:patch` command for the one acquired dedicated Project. It does not change the default daemon or app-fixture API. Tauri and GPUI can share this backend; no frontend dependency is introduced. A typed public shared-client capability and frontend adoption remain separate work.

## Admitted commands

After this connection explicitly opens the configured Project:

```js
client.call("chat:patch", [project, numericChatId, {title: "Renamed"}]);
client.call("chat:patch", [project, numericChatId, {done: true, unread: false}]);
client.call("chat:patch", [project, numericChatId, {done: false}]);
client.call("chat:patch", [project, numericChatId, {pinned: true, pin_order: -1}]);
```

The nonempty object admits only these fields, at most seven together:

| Field | Accepted value | Saved behavior |
|---|---|---|
| `title` | String, at most 16,384 UTF-16 units | Empty string removes explicit title. Nonblank JS-trim title keeps a hidden Run Chat. |
| `done` | Boolean | True stamps `done_at` from the owner clock; false removes it. No caller clock accepted. |
| `unread` | Boolean | False removes the field; true persists it. |
| `pinned` | Boolean | Legacy persisted pin; true also keeps a hidden Run Chat. False removes field. |
| `pin_order` | Finite number | Legacy persisted ordering, including zero and fractional values. |
| `archived` | False only | Restore removes archived and Done marks, and keeps a hidden Run Chat. |
| `kept` | True only | Explicitly keeps a hidden Run Chat; no persisted `kept` field. |

**Modern production React pins are device-local** (`chat-pins.ts`). Persisted `pinned`/`pin_order` are compatibility fields, not a replacement pin synchronization service. Pinning a hidden Run Chat sends `kept:true`. A frontend must retain its own pin policy.

Every unknown/mistyped field, `archived:true`, `kept:false`, raw `done_at`, null title, empty patch, extra argument, unsafe/nonpositive/noninteger Chat id and absent Chat refuses. No account, model, directory, Worktree, Link, delete or arbitrary patch authority is exposed. Node coerces or ignores some malformed inputs; this bounded typed subset refuses them before writes.

## Ownership and side effects

The existing Project writer handles the edit and flush before success. Metadata-only changes do not change summaries or message activity timestamps. No-op edits do not publish new Project state. A failed flush keeps the owner's dirty state and persistence diagnostics, returns failure, and an unchanged retry still flushes before success.

Done first completes all currently listed routines targeting this exact Chat with reason `chat done`, using the same acquired durable routine writer. It queues `routines:changed` when any matched. Only then does it save Project metadata, matching Node's ordering. The routine and Project files are not a cross-store transaction: a later Project failure does not undo a completed routine. A denied routine owner prevents the Project edit. A temporarily restored authority does not clear an uncertain routine writer automatically; close/reopen is required.

Done does not archive, delete, stop an active native turn, close a PTY or revoke content membership. Reopen removes the Done mark; it does not restart completed routines. Successful user sends to an existing Chat remove Done and keep a hidden Run Chat before the send reply. The provider send is already accepted at that point. If this later metadata save
fails, the send still returns the accepted receipt like Node; rejecting would make
the unchanged React composer/outbox mark an accepted message unsent. The actual
owner keeps its dirty state and persistence warning. A bounded actor diagnostic
is retained through ordinary publication even for a pre-install refusal. No resend
or second provider start is performed. Direct `chat:patch` failures still reject.

A deterministic test accepts the real owner send first, then substitutes a
directory for coordination.json before the metadata flush. It requires a fulfilled
receipt, exactly one new user message in SQLite and one new provider turn, retained persistence/error
diagnostics, unchanged direct-edit refusal behavior, successful identical dirty
retry after repair, and failed shutdown retaining its Project lock until repair.


## Evidence

`fixtures/chat-patch-node.cjs` executes the actual `sessionPatch`, `patchChat`, `keepRunChat` and command registration source extracted from the production Node runtime, with explicit writer/state/clock doubles and the real shared reducers. Source-boundary drift fails rather than selecting a copied implementation. It never starts the Node daemon. The pure differential runs 14 edits, both hidden-Run and ordinary metadata, JS whitespace, Unicode, zero host clock and immutable transcript/summary checks.

`tests/configured-sidebar.cjs` uses the production Node wire client against two dedicated Rust runtime lifetimes and its fixed fake native child. It compares admitted edits with that actual Node-handler oracle; verifies coordination bytes before replies, invalid edits without file changes, persisted routine completion, automatic reopen on send, metadata edits during a pending native approval without changing active runs, retained content and a real daemon PTY across Done, transcript/metadata/content after restart, and normal child/profile/socket/Project-lock cleanup. No real provider, account credentials, production Project or installed app is used.

The runtime unit tests additionally exercise rejected Project commits, retained dirty flush retry and a revoked routine owner. The latter verifies unchanged durable bytes on refusal and explicit close/reopen before a later successful Done.

Run from this crate, with Node dependencies available:

```sh
cargo test --locked --offline --features chat-runtime-fixture
cargo clippy --locked --offline --features chat-runtime-fixture --all-targets -- -D warnings
cargo test --locked --offline --lib
cargo fmt --check
```

Root review, typed client/UI wiring, installed native behavior, full daemon service adoption and migration of existing production data remain required. No production-readiness or full Rust migration claim follows from these tests.

### Local validation checkpoint

With `NODE_PATH=/Users/victor/Code/personal/milagre-ade/node_modules` and an isolated Cargo target `/tmp/milagre-sidebar-runtime-target`:

- Full `chat-runtime-fixture` suite: 129 tests pass, including 71 library tests and the new actual wire/restart test (`/tmp/milagre-sidebar-full.log`).
- Default library: 37 tests pass (`/tmp/milagre-sidebar-default.log`). The first attempt omitted `NODE_PATH` and five existing Node-client tests failed module resolution; rerun with the explicit dependency path passed.
- `chat-runtime-fixture` strict all-target Clippy passes (`/tmp/milagre-sidebar-clippy.log`). Normal `chat-runtime` binary check passes (`/tmp/milagre-sidebar-normal.log`).
- Rust formatting, both new JS files' lint and formatting, and whitespace checks pass.

The first PTY assertion compared its mutable shell title and failed when startup changed `sh` to `bash`. The corrected test checks the unchanged PTY identity, directory and dimensions, then actual input/read/close. A test-only clock initially advanced from zero to an epoch-sized timestamp and stalled its existing timer stepping; the exact isolated test process was terminated and the injected test clock changed to 1000. No pattern kill or installed process was used.
- Scheduler composition: `routine-execution-fixture` library suite passes all 82 tests (`/tmp/milagre-sidebar-routine-fixture.log`).


Post-acceptance fix checks: 130 feature tests (72 library tests), strict all-target Clippy, normal `chat-runtime` library check, formatting and whitespace checks pass. Logs: `/tmp/milagre-sidebar-postsend-{focused,full,clippy,normal}.log`. The final focused run also checks the actual SQLite row count (`/tmp/milagre-sidebar-postsend-disk-focused.log`).
The first focused attempt lacked a native session id in its mock seed and correctly
hit the separate handoff-restore gate; the corrected test explicitly retains that
mock identity before its second turn. No restore gate or real provider is enabled.
