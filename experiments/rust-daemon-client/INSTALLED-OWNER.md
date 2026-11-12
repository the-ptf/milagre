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
- `InstalledOwner::adopt_or_start(&DaemonLaunch)` adopts a running daemon and otherwise starts one
  the way `apps/daemon/src/bootstrap.cjs` does: `<exe> <cli.cjs> serve --data-dir D --app-version V
  --cwd /`, own session (setsid), output appended to `daemon.log` (rotated at 10 MiB), waits up to
  15 s. A live `runtime.lock` owner is waited for, never raced; a dead one doesn't block the start.
  A running daemon is never stopped or replaced, whatever its version: Electron replaces hosts older
  than itself, so a native frontend must not fight it.
- `DaemonLaunch::find_installed_app()` runs the installed Milagre.app's own daemon on that app's
  executable with `ELECTRON_RUN_AS_NODE=1`: Node only, no window, no Electron UI process, and the
  version that app expects. `DaemonLaunch::node(..)` is for a bundled Node on a computer without
  Milagre.app. `ELECTRON_RUN_AS_NODE` and `MILAGRE_BUNDLED_BIN_DIR` are set or cleared explicitly,
  since a frontend started from a Milagre terminal inherits them.
- `installed_project.unlock_computers(&client)` unlocks the computer vault without Electron, as
  `computer-unlock.cjs` does: reads `computer-vault-key.json` (private file checks), opens Electron's
  safeStorage seal (Chromium "v10": AES-128-CBC, PBKDF2-HMAC-SHA1 of the login Keychain item
  "Milagre Safe Storage" / "Milagre Key", salt "saltysalt", 1003 rounds, IV of spaces) and sends
  `computers:unlock`; imports pre-vault pairings when `needsLegacyImport`. On a computer that never
  had Milagre.app (no vault, no key) it creates both as Electron would: a random 32-byte key sealed in
  Electron's format, and the Keychain item if missing (16 random bytes, base64, as Chromium does), so
  Milagre.app installed later reads the same key. Result `Created`. Already unlocked or
  file-keyed vaults are left alone; a missing wrapper for an existing vault is an error, never a new
  key. Reading the Keychain item from another app shows the macOS prompt once per app signature (an
  ad-hoc re-signed build asks again). `computers_vault_status(&client)` is the typed status read.
- `DaemonLaunch::bundle(dir)` starts a daemon from `scripts/bundle-node-daemon.sh <out> --version
  <v>` output, for a computer without Milagre.app: Node 24 (`bin/node`), daemon + core + shared with
  production dependencies from the npm cache, and `manifest.json`. 258 MB on disk (was 285 before dropping other platforms' binaries), 96 MB as
  tar.gz (Milagre.app is 599 MB). The SDK's bundled Claude binary is dropped (Milagre runs the
  user's installed `claude`), node-pty keeps only macOS prebuilds and gets its `spawn-helper`
  marked executable; the script fails unless a real pseudo-terminal opens under that Node. No
  `cloudflared` is bundled, so tunnel features need Milagre.app's `bin/`.
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
- Handshake: the Node daemon lists the desktop's own commands (`project:open`, `daemon:snapshot`,
  `computers:*` with `computers:unlock` and `computers:vault-status`) only to a client asking
  `daemon:status [{commands:true}]`, as Electron's desktop does. When the daemon advertises
  `desktop-commands-v1`, the client asks a second time and keeps that method list (344 live vs 318).
  The Rust owner doesn't advertise it and keeps its one-step handshake.

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

Round 4 (2026-11-12): daemon start. 5 tests with a fake daemon started through the real launch path
(start once then adopt, exact argv, own session, env cleared, live lock waited for, dead lock taken
over). Real check: `installed_owner_start` started Milagre.app 0.232.0-beta.31's daemon in Node mode
on a throwaway profile in 0.27 s, detached (parent PID 1), served 14 capabilities; stopped with
SIGTERM afterwards. The real profile's daemon was not touched.

Round 5 (2026-11-12): two-step handshake. Live read-only check: `computers:list` through `call()`
returned this computer plus 4 paired computers; `project:open` is now reachable for Add Project;
`daemon:stop` is advertised but still refused by `call()`. Multi-computer already lives in the
daemon (`apps/daemon/src/computers.cjs`, capability `computer-management-v1`); what remains for a
frontend without Electron is supplying the vault key with `computers:unlock`.

Round 6 (2026-11-12): computer vault unlock. 6 tests: an independent openssl known-answer vector for
v10, wrong password and malformed seals refused, locked vault unlocked with the sealed key,
unlocked and file-keyed vaults untouched, missing wrapper never replaced, world-readable key file
refused, legacy pairings imported. Live (2026-11-12, Victor present): the ignored test `real_keychain_opens_the_installed_vault_key`
opened the installed vault key with the real Keychain item after one "Allow": a valid 32-byte key,
not printed, nothing sent to the daemon.

Round 7 (2026-11-12): bundled Node. Real check: the bundle's daemon started on a throwaway profile
in 0.49 s from its own Node (parent PID 1, 14 capabilities), then stopped and deleted. First build
caught node-pty's `posix_spawnp failed` (spawn-helper not executable without install scripts).

Round 8 (2026-11-12): first key created without Electron, replacing `milagre computers setup-key`
for the Preview. Real check (ignored test `real_daemon_created_key_survives_a_restart`, throwaway
profile, test password instead of the Keychain): Milagre.app's daemon accepted the created key, and
after a daemon restart the saved key unlocked it again.

Live end-to-end (2026-11-12 17:00, Victor present, run by GPUI Chat #11899): with Milagre.app quit
and its daemon stopped, the GPUI Preview (c196660e, client a59bbb9d5) cold-started Milagre.app's
daemon in Node mode, the daemon came up locked, Victor allowed the Keychain prompt, and the
Preview's own `unlock_computers` brought all 5 paired computers online over the relay before
Milagre.app was reopened. Electron then adopted the Preview-started daemon.
