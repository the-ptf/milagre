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
- `client.load_view(path)` loads the Project with `project:read [path, {state:false}]` instead of
  `project:open`: no recents reorder, no current-Project change. It is the read Electron's
  every-Project sidebar makes. On the first load in a daemon run the daemon reconciles Worktrees and
  resumes Chats a quit stopped, as opening that Project in Electron does; there is no read of an
  unloaded Project's Chats that avoids this (`chat:messages` needs the Project loaded). Show unloaded
  Projects by name and load one when the user opens it, as Electron's default sidebar does.
- `notifications.discard()` turns a connection into a request-only one (terminal polling, Git reads,
  actions): events are dropped instead of buffered, so it needs no `daemon:snapshot`.
- `installed_project.models(&client)` reads `agent:models` for the Project: per provider, a list
  with `recommended`. Use the first recommended model of the Chat's provider when the Chat has no
  recorded model.
- `installed_project.call(&client, method, args)` sends any command Electron's window may send
  (`src/renderer_commands.rs`, 349 names taken from `apps/desktop/electron/preload.cjs`, kept exact
  by `renderer_commands_match_preload`), minus `app-update:install`. The daemon must advertise it:
  the live daemon serves 277 of them; the other 72 are Electron-only (dictation, floating inbox,
  computers UI, editors, browser panel). Args are the preload's JSON array. The daemon checks
  arguments and Project scope as it does for Electron. This covers PR details (`pr:detail` …),
  accounts (`accounts:*`), model catalog, Branches, MCP, Details reads and Chat patches.
- Appearance and other window preferences are not daemon state: Electron keeps them in its own
  `preferences.json` (`preferences:storage`, sync IPC). A native frontend keeps its own store; the
  Tauri shell read Electron's file once and wrote its own overlay.
- Changing an existing Chat's provider or model: make `chat_actions` with the new provider/model and
  send. The daemon switches or hands off on that send, as it does for Electron's picker.
- The Node daemon serves `daemon:snapshot` to `desktop-v1` clients without listing it in `methods`;
  with this feature, that capability unlocks the snapshot.

Evidence (2026-11-12): 5 unit tests in `src/tests/installed_owner.rs` (fake daemon on the real
derived socket path: adopt, wrong data dir, wrong PID, no daemon, provider/model wire shape,
snapshot capability). Read-only live probe against the installed daemon (0.232.0-beta.31):
`cargo run --features installed-owner --example installed_owner_probe` adopted it, listed 13
Projects, connected, read Project state (48 Chats), `chat:runs`, one transcript page and a full
paged snapshot. No send, `project:open` or write was made against the live daemon.

Round 2 (2026-11-12): `load_view`, `discard`, `models`; 3 more fake-daemon tests (8 total). Live
read-only check: `load_view` on the already-loaded milagre-ade left `project:known` order unchanged,
models read returned recommended claude-opus-5-5, gpt-6.1-sol and gemini-4-argon (kiro: none).

Round 3 (2026-11-12): `call` over the preload allowlist; parity test against preload.cjs and a
fake-daemon test for allowed, refused (`daemon:stop`, `app-update:install`, `desktop:invoke`,
unadvertised, non-array args) and foreign-Client calls.
