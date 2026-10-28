# Core owns Git process execution

`packages/core/src/git/client.cjs` runs every Git command used by the app. It supplies noninteractive credential settings, named deadlines and output limits, normalized results, ref validation and Worktree discovery. Domain modules keep their existing user-facing result shapes. `GitError` carries the normalized process fields for callers that need exceptions.

The read and write surfaces are separate. Read helpers reject mutating commands; commit, push, fetch and Worktree mutations use `write`. These are internal argument APIs, not a sandbox for arbitrary commands supplied by a remote tool. A future read-only tool must expose specific query operations rather than accepting raw Git arguments.

Changes, sidebar totals and the commit/PR dialog choose the same comparison branch: a valid recorded branch, the remote default, then main or master. Without a comparison branch, sidebar totals retain their HEAD fallback for uncommitted work. The Changes panel can override its comparison branch for file diffs and commit history. That read-only choice stays within the panel; sidebar totals and the commit/PR dialog keep their recorded comparison. The panel identifies the current branch and the resolved local or remote comparison ref. A Worktree's start ref is a different choice: creation may fetch and fast-forward to its base's upstream, preserving existing creation behavior.

Read commands have a 10-second/16-MiB limit; network fetches have 30 seconds. Commit hooks, pushes and Worktree writes/removal retain five minutes. An oversized copy-file listing now fails within the shared read limit and becomes the existing copy warning instead of allocating up to 256 MiB.

Known Worktree paths come from ProjectStates after Project reconciliation. Diff and file-search requests no longer enumerate Git Worktrees again. A checkout created externally becomes available after the Project is refreshed. Removing a Worktree still rechecks Git and repository ownership immediately before deletion.
