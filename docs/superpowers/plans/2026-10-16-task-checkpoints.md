# Task checkpoints implementation plan

Goal: persist task checkpoints with explicit conflict review before restoring.
Spec: ../specs/2026-10-16-task-checkpoints-design.md
Execution: implement in this Chat's existing isolated Worktree, as requested.

1. Add `packages/core/src/checkpoints.cjs` and real-Git tests. API: begin({chatId, roots, permissionMode}), finish(chatId), list(chatId), preview(chatId, id), restore(chatId, {token, decisions, approved}). Snapshots, manifests, path checks and preview tokens stay private to the daemon. Write failing tests first, implement, then rerun.
2. Add `checkpoint-runtime.cjs`, runtime capture/terminal hooks, desktop preload and types, shared checkpoint contracts, mobile allowlist and confinement. Verify real task capture, restart recovery, active-task denial, scopes and confirmation with runtime tests.
3. Add desktop and mobile Checkpoints controls with identical required file decisions, conflict labels and confirmation copy. Use existing scrolling and choice primitives. Verify list, preview, stale errors and restore through Electron and mobile harness/device.
4. Run required checks and fingerprint comparison, inspect real screenshots, review the diff for unrelated work and secrets, commit only this task, upload evidence to screenshots and open a PR. Do not merge or release.

Review focus: simultaneous writers must require file decisions; path/symlink changes must abort; restart without end snapshot must stay conservative; stale previews must not write; restore failure must leave recovery data.
