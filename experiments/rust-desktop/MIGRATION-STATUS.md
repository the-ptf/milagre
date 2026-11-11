# Integration status (2026-11-10)

Keep working on `poc/rust-tauri-local`; no push or replacement of the production host is authorized. User requests near-identical UI, almost all features, full Rust backend migration, and sustained parallel work. They accept browser embedding, voice, floating inbox and decorative effects being omitted. The task is not complete.

## Coordination

- Parent Milagre Chat: `/Users/victor/Code/personal/milagre-ade#10904`.
- Heartbeat: `f3fd7e41`, every 10 minutes, expires after 7 days. Continue unfinished work, disable when truly complete.
- Sonnet 5.5 review: Chat `#10929`, Worktree `/Users/victor/.milagre/worktrees/milagre-ade/review-rust-desktop-compatibility-migrat-02j0`. Read-only review of this integration branch; Delegation report returns to parent.
- Opus 5.5 storage implementation: Chat `#10960`, Worktree `/Users/victor/.milagre/worktrees/milagre-ade/rust-owner-backend-storage-migration-fyrb`. Implements `experiments/rust-owner` SQLite/Project read compatibility with Node-generated conformance fixtures. Read-only commit `7dfea341` integrated as `9ef2494a`, writer commit `c2ba07b8` as `4c6dcd41`. 620 read cases and 93 writer steps pass. Agent now implements ProjectStates and fixes containment-before-mutation guards after root review. No production writers or host restarts.
- Opus 5.5 Codex provider adapter: Chat `#10975`, Worktree `/Users/victor/.milagre/worktrees/milagre-ade/rust-codex-provider-process-adapter-fmkj`, owns `experiments/rust-providers`. Commits `725783fd`, `9ae488ed`, `726827ac` integrated as `ed88d062`, `7747faa5`, `111576b5`. 80 tests including 579 Node event traces pass. Agent fixes Sonnet lifecycle/cancel/stalled-stdin findings on latest code.
- Opus 5.5 terminal owner: Chat `#11038`, Worktree `/Users/victor/.milagre/worktrees/milagre-ade/port-milagre-terminal-owner-to-o6rs`, owns `experiments/rust-terminals`; isolated PTY implementation and real disposable-process tests, pending.
- Opus 5.5 Claude transport: Chat `#11046`, Worktree `/Users/victor/.milagre/worktrees/milagre-ade/port-claude-cli-stream-control-el8w`, owns `experiments/rust-claude`; native CLI control protocol without Milagre Node SDK sidecar, pending.
- Astra transport agent owns `experiments/rust-owner-wire`, isolated socket server/protocol foundation only. It never binds the installed profile. No owner service cutover is authorized or performed.
- In-session agents implemented frontend adapter, transport/native services, content/navigation/capture modules directly in this integration Worktree. They do not own independent branches.

Milagre CLI is not installed in PATH. Use `node apps/daemon/src/command.cjs ... --data-dir "$HOME/Library/Application Support/Milagre"`. Scoped coordination uses `command run NAME --chat '/Users/victor/Code/personal/milagre-ade#10904' --input @file`. Do not print whole `state:read` or Worktree creation responses: they contain large real transcripts. Write to temporary JSON and extract the fields needed.

## Latest implementation and checks

Full production React renderer, production preload API adapted to Tauri, persistent Rust daemon protocol, paged replies/events/reconnect, shared-theme preference inheritance with isolated Rust overlay, native utilities, official notification plugin, media/Artifact schemes, native frame-aware WKNavigationDelegate guard, hidden real-webview capture.

Rust shell tests: 38 passed, 1 optional live test ignored; all-target Clippy passes. Live daemon read test separately passed. Production TypeScript typecheck passes. Seven renderer/performance Node tests pass. Full repo unit suite now passes: 7,226 passed, 18 skipped across 660 files, `/tmp/milagre-rust-unit-hidden-fixtures.log`. Earlier failures were real fixture interference: visible `rust-owner/fixtures/projects/*/.milagre` directories were discovered as Projects. Fix `62cd189b` moves them under hidden `fixtures/.projects`; the storage agent mirrored it. An unprepared node-pty was fixed separately with the repository preparation script. Global lint must be rechecked after latest helper changes.

