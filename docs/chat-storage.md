# Chat storage

How the host saves Chats and their messages, keeps idle ones out of memory, holds Chats without a Project, deletes them, and checkpoints their file changes.

## chats.db

A Project's messages live in `<project>/.milagre/chats.db`, one row per message, through `node:sqlite`. A Named Link keeps its own `chats.db` under its folder. `coordination.json` holds everything else: Worktrees, Chats, tasks and the shared `next_id`. Its `messages` field is a marker, `{ "storedIn": "chats.db", "format": 2 }`.

- **Ids.** Message ids are global and increasing across a Project's Chats, from `next_id`. Handoff dividers, Chat order and pending sends depend on that.
- **Order.** Each row has a `position`, a sort key with gaps, because array order and id order can differ (a pending message re-sent after a reply split in two). A message keeps its position while the order holds; one added or moved takes a position after every row.
- **Saves.** A save writes the rows whose message changed since the last save and deletes the rows of messages that are gone, in one transaction, then rewrites `coordination.json`.
- **Why `node:sqlite`:** it ships with Node and Electron, so there is no native module to build and the mobile fingerprint is unaffected.

Rejected: one JSON file per Chat. A long Chat would be rewritten whole on every reply, and search would need its own index. A single JSON file for the whole Project, the shape before this, encoded every Chat on every save on the daemon's only thread.

## Forks and side questions

Fork copies the saved messages through the chosen message into a new top-level Chat in the same Worktree. The copy has new message ids, no send receipts, pending approvals or running processes, and a divider linking back to its source. It does not restore files. Its first reply receives the copied transcript, including when the user chooses another provider. Even a fork from the latest message uses this snapshot: resuming or forking the source's native id on the first send could include messages the source received after the user pressed Fork.

`/btw` runs a separate read-only process while the main Chat continues. Its question, streamed answer and status live only in runtime memory, outside `chats.db`, unread state and the main Chat's activity. Claude and Codex fork native context; Antigravity and Kiro receive the saved transcript and any live reply text. Claude disables session persistence and Codex uses an ephemeral fork with `excludeTurns`, as the app-server's paginated protocol requires. All four adapters deny writes and shell execution. Stop, dismiss, replacement, completion and Chat retirement close the side process. A dismissed answer remains readable until cleared, the Chat retires or the host exits. Bring back explicitly inserts a quote into the main composer.

## Idle Chats leave memory

The daemon holds a Chat's messages in memory only while the Chat is in use. A Chat untouched for ten minutes, with no turn running or preparing and no window showing it, is unloaded; its rows in `chats.db` are the only copy until something needs them.

- **Whole Chats only.** A Chat is loaded or unloaded, never partly. Which Chats are unloaded travels with the state, tagged on its messages array (`message-store.cjs`), and is never saved or sent.
- **Only what is saved leaves.** A sweep unloads a Chat only when `chats.db` holds exactly what memory does, with no save waiting or running. A save touches rows only for Chats the state holds. A details sidecar an unloaded Chat points at is kept.
- **Writers name their Chats.** A state change lists the Chats it reads or writes, and those load first; a change that names none loads every Chat. Reads across Chats (search, lookups, the chat list) read unloaded rows for that call without loading them.
- **Clients see no difference.** An unloaded Chat's messages are never reported as removed, and a client that takes whole states gets every message, read back from `chats.db`.
- A Project still reads every message on open; the sweep unloads afterwards. `MILAGRE_LAZY_MESSAGES=0` keeps everything in memory, finished subagents' transcripts included.

### Finished subagents' transcripts

A subagent's transcript lives in a sidecar under `.milagre/subagents/` (`project-content.cjs`). Once it is completed, failed or cancelled and its sidecars hold all of it, memory keeps only its last entries and `transcriptLength`: exactly what a client taking tails (`subagent-tails-v1`) is sent, so those clients see no difference. On open that holds for every such subagent with all its sidecars present; one finished in this session leaves at the next sweep after a save wrote its transcript.

