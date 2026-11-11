# Rust owner storage: read-only foundation

`milagre-owner-store` reads a Milagre Project's saved state in Rust and answers a few daemon commands from it, byte for byte as the Node daemon does. It is stage 2 of the backend migration plan (Rust service foundations, read-only first). **It does not migrate the backend**: the Node daemon still owns and writes every Project, and nothing here writes, locks or runs beside it as a second writer.

## What it reads

| Rust                                                         | Node it mirrors                                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `ChatDb` (`MessageRepository`)                               | `packages/core/src/chat-db.cjs`: every reader, same SQL, same row order                   |
| `ProjectStore::read_project_state`                           | `project-store.cjs` readProjectState (suggestions dropped, rows read, subagents hydrated) |
| `ProjectStore::with_details`                                 | `project-content.cjs` withDetails                                                         |
| `ProjectReader::chat_messages` / `chat_page`                 | `chat:messages` (runtime.cjs, unopened-Project path) and `chat-pages.cjs` chatPage        |
| `ProjectReader::chat_message`                                | `chat:message`: findMessage + withDetails                                                 |
| `ProjectReader::send_status`                                 | `chat:send-status`: ChatHost.sendStatus receipts (saved message, then queued entry)       |
| `MessageRepository::read_chat_previews`                      | inbox previews (message-store.cjs inboxState)                                             |
| `ownership::inspect`                                         | `ownership.cjs` staleOwner / abandoned, inspection only                                   |
| `write::{MessageStoreWriter, ProjectStateWriter, OwnerLock}` | Contracts of writeMessages, saveProjectState, acquireOwnership. **Not implemented.**      |

Results are `serde_json::Value`s in the daemon's shapes. `jsjson::to_string` writes them as `JSON.stringify` does: integer-like keys first (sessions are keyed by number), ECMAScript number formatting (`1e+21`, `1e-7`), the same string escapes. Previews keep UTF-16 so a cut through an emoji comes out as Node's lone `\ud83d`.

Two things Node does on read are writes, so they happen differently here:

- chat-db.cjs runs `CREATE TABLE IF NOT EXISTS` on every open. Rust opens `mode=ro&immutable=1` (no lock, no file created) and reads a database without the table as empty.
- readProjectState ends with compactDetails, which moves long step details of old states into new sidecars. Rust does the same compaction in memory: the state matches Node's, and the sidecars Node would write come back in `ProjectStateRead::pending_sidecars` for a later writer to persist. `pending_detail_compaction` lists the affected messages.

## Running it

```sh
cd experiments/rust-owner
cargo test                                   # unit + conformance (467 Node-recorded cases)
node fixtures/generate.cjs --check           # Node side: do the committed fixtures still match current Node?
node fixtures/generate.cjs                   # regenerate fixtures after a deliberate format change, then cargo test

# Audit or read an explicit copy, never a Project in use:
cp -R ~/Code/some-project/.milagre /tmp/copy/some-project/.milagre   # leave runtime.lock and images out if you like
cargo run --release -- audit /tmp/copy [--json] [--allow-copied-lock]
cargo run --release -- read /tmp/copy/some-project state
cargo run --release -- read /tmp/copy/some-project chat:messages 12 --turns 2
cargo run --release -- read /tmp/copy/some-project chat:message 345
cargo run --release -- read /tmp/copy/some-project chat:send-status <clientMessageId>
cargo run --release -- read /tmp/copy/some-project previews 1 2 3

# Compare against Node on a real copy (made without runtime.lock):
node fixtures/node-cases.cjs /tmp/copy/some-project /tmp/cases.json
MILAGRE_OWNER_COPY=/tmp/copy/some-project MILAGRE_OWNER_CASES=/tmp/cases.json cargo test --release -- --ignored live_copy
```

Node 24 is required for the fixture scripts (node:sqlite). They resolve `@milagre/shared/*` to `packages/shared/src` themselves, so they run in a Worktree without `node_modules`.

The audit refuses a folder inside Milagre's data folder, and a Project whose `.milagre/runtime.lock` names a running owner unless `--allow-copied-lock` says the lock came along with a copy. It fingerprints every file before and after and fails if anything changed. It reports orphan Chat rows, rows without a Chat, position gaps or duplicates, payloads serde can't read, column/payload mismatches (`id`, `session_id`, `client_message_id`, `operation_id`), repeated clientMessageIds, `next_id` behind the rows, unreadable detail or subagent sidecars, pending detail compaction, and runs `chat:messages` for every Chat plus the previews.

## Conformance evidence

- `fixtures/generate.cjs` builds six Projects with the real Node writers (saveProjectState, including a renumbering save, detail and subagent sidecars), then edits rows by hand to reach states older releases and crashes leave: position gaps, an orphan Chat, a NULL session, a non-string body, a row without a role, a missing and a wrong-hash sidecar, inline legacy messages, inline details still to compact, a marker without chats.db, a folder without state. Node then answers 467 cases on throwaway copies (readers with five Chat sets, lookups, pages with four option sets and four cursors on both the opened and unopened paths, chat:message, send-status, errors). `tests/conformance.rs` replays each and compares bytes; an unknown case fails the test. It also hashes every fixture file before and after.
- A plain `cp` of this repository's own Project (`.milagre`: 17 MB chats.db, 39 Chats, 684 rows) matched Node on 221 cases, including the whole readProjectState output (10 MB of JSON), every Chat's pages, previews, 60 receipts and 80 chat:message reads. That copy isn't committed.

Recorded with Node 24.13.0 (its SQLite 3.50.4); the crate bundles SQLite 3.50.2.

## Limits

- **Read-only, files only.** Answers equal Node's when the saved files are all there is. A Project open in a running daemon can hold changes not yet saved (250 ms write-behind), sends in flight (sendStatus waits for them) and streaming runs that aren't messages yet. Reading a live chats.db with `immutable=1` can see a write half done; only copies are supported, and a hot `-journal`/`-wal` beside the file is refused.
- **No ProjectStates.** Lazy unloading, touches, sweeps, settle, the whole-state cache and the daemon's message patches are in-memory policies of the single writer and aren't ported. `unloadedAfterRead` is the one Node case the tests skip for that reason.
- **Commands not ported:** `chat:search` (scoring lives in `packages/shared/src/message-search.mjs`), `chat:all-messages`, `chat:subagent`, the full inbox projection, attachment access. Their storage reads exist (`read_chat_marks`, `read_chat_bodies`, `read_chat_rows_containing`, `read_chat_previews`).
- **Scopes:** a Project path only. Link scope keys, the chats home and the "is this Project known" registry check of `chat:messages` aren't handled.
- **Text Node can hold and Rust can't:** a payload with an unpaired `\udXXX` escape fails serde_json and that read errors; Node reads it. JSON syntax error messages differ from Node's; I/O errors match Node's text for ENOENT, EACCES, EISDIR, ENOTDIR and ELOOP.
- **Ownership** is inspection only, macOS/Linux (`ps -o lstart=`); the Windows PowerShell probe isn't ported. Nothing acquires, takes over or releases a lock.
- **Writes** are contracts in `src/write.rs` and nothing more. The next step is a `MessageStoreWriter` checked against writeMessages on fixture copies (positions, renumbering, keep/drop), before anything owns real data.
