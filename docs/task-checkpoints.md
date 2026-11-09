# Task checkpoints

Undo a task's file changes from the Chat itself. Desktop and paired phones use the same checkpoints, stored locally on the owning Computer. Milagre saves one before a task starts; messages steering a running task share its checkpoint. It does not create Git commits or change the staging area.

Open **Undo changes**:

- **Desktop:** press **Esc Esc** in an idle Chat with an empty prompt, type `/undo`, or hover one of your messages and press its undo button.
- **Phone:** **⋯ › Undo changes**, or send `/undo`.

The composer turns into a list of the Chat's tasks that changed files, newest first. Pick one to see its files and what undoing does to each: **Revert** an edited file, **Delete** a file the task created, **Restore** a file it deleted. Open a file to see its diff.

1. A file edited after the task, or a task that ended without its final capture, is marked **Edited after this task**. Choose **Keep current** or **Undo** for it. Every other file in the list is undone.
2. Press **Undo N files**. This explicit confirmation is required in Ask, Auto and Full modes; neither Esc Esc nor `/undo` writes anything. If a file, exclusion rule or Worktree changed since the preview, nothing is written: the preview refreshes and asks again.
3. The Chat shows **Undid N files · Redo**. Redo previews the files the undo replaced, with the same confirmation.

Restoring waits until all Chats and subagents in the affected Worktrees finish. Only files changed during that task are candidates; unrelated later files stay in place. Shared Link Chats cover their owned Worktrees. Checkpoints survive app and daemon restarts. Interrupted checkpoints are recoverable with conservative conflict review.

Before writing, Milagre saves a recovery checkpoint, the one **Redo** previews. Use it to recover from a mistaken or partially completed restore. If a restore fails partway through, a file may be partially written. The error reports its recovery checkpoint and the number of fully restored files. External editors do not share Milagre's locks: keep them idle during the confirmed write. Milagre rechecks each target immediately before writing it, but cannot make a group of filesystem writes atomic against external programs.

## Exclusions and limits

Milagre captures regular Git-tracked files and nonignored untracked files. It excludes symlinks, hard links, Git/Milagre metadata, generated directories (`node_modules`, `dist`, `build`, `coverage`, `.next`, `.expo`, `.cache`), common secret filenames (`.env*`, credentials, private keys and package-manager credentials), and recognized private-key/token content. Filename and token checks cannot recognize every possible secret: configure Project-specific exclusions before a task.

Create `.milagre/checkpoint-ignore` in each Worktree with one relative glob per line, for example:

```
private/**
**/*.cache
config/production.json
```

Blank lines and lines starting with `#` are ignored. Rules are exclusion-only, with no negation or Git-ignore directory shorthand. Use `path/**` for directories. The checkpoint data records exclusion counts. An excluded file is never restored, including when new rules exclude a file saved by an older checkpoint.

A file over 5 MiB is excluded. One checkpoint saves at most 100 MiB across a Chat's Worktrees; past that, the largest files are excluded first, so source files stay covered. Add exclusions for large generated files to keep that room for files an agent edits. A checkpoint never blocks a task: if one can't be captured, the task runs without it. `/compact` changes no files and takes none. Checkpoints and deduplicated file contents are private to the daemon's data directory; there is currently no automatic retention limit. They are local recovery data, not a backup outside the Computer.
