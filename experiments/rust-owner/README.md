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

## The in-memory runtime (isolated copies only)

`states::ProjectStates` is `project-states.cjs` with `message-store.cjs` lazy Chats, for the Projects of one `Isolation`, each opened (and locked) on first use. Its clock belongs to the caller (`advance(now)`), so a run is deterministic; what happens, and in what order, is Node's:

- **Changes.** `update(project, chats, persist, change)` runs one change at a time on the latest state. `chats` names the Chats it touches, which are loaded first; `None` loads every unloaded Chat. A change that touches an unloaded Chat without naming it gets that Chat merged back (`settle`). New long step details move to sidecars as the change is kept (`compactProjectDetails`).
- **Write-behind.** A persisted change is saved `debounce_ms` (250) after the last change to its Project, one save at a time. `flush` is the durability boundary. A failed save keeps the state dirty and puts `persistence: { error, code?, saving }` on it until a save succeeds. `persist: false` changes stay transient until the next persisted change, `retry` or `close`. `forget` saves, then drops a Project and its lock.
- **Lazy Chats.** The first read that names Chats sheds those idle for `idle_ms` (10 min) by `summary.lastAt`. A sweep every `sweep_ms` (1 min) unloads Chats nobody touched for `idle_ms` that aren't busy (`set_busy`), whose Project has nothing waiting to be saved, and that chats.db holds exactly as memory does.
- **Identity.** Messages are `Arc<Msg>`. An unchanged message is the same `Arc` in the next state, the way Node keeps the same object, so unload eligibility, skipped row writes (`Same::Identity`) and patches decide as Node does.
- **Message patches.** `ProjectStates::message_changes_from(previous, next)` is the daemon's `messageChanges`: new or changed messages (rows read back from chats.db don't count), each with the id of the message before it in its Chat, and the removed ids (an unloaded Chat whose session exists isn't removed).
- **Reads.** `chat_messages`, `chat_message`, `all_messages` (marks, withState), `search` (`message-search.mjs` + `chatSearch`: UTF-16 offsets, typo distance, snippets, ranking), `subagent`, `send_status`, `inbox`, `whole_state`.
- **Command boundary.** `ProjectStates::call(method, args)` serves `chat:messages`, `chat:message`, `chat:all-messages`, `chat:search`, `chat:subagent` and `chat:send-status` with the daemon's argument shapes and error texts, for a Project these states have open. This is the library entry a wire server (experiments/rust-owner-wire) can dispatch to; no socket is wired here.

## Sending and turns (isolated copies only)

`chat_host::ChatHost` is the core of `agents/chat-host.cjs` over a `ProjectStates`, with agents behind a `Provider` trait. No production provider is wired here: the adapters live in `rust-providers/` at the root and implement this trait.

```rust
pub struct TurnId(pub u64);                     // the host's name for one turn it started
pub trait Provider: Send {                      // every method returns at once; work happens on the adapter's tasks
    fn name(&self) -> &str;                                              // "claude", "codex", "kiro", …
    fn start_turn(&mut self, turn: TurnId, request: &Value) -> Result<(), ProviderError>; // Err = refused at once
    fn interrupt(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError>;       // its turn-cancelled follows
    fn respond_permission(&mut self, chat: &str, turn: TurnId, answer: AnswerId, request_id: &str, decision: &str) -> Result<(), ProviderError>;
    fn answer_question(&mut self, chat: &str, turn: TurnId, answer: AnswerId, request_id: &str, answers: &Value) -> Result<(), ProviderError>;
    fn close_chat(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError>; // only that turn's session generation
    fn shutdown(&mut self);
    fn take_events(&mut self) -> Vec<ProviderEvent>;                     // or push them with ChatHost::deliver
}
pub enum ProviderEvent {
    Started { chat, turn, result },             // SessionManager.startTurn resolved ({ turnId, steered })
    StartFailed { chat, turn, error },          // it rejected: the host folds turn-failed
    Agent { chat, turn: TurnId, event },        // a Node agent event, tagged with the turn whose session sent it
    Exited { chat, turn: TurnId, error },       // that session's process ended (turn = the last turn it ran)
    AnswerSettled { chat, answer, outcome },    // Accepted | NotWaiting | Failed(error), exactly one per AnswerId
}
pub struct ProviderError { pub kind: ProviderErrorKind, pub message: String } // Unavailable, Refused, Timeout, Exited, Other; no credentials
```

- **Turn identity and session generations.** Every event names a host turn. Each Chat's latest turn stands for its session's generation.
  - Turn events and turn ends must name the turn running; with nothing running they are dropped, so a duplicate `turn-cancelled` after `turn-completed` neither holds the queue nor tells a phantom end. The queue moves on only when a turn end actually ended a run.
  - Chat-level events (`session-started`, `session-reset`, `context-usage`, subagents, plans, tasks, suggestions) must name the Chat's latest turn; an older session's are dropped.
  - `Exited` fails the turn it names only if that turn still runs, and closes that generation either way; a newer turn is never touched.
  - A turn the agent starts by itself (`turn-started` naming no running turn) is gated.
- **Liveness.** `interrupt` gives the turn `interrupt_grace_ms` (15 s, on the states clock the runtime's ticks move). `tick(now)`, the runtime's periodic call, moves the clock, handles waiting events first (an end that came within the grace counts), forces overdue interrupts (the adapter's nonblocking `close_chat`, then `turn-failed` "The agent didn't stop in time…", and the closed session's late events dropped), retries kept turn ends and pumps events. `shutdown(force)` handles waiting events first; with turns running it is refused unless forced, which ends them the same way before providers shut down and the states close. `forget(project, force)` closes the Project's provider sessions first and is refused with a turn running unless forced. A forced end closes only its own session generation (`close_chat(chat, turn)`) and forgets only that generation, so a Send-now pick it starts keeps its session. While `shutdown` runs, or `forget` closes a Project, no queued message or Send-now pick starts and no send is taken; senders still waiting on a queued start hear `null`. A late `Started` of a turn that no longer runs is dropped. There is no start deadline: a turn whose provider never answers ends through Stop (interrupt, then the watchdog) or a forced close.
- **Open Projects only.** `receive` drops events for a Project that isn't open here, so a late event can't open (and lock) a closed Project.
- **One owner.** The host is `&mut self` throughout and `Send`: the runtime keeps it, with its `ProjectStates` and clock, in one task (commands and provider events through one channel, a periodic `tick`). Notices are bounded (`MAX_NOTICES` in a ring, the oldest dropped and counted in the next take; the cap counts notices, not bytes) and a pump stops after `MAX_PUMP_ROUNDS`, keeping the rest for the next pump, which handles them first.
- **One spelling per Project.** Chat keys, runs and busy marks are keyed by the Project text, so `send`, `receive`, `interrupt` and the queue commands refuse any spelling of the path other than the states key (`ProjectStates::canonical`): `/p/` or `/x/../p` would otherwise make one Chat two.
- **Nothing left busy by a failure.** Runs and sequence numbers change only when their fold was kept. A turn end of the running turn whose fold fails (a save, a load, a Project that isn't open) is kept, through retries that fail before the fold too, and folded again by `tick`/`pump`/`retry_stuck` (`stuck_ends()` lists them); the Chat stays busy until then. Failures of work the host does on its own (a queued start, the `turn-failed` of a failed start) come back as `Notice::Failed`, never dropped. Busy marks (no unload by a sweep) cover runs, starts and kept ends. See Liveness for `forget` and `shutdown`.
- **Sends.**
  - `send(request)` and `call("chat:send", [request])` take the daemon's request shape.
  - A `clientMessageId` already saved, or waiting in a queue, answers `{ sessionId, duplicate }` and starts nothing. This is checked before the save and again inside it.
  - A Project open here whose lock was lost refuses the send before anything is staged (`assert_owned`).
  - The user message (ids from `next_id`; a new Chat in a Worktree reuses its empty Chat or gets the next id) is saved and **flushed** before the turn starts; a failed flush takes it back out.
  - `message-sent` opens the run; the saved message is found again by id. The send answers with the `TurnId` it asked for without waiting; the start resolves as `Notice::Started`, and one that fails ends the turn with `turn-failed`.
- **Queue.**
  - A message for a running turn whose provider can't steer, or sent with `delivery: "queue"`, waits in `session.queued` and is saved before it is answered.
  - A completed turn starts the oldest queued message; Stop and failures hold the queue.
  - `chat:queue-send` starts it now, or stops the running turn so it starts next. `chat:queue-remove` takes it out.
  - A queued entry outlives a crash and starts after the next completed turn.
  - Send now while a turn runs keeps its pick only once the interrupt was asked for; a failed interrupt leaves no pick behind.
  - A queued entry whose `clientMessageId` is already in the Chat leaves the queue and the next one starts (Node would retry it on every turn end).
- **Events folded:** `session-started`, `session-reset`, `turn-started`, `text-delta`, `context-usage`, `subagents-waiting`, permission and question requests and resolutions, tool steps (`step-started` with the host's start time and command input, `step-output`, `step-completed` with end, duration and `summarizeStep`'s summary and error; `tool_activity.rs`), `subagent-update` (merged as Node merges, kept in memory until another change saves, published with the merged agent), `background-tasks`, `plan-updated`, `tasks-updated` (`nativePlan`), `prompt-suggestion`, `answers-sent`, and the turn ends. A turn end saves the reply (`replyBody`, outcome, credits), marks the Chat unread unless it is `open_chat`, archives finished subagents and moves the queue on.
- **Receipts.** `chat:send-status` answers from the saved message or queued entry. A resend after a crash with the same `clientMessageId` is a duplicate, because the message was flushed before its turn started.
- **Notices.** What clients would hear comes back from `take_notices()`: events with their sequence numbers and whether they changed the state, broadcasts, title requests, and queue starts and removals.

**Gates.** Each of these is refused with an error saying it isn't supported yet; nothing is saved and nothing is approximated:

- steering a running turn (`SteeringMode::Gated`; Node would split the reply and steer), and Send now into a turn that can steer;
- provider handoffs (switch and restore);
- compaction;
- usage-limit continuations and account routing (`limitResumeId`, `expectedAccountId`, …);
- Routines' messages, a wake's guarded turn, `canStart`, `delivery: "now"`;
- images, and a handed-over Chat's brief;
- answers that need unported policy: chat secrets, bug-report approvals, Worktree setup reviews, images attached to answers, a Subchat suggestion card's answer (Subchat escalation bookkeeping isn't ported);
- compaction progress (`context-compacting`, `context-compacted`, `agent_runs::UNSUPPORTED`) and malformed step, subagent and task events.

Automatic compaction stays off (Node's default) and can't be turned on.

- **Answers** (`agent:respond-permission`, `agent:answer-question`): validated as SessionManager does, the answers shown as the user's message after the reply so far (`recordAnswers`), handed to the provider and settled asynchronously: `NotWaiting` and proven `Failed` take the message back, `Uncertain` (the adapter's, a deadline's, or a closing session's) keeps it and blocks a retry of that request in that session generation until a definitive settlement or the session closes. Answers on their way and uncertain ones share `answer_capacity` slots (never evicted; at capacity a new answer is refused before anything is shown). Provider JSON is raw and encoded once in `deliver`. See `PROVIDER-CONTRACT.md`.

Steering and handoffs: what Node does and what each needs is in `STEERING-HANDOFF.md`. Steering admission and save are ported behind `SteeringMode` (default `Gated`; `Recorded` is for conformance and calls no provider); the Provider call for it is a proposal there.

Two things are only reported, not done:

- reply image capture (`chat-images.cjs`) shows as `Notice::Gap` for a reply with Markdown images;
- a usage-limit turn end's `limitTurn` shows as a `Notice::Gap` too.

## Streaming cost

`cargo run --release --example streaming [-- <repeats> [<workload>]]` (`examples/streaming.rs`) replays deterministic
workloads through ChatHost over an isolated copy with the scripted provider, 50 events per pump, then ends every turn
and flushes. It prints the best of the repeats, events per second, and a digest of every notice, the runs before the
end and the saved state, so a change can show it computes the same thing.

| Workload (events)                                             | `ed32aa05` (events/s) | `1fa3d829` (events/s) | With root check (events/s) | Digest           |
| ------------------------------------------------------------- | --------------------: | --------------------: | -------------------------: | ---------------- |
| long-reply: 4,000 deltas of 50 B (4,000)                      |        9,198 – 10,309 |     223,213 – 259,251 |          239,793 – 262,943 | a83c5872ff2a1974 |
| many-steps: 1,500 shell steps, 2 x 500 B output each (6,150)  |             519 – 545 |       34,706 – 37,257 |            35,806 – 37,200 | 9a00f30b4c5b5926 |
| subagents: 10 agents x 100 updates, 20-entry tails (1,100)    |         1,306 – 1,333 |         1,947 – 2,099 |              2,050 – 2,125 | 4f71607886841c96 |
| multi-chat: the three plus a mixed Chat, interleaved (12,750) |             759 – 783 |       12,289 – 17,643 |            16,614 – 17,882 | 2b7bb99cc4f0a63e |

Method: three release binaries built separately (`git archive` of `ed32aa05` and `1fa3d829` with the same harness,
and the tree with the root check; distinct executable hashes), run alternately, three samples each with one repeat
per run (range shown: lowest to highest); Apple M5 Pro, rustc 1.99.1. Every one of the 9 runs per workload produced
the same digest. The root check runs per write (debounced saves), not per event, and costs nothing measurable here.
What changed:

- A fold changes only the affected Chat's run, in place (a delta appends to the text it has); before, every event
  copied every Chat's run twice. Only events that can change the state and the run together (`message-sent`,
  `turn-started`, the turn ends, a steered step split) copy that one run first, put back in its place if the save
  or load behind the change fails. Node traces and the rollback tests are unchanged.
- An open Project's key is its path worked out from the text: the full `.milagre` walk (`Isolation::resolve`) ran
  several times per event and grew with every sidecar. Opening still walks it. Every write checks the root is still
  the folder opened (device and inode pinned at open, canonical path unchanged: no move, no link on or above it) and
  what a save could follow (`verify_owned`).
- Events folded into the run alone don't copy the session; step stamps read the steps without copying them.

Subagent updates stay the slowest: each copies the Chat's session (its subagents and transcripts) and the sessions map,
because the state is plain JSON values. Sharing sessions behind `Arc` is the next step if that matters.

## Unpaired surrogates

JavaScript strings can hold half a surrogate pair (a `slice` through an emoji). `JSON.stringify` writes it as `\ud83d` and `JSON.parse` reads it back; serde_json refuses it and a Rust `String` can't hold it. `jsjson::parse` (used for every coordination.json, sidecar and chats.db payload) now keeps it without loss. Inside the `String`, an unpaired surrogate `s` is U+10FFFE followed by `char(0xF0000 + s - 0xD800)`, and a real U+10FFFE is doubled. The mapping is injective. `jsjson::to_string` writes `\udxxx` back, `utf16_len`, `to_utf16` and `from_utf16` work on the JavaScript string (detail lengths, `slice(-1000)` of subagent text), and `to_sqlite_text` binds what node:sqlite binds (U+FFFD for the unpaired half).

What remains different:

- A `Value` holding such a string shows the two marker characters to Rust code that reads it as text; use the `jsjson` helpers.
- SQLite text columns (`client_message_id`) hold U+FFFD for an unpaired surrogate in Node too, so two clientMessageIds that differ only in which unpaired surrogate they hold collide in a column lookup, in Node's findRow and here alike.
- Invalid UTF-8 bytes in a file are read as U+FFFD, like Node's `readFile(…, "utf8")`.

## Running it

```sh
cd experiments/rust-owner
cargo test        # unit, reads (620 Node cases), writer (93 steps), runtime (109 steps), ChatHost (182 steps + 26 safety), summarizeStep (43 Node cases), locks, ownership, containment, CLI
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

- **Runtime** (`tests/runtime.rs`, `fixtures/runtime-traces.json`, regenerated by `fixtures/make-runtime-traces.py`). There are 4 traces, 96 steps: lazy lifecycle, failures and retry, debounce and crash, unload rules. Each runs through Node's real ProjectStates under `node:test` mock timers (`fixtures/runtime-node.cjs`, ticking 10 ms at a time from a fixed start), and through the Rust states. Both start from the same seeded Project. Every step compares:
  - the state after it (message ids, unloaded Chats, save status, a hash of the whole state);
  - message patches;
  - save, failure, status and unload events in order;
  - each read command's full answer, with the Rust reads going through `call`;
  - disk snapshots.

  The traces cover shed-on-read, settle loading a touched Chat, idle sweeps with a busy Chat kept, debounced saves coalescing, a failed save with a transient change, retry, close flushing transients, and a crash that loses the unsaved change and is followed by a resend with the same clientMessageId. They also cover a removed session dropping its unloaded rows, and search over accents, `İ`, CJK, emoji, typos, phrases and a body with an unpaired surrogate.

- **ChatHost** (`tests/chat.rs`, `fixtures/chat-traces.json`, regenerated by `fixtures/make-chat-traces.py`). There are 7 traces, 182 steps. Each runs through Node's real ChatHost over its real ProjectStates, with the provider mocked where SessionManager.startTurn sits (`fixtures/chat-node.cjs`: mock timers, queued-message ids from a counter, `markdown-it` read from the main checkout or `MILAGRE_NODE_MODULES`), and through the Rust ChatHost with `MockProvider`. Every step compares:
  - the answer;
  - every notice with its sequence number;
  - each turn request sent to the provider, and interrupts;
  - message ids, a hash of the whole state, the runs;
  - disk snapshots.

  The traces cover a send with settings, provider session id, streamed text, context usage, a permission request and its resolution, duplicates of a saved and of a queued message, receipts, a completed turn starting the queue, a failed turn, a new Chat in the Worktree, Stop, a provider that fails to start, an empty-body prompt, a crash then a duplicate resend, queue hold and Remove, Send now while idle and while busy (stopping the turn), a queued message started after a crash with no sender, an idle sweep keeping the running Chat in memory, tool steps of every kind (failed tests, edits, thinking, result counts, vitest totals, a step updated while running, one left running at the end), plans and native task lists (same list again, Milagre-owned plans, clearing), background tasks, subagent merges (stale, the session's own, a transcript tail, three updates then archived: this one needs jsjson's `undefined` marker to keep Node's key order), permission answers (unknown decision, no session), question answers taken, refused, invalid and dismissed (the answers message shown, then taken back), a crash, Claude's prompt suggestions (wrong turn, blank, cleared by the next send), and steering admission and save (`claude-steering-save`: the reply so far split above the steer with finished and running steps, the running provider and model kept, a duplicate, the first text after the steer split as its own reply, a steer with nothing to split, a queued send; Node's mocked SessionManager answers `{ steered: true }`, the Rust side records the request it would hand over). Each notice compares its whole payload, and the provider's answers are compared too. `unsupported_features_are_refused_not_approximated` checks every gate and that a refused send saves nothing.

- **ChatHost safety** (`tests/chat_safety.rs`, Rust only: Node has these bugs). Two spellings of one Project, a lost lock and a failed flush during a send (nothing staged or left busy, the same client id goes through afterwards), duplicate client ids while a start is in flight and while queued, a late `turn-cancelled`, text, `session-reset` and exit of the interrupted turn after Send now (dropped, the new turn untouched), the running session's exit failing its turn and closing its generation, a duplicate turn end while idle (dropped, nothing told, queue not held; Node publishes it, so the Node trace leaves it out), an interrupt that never ends (forced after its grace, session closed, its late events dropped) and a forced quit, a closed Project staying closed (sessions closed, late events dropped, lock not taken; a forced close ending a running turn), Send now with a failed interrupt (no pick left), a turn end whose fold fails (kept through failing retries, folded once the Project is open), a queued entry already in the Chat, a large message saved once, bounded notices, Send now whose interrupt is ignored (the forced end starts the pick, whose session keeps its generation), a forced quit and a forced close with a Send-now pick waiting (no provider turn starts, the sender hears `null`), a tick handling an in-time end before forcing, a late `Started` dropped, and `ChatHost: Send`.
- **summarizeStep** (`tests/summary.rs`): Node's `summarizeStep` and `capOutput` (`fixtures/summary-node.mjs`) against the Rust port on 43 cases: TAP and vitest counts, failure reasons, `FAIL` forms, edits, result counts, terminal escapes and carriage returns, U+2028/U+2029 line ends, JavaScript whitespace, ASCII-only case folding (`ſ`, Kelvin sign) and UTF-16 slicing of emoji.
- **Ownership** (`tests/ownership_guard.rs`). A replaced token, a changed pid, a removed record or lock, or a lock swapped for a symbolic link stops every write, surfaces as `OwnershipLost` (never showing a token) and leaves the files byte-identical. In ProjectStates the failure stays as save status until a retry saves.
- **Containment** (`tests/containment.rs`). `..` and absolute escapes, the root itself, symlinked path parts, a symlinked or hard-linked `.milagre`, chats.db, lock, details folder or sidecar, and a symlinked isolation root are all refused before anything is created or locked. A sentinel folder outside stays byte-identical.
- **Locks** (`tests/locks.rs`, real Node `ownership.cjs`): Node refuses a Rust-held lock; Rust refuses a Node-held lock and Isolation refuses while it is held; a dead owner's lock and an old empty lock are refused and left as they were (Node itself takes the dead owner's over); release checks the token; nothing outside an Isolation can be opened.
- **Real data.** A plain `cp` of this repository's own Project (17 MB chats.db, 39 Chats, 684 rows) matched Node on 221 read cases including the whole readProjectState output. A Rust `rewrite` and a Node read+save of separate copies left byte-identical snapshots (6.4 MB: files, modes, rows, Node's read). Those copies aren't committed.

Recorded with Node 24.13.0 (SQLite 3.50.4); the crate bundles SQLite 3.50.2. A crash's rollback journal holds raw pages with the writing SQLite's version, so snapshots compare only its presence and compare the recovered rows.

## Limits

- **Isolated copies only.** There is no path to write a live Project, and none is planned here: a production cutover needs the owner service, its wire protocol and an upgrade/rollback test (stages 3–5 of the plan).
- **Files only.** Reads equal Node's when the saved files are all there is. A Project open in a running daemon can hold unsaved changes (250 ms write-behind), sends in flight and streaming runs.
- **Runtime gaps.**
  - Whole-state patches (`state-patch.mjs` diffState) aren't ported. They diff by identity at every level of the state, which needs a structurally shared value model for the whole state, not only messages.
  - Chat summaries (`withChatSummaries`: `summary.count`, `lastAt` stamping and the other fields) aren't ported, and the runtime's compact step is details only. Traces use the same on the Node side; shedding reads `summary.lastAt` as saved.
  - The whole-state row cache (`REST_TTL_MS`) isn't ported; it only keeps identity stable for whole-state clients.
  - Saves are synchronous, so Node's "a sweep skips a Project whose save is in flight" never arises.
  - The runtime's `read` here is readProjectState only; Worktree discovery and reconciliation (`reconcileState`) come with the Worktree domain.
- **Commands not ported:** `state:read`/snapshots, the turn commands behind the gates above (handoffs, compaction, limits, permissions, questions, steering), attachment access, Link scopes, the chats home, and the unopened-Project registry check of `chat:messages`. Quit-time suspension and resume (`suspendRunning`, `resumeInterrupted`) are not ported: a crash or close mid-turn leaves the user message saved and no reply, and nothing resumes.
- **Not a runtime.** There are no tool permissions, Worktree setup or Git, MCP tools, provider processes or wire socket. ChatHost here is the send and turn state machine over storage, behind a library boundary.
- **Containment is checked at open.** A symbolic link planted inside the copy later by another process isn't caught, except where each write checks: the Project root (same device and inode as at open, canonical path unchanged, so a moved Project or a link on or above the root fails the write), `.milagre`, `chats.db`, its journal and `coordination.json`. Isolated copies have no other writer.
- **Differences that stay:** JSON syntax error texts differ from Node's. I/O errors use Node's text for the common codes (ENOENT, EACCES, EEXIST, EISDIR, ENOTDIR, ELOOP, ENOTEMPTY, EPERM, EXDEV, ENOSPC). node:sqlite reads an object bound in the first position as named parameters and fails with another message. Ownership probing is macOS/Linux only (`ps -o lstart=`); the Windows probe isn't ported.
- The project-store LRU of 50 settled Projects is per `OwnedProject` here (one Project each).
