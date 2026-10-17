# Task checkpoints

Issue: https://github.com/the-ptf/milagre/issues/12

A checkpoint saves the working files before each idle Chat starts a task. Steering messages share the running task's checkpoint. The daemon owns storage and restore; desktop and mobile expose the same review flow. No commits, index changes, native dependencies, builds or releases.

## Safety and scope

Save regular tracked and nonignored untracked files, including dirty files, in private daemon storage with an atomic manifest. Ignore secret filenames, recognized secret content, generated directories, symlinks, Git metadata and `.milagre`. `.milagre/checkpoint-ignore` adds newline-separated relative glob exclusions. Files over 5 MiB and snapshots over 100 MiB fail closed. Display exclusions and limitations. Checkpoints remain available across restarts.

Record an end snapshot at terminal agent events. Only paths changed between start and end are restore candidates; unrelated later files remain untouched. The restore request carries a keep or restore decision for every changed path. The preview lists every path, so edits made during the task by the user or another Chat are visible before confirming; the clients answer restore for paths without a conflict (the user chose this in the redesign) and ask only for conflicts. Files edited after the end snapshot are explicitly marked conflicts. Interrupted tasks with no end snapshot require conflict resolution for all candidates. Never infer ownership of concurrent manual or other Chat edits.

Preview shows paths, create/replace/delete effects and conflict status. A short-lived, single-use preview token binds the current bytes, modes, identity, exclusions and checkpoint. Restore requires explicit user confirmation in every permission mode, all conflicts resolved, and a fresh revalidation of every candidate. No restore while any Chat in the affected Worktree runs or starts. A fresh safety snapshot is persisted before writing. Never follow symlinks, invoke Git restore/reset/clean, or touch the index. Failures retain the safety snapshot for recovery.

File I/O runs in a short-lived Node worker. It pins its working directory, validates every traversed directory by inode, and uses basename-only operations. Restore writes through verified descriptors, including permission changes on read-only files. Individual writes can be partial on failure; the saved recovery checkpoint is the recovery path.

## Clients

Undo changes lives in the composer, on both platforms. Desktop opens it with Esc Esc in an idle Chat with an empty prompt, `/undo`, or the undo button beside a user message that started a task; the phone with ⋯ › Undo changes or `/undo`. The composer shows the Chat's tasks that changed files (each checkpoint records its message, prompt and changed-file count), then a task's files with their effect and conflicts, then a confirmed restore. The task's message is outlined while it is in view. A successful restore writes an "Undid N files" line in the Chat whose Redo previews the recovery checkpoint. The old Changes-panel Checkpoints dialog is gone. Shared Link Chats cover each owned Worktree. Phone uses existing JS components and transport only.

## Verification

Real temporary Git repositories cover dirty/index state, untracked files, exclusion rules, modes, additions/deletions, restart recovery, conflicts, stale previews, symlinks, confirmation, active Chats and cross-Chat scoping. Runtime tests prove automatic capture and transport access. Electron and phone checks exercise list, preview, resolution and restore. Required root typecheck, lint, unit tests and affected screen checks run before PR creation. Screenshots live on the screenshots branch.
