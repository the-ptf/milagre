# Integration status (2026-11-10)

Keep working on `poc/rust-tauri-local`; no push or replacement of the production host is authorized. User requests near-identical UI, almost all features, full Rust backend migration, and sustained parallel work. They accept browser embedding, voice, floating inbox and decorative effects being omitted. The task is not complete.

## Coordination

- Parent Milagre Chat: `/Users/victor/Code/personal/milagre-ade#10904`.
- Heartbeat: `f3fd7e41`, every 10 minutes, expires after 7 days. Continue unfinished work, disable when truly complete.
- Sonnet 5.5 review: Chat `#10929`, Worktree `/Users/victor/.milagre/worktrees/milagre-ade/review-rust-desktop-compatibility-migrat-02j0`. Read-only review of this integration branch; Delegation report returns to parent.
- Opus 5.5 storage implementation: Chat `#10960`, Worktree `/Users/victor/.milagre/worktrees/milagre-ade/rust-owner-backend-storage-migration-fyrb`. Implements `experiments/rust-owner` SQLite/Project read compatibility with Node-generated conformance fixtures. Read-only commit `7dfea341` integrated as `9ef2494a`; 467 generated conformance cases pass locally. Agent now implements isolated-copy writers/locks as a second bounded task. No production writers or host restarts.
- Opus 5.5 Codex provider adapter: Chat `#10975`, Worktree `/Users/victor/.milagre/worktrees/milagre-ade/rust-codex-provider-process-adapter-fmkj`, owns `experiments/rust-providers`. Active implementation, commit/report pending.
- In-session agents implemented frontend adapter, transport/native services, content/navigation/capture modules directly in this integration Worktree. They do not own independent branches.

Milagre CLI is not installed in PATH. Use `node apps/daemon/src/command.cjs ... --data-dir "$HOME/Library/Application Support/Milagre"`. Scoped coordination uses `command run NAME --chat '/Users/victor/Code/personal/milagre-ade#10904' --input @file`. Do not print whole `state:read` or Worktree creation responses: they contain large real transcripts. Write to temporary JSON and extract the fields needed.

## Latest implementation and checks

Full production React renderer, production preload API adapted to Tauri, persistent Rust daemon protocol, paged replies/events/reconnect, shared-theme preference inheritance with isolated Rust overlay, native utilities, official notification plugin, media/Artifact schemes, native frame-aware WKNavigationDelegate guard, hidden real-webview capture.

Rust tests: 30 passed, 1 optional live test ignored. Live daemon read test separately passed. Production TypeScript typecheck and global lint passed. Node adapter test passed. Full repo suite first failed two unprepared-PTY cases; setup script fixed them, 41 targeted tests pass. Second full run `/tmp/milagre-rust-unit-final.log` failed five unchanged runtime/Link assertions under load. These four files are now retesting serially in `/tmp/milagre-rust-retest.log`; do not claim full suite pass.

Latest real UI smoke passes full-layout geometry, Chat, Filters, Appearance, saved Designs, saved HTML Artifacts and sandbox raw-IPC denial. Screenshot visually inspected: production sidebar/subchats/usage/transcript/composer/Artifact layout is present. Fixed Tailwind scan root, disabled voice shape, hidden entry animations and frame guard. Known diagnostics are three unloaded Project image requests with fallback icons. Remaining latest transport/preferences changes still need reinstall. See `/tmp/milagre-rust-install.log`, `/tmp/milagre-rust-run.log`, `/tmp/milagre-rust-smoke.json`, `/tmp/milagre-rust-capture.json`, `/tmp/milagre-rust-ui.png`. Latest screenshot evidence is external to Git; do not commit screenshots or real transcript evidence.

## Next integration gates

1. Confirm latest screenshot shows full layout and smoke requires actual saved Designs and HTML Artifacts, plus sandbox probe with no Tauri globals/parent DOM access. Fix failures.
2. Review Sonnet findings; fix critical issues and rerun appropriate tests. Record intentional omissions versus outstanding defects.
3. Exercise remaining retained workflows, including real controlled Chat send/stream/cancel/approval, attachments, Changes, terminals, accounts and remote/mobile sync. Existing live transport read tests do not prove these.
4. Commit tested integration checkpoint locally; install latest after checks. Merge reviewed Opus storage work and continue owner migration per BACKEND-MIGRATION.md.
5. Full completion requires standalone Rust owner, existing data compatibility/upgrade tests and equivalent workload performance evidence. Current installed Node daemon dependency means migration is incomplete.
