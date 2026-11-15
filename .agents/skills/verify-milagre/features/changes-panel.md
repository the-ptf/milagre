# Changes panel

The Changes panel lists the Chat's Worktree changes against its comparison branch, uncommitted files first, with a Commits view, and opens a file's diff in the main area.

## Sub-features

- `changes-list` lists uncommitted files with +/- counts and a status letter (A, M, D).
- `changes-diff` opens a file's diff in the main area.
- `changes-commits` switches to the Commits view of the comparison.
- `changes-refresh` re-reads the Worktree.

## How to get to it (user POV)

- The changes toggle in the top bar of an open Chat (`Toggle changes panel`).

## Driving it with verify-milagre

Preconditions:

- The scratch repo has an uncommitted file, for example `from-terminal.txt` from [terminal](./terminal.md).

- **Open.** Run `node $V click '[data-panel-toggle=changes]'`. The snapshot shows `tab "Changes1"`, `radio "Files1" [checked]`, `radio "Commits0"`, `h3 "Not committed"` and `button "from-terminal.txt+1A" {data-diff-tree-file=from-terminal.txt}`.
- **Open the diff.** Run `node $V click '[data-diff-tree-file="from-terminal.txt"]'`. The main area shows the file header, hunk `@@ -0,0 +1 @@` and `+ verified-from-terminal`; a back arrow with the Chat title sits above it.
- **Proof.** `node $V shot diff-file`, plus `git -C <project> status --short` listing `?? from-terminal.txt` as the second view.

## Gotchas

- Committing is not in this panel. It goes through the agent (composer PR pill or the row menu's `Commit and open PR…`), which needs a GitHub remote the scratch repo does not have.
- The scratch repo has one branch, so the comparison is `main ← main`.
