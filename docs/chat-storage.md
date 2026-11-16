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
- A Project still reads every message on open; the sweep unloads afterwards. `MILAGRE_LAZY_MESSAGES=0` keeps everything in memory.

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

Archive, delete, Worktree removal and Routine Run cleanup all retire a Chat through one ordered sequence, `createChatRetirement` in `packages/core/src/runtime/chat-lifecycle.cjs`: end its Heartbeats, cancel a pending usage-limit continuation, stop the running turn (which holds queued sends), cancel Worktree setup, close side questions and the agent session, stop Terminals and background commands, settle advisors and delegations, and cancel pending secret and bug-report questions. The Project state change is what notifies clients. The modes differ only around that sequence:

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
