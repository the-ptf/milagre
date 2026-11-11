# Rust owner storage: reads, and writes for isolated copies

`milagre-owner-store` reads a Milagre Project's saved state in Rust and answers a few daemon commands from it, byte for byte as the Node daemon does. It also writes a Project the way the Node owner does (chats.db rows, coordination.json, sidecars, the owner lock), **but only inside an isolated copy folder**. This is stage 2 of the backend migration plan (`experiments/rust-desktop/BACKEND-MIGRATION.md`): Rust service foundations, checked against the Node implementation before anything owns real data. **It does not migrate the backend**: the Node daemon still owns and writes every real Project, and nothing here can write a live profile or Project, take a live lock, or run as a second writer beside a Node owner.

## What it reads

| Rust                                         | Node it mirrors                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ChatDb` (`MessageRepository`)               | `packages/core/src/chat-db.cjs`: every reader, same SQL, same row order                   |
| `ProjectStore::read_project_state`           | `project-store.cjs` readProjectState (suggestions dropped, rows read, subagents hydrated) |
| `ProjectStore::with_details`                 | `project-content.cjs` withDetails                                                         |
| `ProjectReader::chat_messages` / `chat_page` | `chat:messages` (runtime.cjs, unopened-Project path) and `chat-pages.cjs` chatPage        |
| `ProjectReader::chat_message`                | `chat:message`: findMessage + withDetails                                                 |
| `ProjectReader::send_status`                 | `chat:send-status`: ChatHost.sendStatus receipts (saved message, then queued entry)       |
| `MessageRepository::read_chat_previews`      | inbox previews (message-store.cjs inboxState)                                             |
| `ownership::inspect`                         | `ownership.cjs` staleOwner / abandoned, inspection only                                   |

Results are `serde_json::Value`s in the daemon's shapes. `jsjson::to_string` writes them as `JSON.stringify` does: integer-like keys first (sessions are keyed by number), ECMAScript number formatting (`1e+21`, `1e-7`), the same string escapes.

Two things Node does on read are writes, so the plain readers do them differently:

- chat-db.cjs runs `CREATE TABLE IF NOT EXISTS` on every open. The readers open `mode=ro&immutable=1` (no lock, no file created), read a database without the table as empty, and refuse a hot `-journal`/`-wal`.
- readProjectState ends with compactDetails, which moves long step details of old states into new sidecars. The readers do that compaction in memory: the state matches Node's, and the sidecars Node would write come back in `ProjectStateRead::pending_sidecars`. The owner's `load` writes them, as Node does.

## What it writes (isolated copies only)

| Rust                                                         | Node it mirrors                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `Isolation::create` / `open` / `copy_project`                | (no Node counterpart) the only folders anything here writes in                                                     |
| `OwnedProject::open` / `release`, `ownership::RustOwnerLock` | `ownership.cjs` acquireOwnership / release: same lock path, mode, `owner.json` format and token check              |
| `MessageStoreWriter::write_messages`                         | `chat-db.cjs` writeMessages: one transaction, positions, upserts, keep/drop, renumbering, rollback                 |
| `ProjectStateWriter::save_project_state`                     | `project-store.cjs` saveProjectState: images, detail and subagent sidecars, suggestions, rows, atomic JSON, sweeps |
| `OwnedProject::load`                                         | readProjectState as the owner: hot journal rolled back, compaction sidecars written, saved rows reset              |
| `OwnedProject::send_status`                                  | ChatHost.sendStatus over what is saved: a resend with a known clientMessageId finds its message                    |

**Isolation.** An `Isolation` is a folder holding a `MILAGRE-ISOLATED-COPY` marker, made only in a new or empty folder. Creating or opening one is refused when the folder is inside or contains Milagre's data folder (`~/Library/Application Support/Milagre`, `~/.config/Milagre`, `$MILAGRE_DATA_DIR`), `~/.milagre` (Worktrees, chats home, routines), or a Project or Link listed in `project-registry.json` / `recent-projects.json`. Opening one is also refused while any folder in it has a `.milagre/runtime.lock`. `OwnedProject::open` only takes a folder inside an `Isolation`. `copy_project` copies a Project's `.milagre` with plain reads (no SQLite lock), leaves out `runtime.lock`, `runtime/` and temporary files, and refuses a source mid-transaction.

**Locks.** The Rust owner takes `<project>/.milagre/runtime.lock` exactly as Node does (`mkdir` 0700, `owner.json` 0600 written exclusively, `JSON.stringify(owner, null, 2)`, release only with its own token), so Node and Rust owners exclude each other. It records `processStartedAt` from `ps` (whole seconds, never later than the real start), so Node's staleOwner reads a live Rust owner as live. **Deliberate deviation:** Node takes over a lock whose owner has certainly exited (and an empty lock older than a minute). The Rust owner never takes a lock over. It refuses `live`, `stale` and `abandoned` locks alike, and says which, so removing a dead owner's lock stays an operator's decision.

**Identity vs value.** Node's writeMessages skips a row when the message _object_ is the one it saved; Rust compares _values_. A Node save of an equal but new object rewrites the row with the same bytes; Rust skips it. The disk ends the same and `rowsWritten` can be lower. The conformance harness carries saved objects forward as the daemon does, so the counts match there.

## Unpaired surrogates

JavaScript strings can hold half a surrogate pair (a `slice` through an emoji). `JSON.stringify` writes it as `\ud83d` and `JSON.parse` reads it back; serde_json refuses it and a Rust `String` can't hold it. `jsjson::parse` (used for every coordination.json, sidecar and chats.db payload) now keeps it without loss. Inside the `String`, an unpaired surrogate `s` is U+10FFFE followed by `char(0xF0000 + s - 0xD800)`, and a real U+10FFFE is doubled. The mapping is injective. `jsjson::to_string` writes `\udxxx` back, `utf16_len`, `to_utf16` and `from_utf16` work on the JavaScript string (detail lengths, `slice(-1000)` of subagent text), and `to_sqlite_text` binds what node:sqlite binds (U+FFFD for the unpaired half).

What remains different:

- A `Value` holding such a string shows the two marker characters to Rust code that reads it as text; use the `jsjson` helpers.
- SQLite text columns (`client_message_id`) hold U+FFFD for an unpaired surrogate in Node too, so two clientMessageIds that differ only in which unpaired surrogate they hold collide in a column lookup, in Node's findRow and here alike.
- Invalid UTF-8 bytes in a file are read as U+FFFD, like Node's `readFile(…, "utf8")`.

## Running it

```sh
cd experiments/rust-owner
cargo test        # unit, read conformance (620 Node cases), writer scenarios (93 steps vs Node), locks, CLI
node fixtures/generate.cjs --check           # do the committed read fixtures still match current Node?
node fixtures/generate.cjs                   # regenerate after a deliberate format change, then cargo test