Latest real UI smoke passes full-layout geometry, Chat, Filters, Appearance, saved Designs, saved HTML Artifacts and sandbox raw-IPC denial. Screenshot visually inspected: production sidebar/subchats/usage/transcript/composer/Artifact layout is present. Fixed Tailwind scan root, disabled voice shape, hidden entry animations and frame guard. Known diagnostics are three unloaded Project image requests with fallback icons. Remaining latest transport/preferences changes still need reinstall. See `/tmp/milagre-rust-install.log`, `/tmp/milagre-rust-run.log`, `/tmp/milagre-rust-smoke.json`, `/tmp/milagre-rust-capture.json`, `/tmp/milagre-rust-ui.png`. Latest screenshot evidence is external to Git; do not commit screenshots or real transcript evidence.

Sonnet round 2 verified all first-round P1 fixes in source. Follow-up patches add native Blob downloads, explicit PNG clipboard, notification suppression while Electron runs, child-frame app-navigation rejection, private diagnostic writes, release build without sourcemaps, asserted preload adaptation, actual first-launch history, own Rust-instance locking, macOS hide/reopen and Quit/Terminal-close menus. Latest installed evidence must be regenerated; source review and pure tests do not verify save dialogs, clipboard or system notifications.

Dedicated real-provider QA Chat is `#11013` in review Worktree `10928`; optional config `/tmp/milagre-rust-live-probe.json`. The probe refuses a nonempty/running Chat, sends exactly once and never retries an ambiguous send. It checks real persisted reply and stream lifecycle. A second attempt must first inspect the existing result; never erase or reuse a nonempty QA Chat.

## Next integration gates

1. Confirm latest screenshot shows full layout and smoke requires actual saved Designs and HTML Artifacts, plus sandbox probe with no Tauri globals/parent DOM access. Fix failures.
2. Review Sonnet findings; fix critical issues and rerun appropriate tests. Record intentional omissions versus outstanding defects.
3. Exercise remaining retained workflows, including real controlled Chat send/stream/cancel/approval, attachments, Changes, terminals, accounts and remote/mobile sync. Existing live transport read tests do not prove these.
4. Commit tested integration checkpoint locally; install latest after checks. Merge reviewed Opus storage work and continue owner migration per BACKEND-MIGRATION.md.
5. Full completion requires standalone Rust owner, existing data compatibility/upgrade tests and equivalent workload performance evidence. Current installed Node daemon dependency means migration is incomplete.

## Final deliverable requested

User wants a phone-viewable Milagre Artifact at the end comparing Electron vs Rust performance and feature gaps. Must include matched screen/data methodology, startup/memory/CPU/bundle measurements with samples/ranges where possible, retained/omitted/unported/untested feature matrix and actual screenshot evidence. No full-migration or speedup claims while Node owner remains or workload differs. User is on phone; do not require opening local files/apps to see results. Read bundled artifacts skill before creating the final artifact. This request does not replace the migration objective.

Final comparison Artifact must also embed side-by-side actual Electron/Rust screenshots of matching screens, with callouts for visible differences and missing controls. Capture real app windows with real providers/data, not mockups or seeded harness images. User reads on iPad/phone; embed images, do not require local file access.

## Latest real-window evidence (22:42 local)

Installed release includes native downloads/images, isolated instance lock, menus, shortcut monitor and numeric Node page IDs. Production daemon PID55108 was not restarted. `/tmp/milagre-rust-live-chat-evidence.json` preserves successful real-provider QA Chat11013: one send attempt, one saved user and assistant message, text-delta and turn-completed, exact reply RUST_BRIDGE_OK, zero tool steps. Never resend to this now-nonempty Chat. Latest `/tmp/milagre-rust-smoke.json` passes all five read-only workflow checks plus content isolation and named Chat/Design/Artifact captures. Terminal metadata lists eight profiles and zero existing terminals; input/resize is unverified. Account snapshot has four providers and nine accounts. Download coverage is real detached anchor routing and native background cancellation, not interactive saving. Screenshots and reports now0600. Matching screenshot cleanup and controlled background measurements are underway; no full-app performance gain established.

Astra wire foundation committed `3a62b594`: Node client/runtime-client interoperability and seven Rust tests pass. Agent now connects read-only fixture storage through a new isolated `experiments/rust-runtime` crate. Astra content agent owns `experiments/rust-content-store` Artifact persistence with descriptor-based containment, test/commit pending. Production Node owner remains required.
