# Installed Node daemon adoption (`installed-owner`, default off)

Interim mode for the GPUI Preview (decided 2026-11-12): the Preview shows and drives the same
Chats as Electron and paired phones by attaching to the installed Milagre's running Node daemon.
The Rust owner remains the migration target; this mode exists until it has phone, upgrade and
service parity. Routines are out of scope for the Preview in this mode.

- `InstalledOwner::adopt()` finds `/tmp/milagre-<uid>/<sha256(canonical data dir)[..24]>.sock`
  (the path `apps/daemon/src/bootstrap.cjs` uses), requires a 0700 directory and a socket owned by
  this user, reads the peer PID with `LOCAL_PEERPID`, and accepts only a `daemon:status` with
  protocol 1, not closing, the same PID and the same `dataDir`. Nothing is launched.
- Every later connection re-checks the peer PID. A restarted daemon fails with
  `INSTALLED_OWNER_CHANGED`; adopt again.
- There is no shutdown, stop or restart method. The Node daemon stays the single writer.
- `known_projects()` reads `project:known`. `project(path)` mints a Project-scoped authority; open
  one Client per Project shown, as with owned runtimes.
- `chat_actions(client, provider, model)` takes `claude`, `codex`, `antigravity` or `kiro`. New
  Chats start in Worktree 1 with that provider and model; sends to existing Chats name the Chat.
- Terminal, Git and sidebar actions are the same typed capabilities as `owned-chat`.
  PR details are not exposed here yet.
- The Node daemon serves `daemon:snapshot` to `desktop-v1` clients without listing it in `methods`;
  with this feature, that capability unlocks the snapshot.

Evidence (2026-11-12): 5 unit tests in `src/tests/installed_owner.rs` (fake daemon on the real
derived socket path: adopt, wrong data dir, wrong PID, no daemon, provider/model wire shape,
snapshot capability). Read-only live probe against the installed daemon (0.232.0-beta.31):
`cargo run --features installed-owner --example installed_owner_probe` adopted it, listed 13
Projects, connected, read Project state (48 Chats), `chat:runs`, one transcript page and a full
paged snapshot. No send, `project:open` or write was made against the live daemon.