# Read or audit an explicit copy, never a Project in use:
cargo run --release -- audit /tmp/copy [--json] [--allow-copied-lock]
cargo run --release -- read /tmp/copy/some-project state | chat:messages 12 --turns 2 | chat:message 345 | chat:send-status <id> | previews 1 2

# Write, only in an isolated copy:
cargo run --release -- prepare-copy ~/Code/some-project /tmp/owner-copies some-project   # new or empty folder
cargo run --release -- rewrite /tmp/owner-copies some-project                         # read as owner, save it back
cargo run --release -- save /tmp/owner-copies some-project state.json [--durable] [--unloaded 3,4]

# Compare reads against Node on a real copy (made without runtime.lock):
node fixtures/node-cases.cjs /tmp/copy/some-project /tmp/cases.json
MILAGRE_OWNER_COPY=/tmp/copy/some-project MILAGRE_OWNER_CASES=/tmp/cases.json cargo test --release -- --ignored live_copy
```

The writer, lock and CLI tests run the real Node writers (`fixtures/writer-node.cjs`) and need Node 24. Without it they fail; `MILAGRE_OWNER_SKIP_NODE=1` skips them. The Node scripts resolve `@milagre/shared/*` to `packages/shared/src` themselves, so they run in a Worktree without `node_modules`. Test Projects live under `fixtures/.projects`: a hidden folder, so the Project registry's scan never picks them up as real Projects.

## Conformance evidence

- **Reads.** `fixtures/generate.cjs` builds seven Projects with the real Node writers, then edits rows by hand to reach states older releases and crashes leave. Those states include position gaps, an orphan Chat, a NULL session, a non-string body, missing and wrong-hash sidecars, inline legacy messages, inline details still to compact, a marker without chats.db, a folder without state, and unpaired surrogates in bodies, clientMessageIds, step ids, details and subagent text. Node answers 620 cases on throwaway copies, and `tests/conformance.rs` compares every byte.
- **Writes.** `fixtures/writer-scenarios.json` holds 10 scenarios, 93 steps. Each runs through Node's saveProjectState/readProjectState (`writer-node.cjs run`) and through `OwnedProject` in an isolation. After every step, both folders are snapshotted by the same Node code: each file's mode and content hash, every chats.db row with `typeof` of each column, and Node's own readProjectState of the result. The step's answer (save report, error text, receipt) is compared too. Covered:
  - appends, edits, deletes, reorders (new positions, renumbering), a removed Chat;
  - an idempotent re-save, a durable save, a restart then read then save;
  - inline images (stored, invalid kept, sourcePath), detail and subagent sidecars and their sweeps;
  - suggestions dropped, unloaded Chats kept or dropped;
  - legacy inline → chats.db migration with `.before-chats-db`, the alpha and surrogates fixtures round-tripped;
  - SQLite rollbacks (NULL id, an unbindable clientMessageId), a failing rename, a crash between commit and rename, and a transaction killed mid-way (SIGKILL with pages already in the file) that the next owner open rolls back;
  - receipts for saved, queued, lone-surrogate and missing clientMessageIds.

  The test also asserts directly that a refused save leaves the disk unchanged, and that recovery restores the rows from before the crash.

- **Locks** (`tests/locks.rs`, real Node `ownership.cjs`): Node refuses a Rust-held lock; Rust refuses a Node-held lock and Isolation refuses while it is held; a dead owner's lock and an old empty lock are refused and left as they were (Node itself takes the dead owner's over); release checks the token; nothing outside an Isolation can be opened.
- **Real data.** A plain `cp` of this repository's own Project (17 MB chats.db, 39 Chats, 684 rows) matched Node on 221 read cases including the whole readProjectState output. A Rust `rewrite` and a Node read+save of separate copies left byte-identical snapshots (6.4 MB: files, modes, rows, Node's read). Those copies aren't committed.

Recorded with Node 24.13.0 (SQLite 3.50.4); the crate bundles SQLite 3.50.2. A crash's rollback journal holds raw pages with the writing SQLite's version, so snapshots compare only its presence and compare the recovered rows.

## Limits

- **Isolated copies only.** There is no path to write a live Project, and none is planned here: a production cutover needs the owner service, its wire protocol and an upgrade/rollback test (stages 3–5 of the plan).
- **Files only.** Reads equal Node's when the saved files are all there is. A Project open in a running daemon can hold unsaved changes (250 ms write-behind), sends in flight and streaming runs.
- **No ProjectStates.** Lazy unloading, touches, the debounced write-behind, settle and the daemon's message patches are in-memory policies of the owner service and aren't ported. `save_project_state` takes the unloaded Chats explicitly (`SaveOptions::unloaded`).
- **Commands not ported:** `chat:search`, `chat:all-messages`, `chat:subagent`, the full inbox projection, attachment access. Scopes are Project paths only (no Link keys, chats home or registry check).
- **Differences that stay:** JSON syntax error texts differ from Node's. I/O errors use Node's text for the common codes (ENOENT, EACCES, EEXIST, EISDIR, ENOTDIR, ELOOP, ENOTEMPTY, EPERM, EXDEV, ENOSPC). node:sqlite reads an object bound in the first position as named parameters and fails with another message. Ownership probing is macOS/Linux only (`ps -o lstart=`); the Windows probe isn't ported.
- The project-store LRU of 50 settled Projects is per `OwnedProject` here (one Project each).