- **Readers load it.** `chat:subagent` reads the whole transcript back for that call and keeps nothing. A client that takes whole transcripts (the `milagre` CLI, a desktop or paired computer older than `subagent-tails-v1`) gets them read back asynchronously before its next event or reply goes out, in order (`apps/daemon/src/transcript-order.cjs`), cached for a minute after its last read; reading them on the event loop would stall every other client. An update for a subagent loads it into memory first, so a subagent that runs again saves all of its transcript, old entries and new.
- **Open reads without keeping.** Open still reads and checks every sidecar, so a missing or damaged one is found exactly as before, but it never holds them all at once and reuses its read buffers: memory the allocator took for them is not given back to the system, so a peak at open stays in the footprint for as long as the host runs.
- **Saves keep its references.** A save writes the held subagent's sidecar references as they were, so the sweep never removes a file it still needs. A subagent with a missing sidecar stays whole in memory, as before. A sidecar that can't be read when one is loaded is treated the same way: the loaded subagent keeps that reference and the rows it has, nothing partial is cached as whole, and the next read after it recovers returns everything.
- **Disk is the only copy.** A held transcript can't be rewritten from memory, so deleting `.milagre/subagents` loses it, as deleting `chats.db` loses idle Chats' messages and deleting `.milagre/details` loses long tool output.

Rejected: stubbing each message's payload while keeping it in the array (every reader would see an empty body, and a save could write the stub over the row); a full message store behind every reader at once (dozens more call sites changed in one step).

## Chats home

A Chat started with No project is an ordinary Chat in an ordinary Project, so sessions, resume, `chats.db`, unloading, Accounts, approvals and Terminals all work unchanged. That Project is the Chats home: one Git repository per computer at `~/.milagre/chats` (`chats-home.cjs`), made on first use with one empty commit by "Milagre". Each Chat gets its own Worktree under `~/.milagre/worktrees/chats/`, isolation always `worktree`.

- `chats:home` reports `{ path, exists }` and changes nothing. `chats:ensure` creates and opens the home without adding it to the recent list or registry and without changing a window's Project. Clients call it when No project is picked, then start the Chat there as in any Project.
- The daemon leaves the home out of every list: `project:recent`, `project:registry`, MCP `project_list`, onboarding. Clients need no filter, so a client of any age never shows a Project named "chats".
- The daemon snapshot keeps it, marked `kind: "chats"`, because windows restore their Chats from it. Gates that check the registry accept it through an explicit entry.
- All project-less Chats on a computer share one Account selection, "Chats without a Project" in Settings › Accounts.
- **Without Git**, the home writes `.milagre-folder-chats` and makes one plain folder per Chat under `.chat-folders`, discovered without Git. The marker keeps that mode after a later Git install; nothing converts it. Removing such a Chat hides it and keeps its folder, since no Git status can prove deletion safe. A Git home, even a damaged one, never falls back to folders.

Rejected: a hidden Project per Chat (every list skips hidden homes, so the phone would never see these Chats); a plain-folder Project (holds only one Worktree); flagging list entries for clients to filter (an older phone would show a Project named "chats").

## Deleting Chats

Chat menus on desktop and phone offer Delete, not Archive. Delete acts at once, with no confirmation, and permanently removes the conversation, its rows, its local Designs and its page comments.

Archive, delete, Worktree removal and Routine Run cleanup all retire a Chat through one ordered sequence, `createChatRetirement` in `packages/core/src/runtime/chat-lifecycle.cjs`: end its Heartbeats, cancel a pending usage-limit continuation, stop the running turn (which holds queued sends), cancel Worktree setup, stop a validation run, close side questions and the agent session, stop Terminals and background commands, settle advisors and delegations, and cancel pending secret and bug-report questions. The Project state change is what notifies clients. The modes differ only around that sequence:

- Archive saves at once and finishes the sequence in the background, so the row moves without waiting on the agent or advisors (#718, #734). Messages, page comments and Designs stay restorable.
- Delete runs the sequence, removes the Chat from state, then removes its stored data: page comments, Designs and artifacts, the computer-use screen. Secret files are not per Chat; they expire on their own.
- Worktree removal frees the Worktree with the sequence's process steps (turn, setup, agent, Terminals, advisors) before Git removes it, so a refused removal ends nothing else, then retires each Chat with its stored data once the Worktree is gone.
- Run cleanup archives the Run's Chat, then runs the sequence; a Run Worktree's Chats are retired only after the Worktree is removed.

- A Worktree the Chat owns alone goes through the checked cleanup flow. Dirty, unpushed, shared, external and unchecked Worktrees stay. Deleting one Chat never removes another Chat from a shared Worktree. A failed cleanup restores the Chat.
- Delete stays available while the Worktree check is pending. Deleting before the check returns keeps the files, and a late check can't change that.
- Done/Reopen, scheduled archival after the Done retention period, existing archived records and hidden Routine Run cleanup keep their saved format and restore support.
- A Chat's menu actions belong to its own Project or Named Link. Starting a new Chat or switching Projects never disables them.

## Task checkpoints

Before a task starts, the host saves the Worktree files it could change; messages steering a running task share its checkpoint. Checkpoints live in the daemon's data directory, survive restarts, and never create commits or touch the index. Desktop and phones use the same ones. `/compact` changes no files and takes none. A checkpoint that can't be captured never blocks the task.

Undo (Esc Esc or `/undo`) lists the Chat's tasks that changed files and previews each file as Revert, Delete or Restore.

- Only files changed during that task are candidates. A file edited afterwards, or a task that ended without its final capture, is marked Edited after this task and the user picks Keep current or Undo.
- Nothing is written until the explicit Undo N files press, in every permission mode. If a file, rule or Worktree changed since the preview, nothing is written and the preview refreshes.
- Restoring waits for every Chat and subagent in the affected Worktrees to finish. Shared Link Chats cover their owned Worktrees; preserved read-only Chats keep their history but lose Undo and Redo.
- Before writing, the host saves a recovery checkpoint, which Redo previews. Each target is rechecked right before its write, but external editors don't share Milagre's locks, so a restore can't be atomic against them.

Captured: tracked and non-ignored untracked files. Excluded: links, Git and Milagre metadata, generated directories, recognized secret names and content, and the largest files past the size caps, so source files stay covered. An excluded file is never restored, even from an older checkpoint.

Users add exclusions in `.milagre/checkpoint-ignore` per Worktree: one relative glob per line, `#` comments, exclusion only (no negation), `path/**` for directories. Name checks can't catch every secret, so this file is the way to keep one out.

Checkpoints are local recovery data with no retention limit yet, not a backup.

## Validation

A Project's validation commands (Settings › Project › Validation, desktop and phone) live in the computer's Project settings, outside the repository, so an agent can't rewrite what checks its own work. `packages/core/src/validation.cjs` runs them one after another in the Chat's Worktree through the login shell (as Worktree setup does), 10 minutes each, and records the run as a note in the Chat, `context.kind: "validation"`, updated in place while it runs.

- **Evidence, not claims.** A command's status comes only from its exit code or signal: passed, failed, interrupted (Stop, timeout, the Chat retired, the host stopping) or not run. The note keeps each command, folder, exit code, duration and the last 40 lines; the whole log (up to 2 MB) stays in the data directory's `validations/runs/<runId>/` and `validation:log` reads it for that Chat only. The last 200 runs are kept.
- **When.** After a completed turn whose checkpoint changed files, when "Run after each task" is on. In Ask mode that run is recorded as not run until the user presses Run, which is the approval. The user's Run, the command palette and the agent's `validation_run` tool (gated by the provider like any tool) start one at any time; a run already going in the Worktree is joined. The agent hears a task's result as a `<milagre_note>` with its next turn.
- **Code state.** A run records HEAD plus a digest of every file Git doesn't ignore that differs from it, `.milagre/` left out. When a turn in that Worktree ends, or the Chat is opened, the host compares it again and marks the note out of date with the files that changed; a run whose files changed while it ran is out of date at once. `validations/fresh.json` keeps the runs still current, so a restart keeps watching them.
- A run left running by a host that stopped is settled as interrupted at the next start, never left looking like it could pass.
- Named Link shared Chats have no validation yet: the tools and Run refuse them.

## Imported Chats

Settings › Worktrees › Import from another app (desktop and phone), onboarding and the `import_run` tool copy T3 Code, Paseo and Orca work in (`packages/core/src/ade-import/`). Each source is read from its own files, never through its app: T3 Code's `~/.t3/userdata/statev2.sqlite` (or `state.sqlite`), Paseo's `~/.paseo/projects/*.json` and `agents/*/*.json`, Orca's `profile-state.db` (or `orca-data.json`). SQLite files are copied to a temp folder first, so a running T3 Code or Orca never sees a reader on its database.

A Project is opened like any other, so the source's own `git worktree add` checkouts show up as Worktrees with no `base`: Milagre never removes them. A thread becomes a Chat with `native_session_id` set to the source's Claude session id or Codex thread id and `importedFrom: {source, id}`; a second import skips a thread whose id or native id is already on a Chat. Its history is parsed from the provider's own transcript (`~/.claude/projects/*/<id>.jsonl`, `~/.codex/sessions/**/rollout-*-<id>.jsonl`, both the `item_completed` and the older `response_item` rollout formats) into messages and steps with the same step builders a live turn uses, and its summary keeps the source's dates instead of the import time.

Only Claude and Codex threads come over: other agents (Cursor, OpenCode and the like) have no adapter here, and Orca keeps no session ids for most terminal tabs, so Orca brings Projects only. The Chat must run where the session was made: Claude finds its transcript by working directory, so a thread whose folder is gone is skipped.
