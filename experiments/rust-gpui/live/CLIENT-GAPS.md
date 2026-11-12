# What the shared client still lacks for the Preview's daemon mode

Pinned client: `66a7795e2` (`experiments/rust-daemon-client`, feature `installed-owner`; `dd4993725` plus
`InstalledOwner::adopt_or_start` / `DaemonLaunch` and the two-step `daemon:status [{commands:true}]` handshake, which
makes `project:open`, `daemon:snapshot` and `computers:*` reachable: 344 methods live). Since `dd4993725`
`InstalledProject::call(&client, method, args)` sends any command Electron's preload may send (343 names in
`src/renderer_commands.rs`, minus `app-update:install`) when the daemon advertises it. So nearly every read and
write behind Victor's five items is reachable; what is left is listed here, by item, with the exact method names
(from `apps/desktop/electron/preload.cjs` and the handlers in `packages/core/src/runtime.cjs` /
`apps/daemon/src/server.cjs`) and payloads.

Checked against the installed daemon on 2026-11-12 (0.232.0-beta.31, read-only `daemon:status`): it advertises 318
methods; **72 renderer commands are not among them** (Electron's main process serves them). Those are the only true
client gaps; everything else below is "reachable, GPUI does not use it yet".

## The 72 renderer commands the daemon does not serve

```
app:dictation-cancel app:dictation-download app:dictation-open-settings app:dictation-prepare app:dictation-remove
app:dictation-status app:dictation-transcribe app:host-ready app:open-keybindings-file app:retry-quit
app:terminal-focused artifact-preview:register artifact-preview:release browser-panel:capture
browser-panel:clear-sign-ins browser-panel:pages browser-panel:remote-partition computers:add computers:cancel-add
computers:invoke computers:list computers:note computers:preview computers:recall computers:remember computers:remove
computers:rename computers:set-enabled editor:list editor:open floating-inbox:close floating-inbox:count
floating-inbox:dock-expanded floating-inbox:drag-begin floating-inbox:drag-end floating-inbox:drag-move
floating-inbox:drag-overlay floating-inbox:height floating-inbox:is-open floating-inbox:open-chat
floating-inbox:placement floating-inbox:preview floating-inbox:preview-key floating-inbox:select
floating-inbox:selected floating-inbox:settings floating-inbox:snapshot floating-inbox:toggle image:copy image:menu
image:save notification:completed notification:state project:choose-folder project:open project:open-at
project:reveal runtime:connection runtime:restart-host settings:floating-inbox settings:notification-chime
settings:notification-schedule settings:notify-when-waiting settings:window-background skills:open skills:reveal
update:channel update:check update:install update:release-notes update:set-channel update:state
```

Most are window chrome the GPUI app does natively (images, editors, Finder, folder picker, dictation, the floating
inbox) and need no daemon method. The ones Settings needs are in item 5.

## 1. Model switch on an existing Chat — no client gap

Wired: `chat_actions(&client, provider, model)` + `send` with `SendOptions.effort`. A different provider on an
existing Chat makes the daemon switch or hand it off on that send (`ChatHost.send`, `handoffKind`), as Electron's
picker does (Electron keeps the pick per Chat in `localStorage.chatModels`; the Preview keeps it per Chat in memory).

Typed-API nice-to-have (not blocking): `ChatActions::send` has no field for `chat:send`'s `prAction`, `compact`,
`linearIssue`, `sentFrom`, `images` or `files`. The PR pill uses `call("chat:send", [request])` instead (item 4).

## 2. Composer model label — no client gap

Wired: `agent:models [projectPath]` → per provider `[{id, name, description, recommended, efforts, defaultEffort,
fastMode, ultracode, credits}]`, merged over the maintained list as `mergeModels` does; the chip shows
`modelForOpenChat` (picked, else last ran when listed, else the provider's recommended). Not used yet:
`agent:cli-status [scope]` (the picker's missing/outdated CLI flags; reachable through `call`).

## 3. Details tab

Wired from the snapshot state (Worktree name and path, context usage, background tasks, subagents, plan) plus
`agent:ports []` and `pull-requests:snapshot [projectPath]` through `call`.

Reachable through `call`, not wired yet (no client gap):

| Row | Command | Payload |
| --- | --- | --- |
| Linear issue title | `linear:worktree-issues` | `[projectPath]` |
| Linked Projects | `canvas:links` | `[]` |
| Stop a port | `agent:stop-port` | `[chatId, pid]` (write) |
| Stop an advisor | `advisor:stop` | `[chatId, id]` (write) |
| Compact | `chat:send` | `[{...send request, compact:true}]` (write) |

Client gap (events, not commands): the live stream's `agent:ports`, `pull-requests:changed` and `accounts:changed`
channels reach the Preview's reducer but are not typed by the client; the Preview re-reads on Chat open and run end
instead. A typed `Notice` for those three channels (payloads: `AgentPorts` by Chat key; `{projectPath}`;
`{}`) would let it follow them live.

Not available anywhere: "Show in Finder" / "Open in editor" (`project:reveal`, `editor:open`, `editor:list` are
Electron-only, see the list above). The GPUI app can do these itself; they are hidden in the Preview for now.

## 4. Pills over the composer

Wired: Tasks (the Chat's `plan` in the state), Subagents (`subagents` in the state), the PR blocker pill
(`pull-requests:snapshot` + `pullRequestAction`), sent as Electron sends it: `chat:send [{projectPath, worktreeId,
sessionId, provider, model, body, clientMessageId, permissionMode, replies, tldrEnabled, prAction:{action, pr,
url}}]` through `call`.

Reachable, not wired yet: the review-comments pill and the Merge pill need the PR panel: `pr:detail [{cwd, number}]` (`cwd`: the
Worktree's folder; its open threads), `pr:merge [request]`, `pr:ready`. Archive a subagent:
`chat:archive-subagent [projectPath, sessionId, id, archived]`, `chat:archive-finished-subagents [projectPath,
sessionId]` (writes). No client gap.

## 5. Settings

Wired: Appearance (the Preview's own `preferences.json`; Electron keeps it in its renderer too) and Accounts read-only
(`accounts:list [false]`). Every other section shows "Not available in this preview".

Reachable through `call` (no client gap; GPUI's pages still render fixture state and need wiring):

| Section | Commands |
| --- | --- |
| Accounts (writes) | `accounts:add`, `accounts:select`, `accounts:login`, `accounts:cancel`, `accounts:remove` `[provider, value]`; `accounts:scope [scope]`, `accounts:assign` |
| Models | `agent:models [scope]`, `agent:cli-status [scope]`, `agent:provider-updates []`, `agent:update-cli [provider, version?]` |
| Usage | `usage:cached [scope]`, `usage:read [scope]`, `token-usage:read [request]` |
| Keybindings | `keybindings:read []`, `keybindings:set-command`, `keybindings:reset`, `keybindings:reset-command` |
| Skills | `skills:list [projectPath\|null]`, `skills:read` |
| MCP | `mcp:accounts []`, `mcp:check`, `mcp:definition`, `mcp:save`, `mcp:remove`, `mcp:toggle`; `local-mcp:status`, `local-mcp:create`, `local-mcp:update`, `local-mcp:revoke`, `local-mcp:rotate` |
| Worktrees | `storage:worktrees`, `storage:remove-worktree`, `worktree-setup:read`, `worktree-setup:save`, `files-to-copy:read`, `files-to-copy:save` |
| Project (Branches) | `project-git:read [projectPath]`, `project-git:save`, `project:branches` |
| Chat / Done / Babysit / Context | `context:settings:read`, `context:settings:save`, `done:settings:read`, `done:settings:save`, `babysit:settings:read`, `babysit:settings:save` |
| Devices / phone | `devices:list`, `devices:pending`, `devices:allow`, `devices:deny`, `devices:remove`, `phone:status`, `phone:set-enabled`, `phone:set-lan` |
| Experimental | `routines:enabled:*`, `linear:enabled:*`, `linked:remote-enabled:*`, `limits:*`, `computer-use:settings:*`, `simlock:settings:*` |
| About | `app:version []` |

Client gaps (Electron-only, so a daemon method or a GPUI-native replacement is needed):

| Section | Missing method | What it does in Electron |
| --- | --- | --- |
| Notifications | `settings:notify-when-waiting`, `settings:notification-chime`, `settings:notification-schedule`, `notification:state` | main-process notification settings and OS permission state |
| General (window) | `settings:window-background`, `settings:floating-inbox` | window material, floating inbox |
| General (editor) | `editor:list` | installed editors for "Open in" |
| Speech model | `app:dictation-status`, `app:dictation-download`, `app:dictation-remove` (and the rest of `app:dictation-*`) | local speech models |
| Browser | `browser-panel:clear-sign-ins`, `browser-panel:pages` | Electron's browser partitions |
| Computers | `computers:list`, `computers:add`, `computers:remove`, `computers:rename`, `computers:set-enabled`, `computers:invoke` | paired computers (Electron's computer service) |
| About / updates | `update:state`, `update:check`, `update:install`, `update:channel`, `update:set-channel`, `update:release-notes` | app updates (the Preview has its own bundle) |
| Keybindings | `app:open-keybindings-file` | reveals the file |

The Preview's GPUI-native options for these (its own notifications, window, editors list, updates) do not need the
daemon; Computers needs either the daemon to serve `computers:*` or the client to talk to the computer service.

## 6. Sidebar writes (`src/sidebar_writes.rs`)

Wired through `call` on a request-only connection of the Chat's Project (loaded with `load_view` first), with the
preload's arguments: Delete (`agent:interrupt [chatId]` when running, `chat:patch [path, id, {archived: true,
unread: false}]`, then after the 6-second Undo `chat:delete [path, id]`; Undo is the typed `SidebarActions::restore`),
Reload (`chat:reload [chatId]`), Detach from parent (`chat:detach [path, id]`), Unlink issue
(`worktree:unlink-issue [{projectPath, worktreeId}]`), a pinned Run Chat kept (`chat:patch {kept: true}`), Filters ›
Projects (`project:set-hidden [path, hidden]`; the hidden set read from `project:recent []`, since the snapshot's
Projects do not carry `hidden`). Pins, hidden computers and Show are device-local, as in Electron, in the Preview's
own `sidebar.json`.

Client gaps:

| Item | Gap |
| --- | --- |
| Add Project | `project:open [folder, {takeNotice: true}]` is served, but `server.cjs` lists it in `methods` only to `daemon:status [{commands: true}]`; the client's status probe sends `[]`, so `call` refuses it. Needs the client to ask with `{commands: true}` (or a typed `InstalledOwner::open_project(folder)`). The folder dialog is GPUI's own (`project:choose-folder` is Electron-only). |
| Delete with Worktree cleanup | Only `HIDE_ONLY` is wired. Electron's `remove` mode (a Milagre Worktree no other Chat uses, checked clean) also needs `checkArchive`'s reads (`worktree:status [path, base]`, `worktree:roots []`, busy Terminals) and `worktree:remove [path, options]`; not ported, so every Worktree stays. |
| Link with… / Remove Link with… | `canvas:links`, `canvas:link-add`, `canvas:link-remove`, `canvas:link-restore`, `linked:grant` are served; the Preview does not feed the sidebar's Links yet ("Link and ask" would also send a Chat message). Still off. |

## Round 4 (2026-11-12): without Electron, on client `66a7795e2`

The Preview now runs with Milagre.app closed: `InstalledOwner::adopt_or_start(&DaemonLaunch::find_installed_app()?)`
starts the app's own daemon in Node mode when none runs (never in read-only mode; never stopped or replaced; left
running on quit), and the main-process duties Electron had are the Preview's own.

| Item | Status | How |
| --- | --- | --- |
| Start the daemon | works | `daemon::Start::Installed`; without Milagre.app: "Install Milagre to use this preview" (replaced in Round 7 by the bundled daemon) |
| Notifications, chime, dock badge | works | `notify.rs` (UNUserNotificationCenter in the bundle; settings seeded once from Electron's `preferences.json`) |
| Settings › Notifications | works | kept in the Preview's `preferences.json` |
| `milagre://` | works (pairing links only) | `deeplinks.rs`; Electron registers no scheme |
| Show in Finder / Open in editor | works | `opener.rs`, native (`editor:list`, `editor:open`, `project:reveal` are Electron-only) |
| Window frame, sidebar collapse | works | `window-state.json` in the Preview's folder (the GPUI sidebar has no width to keep) |
| Live events | works | `agent:ports`, `pull-requests:changed`, `accounts:changed`, `canvas:links-changed` |
| Add Project | works | `project:open` now listed to the client's `{commands:true}` handshake |
| Delete with Worktree cleanup | works | `worktree:roots`, `worktree:status`, `worktree:remove` as `checkArchive` |
| Link with / Remove Link with | works | `canvas:*`, `linked:grant`; "Link and ask" tested on the fake daemon only |
| Computers | off | see below |

### `call()` refusals found

- `computers:vault-status []`: refused before any request, `Capability { required: "renderer:computers:vault-status" }`.
  It is not one of the preload's renderer commands (Electron's main process asks it, `computer-unlock.cjs`), so the
  client's allowlist leaves it out. The Preview shows computers only with the vault unlocked, so they stay hidden.
  Needed: the client allowing `computers:vault-status` (a read) for installed owners. Even then a daemon the Preview
  started itself stays locked: unlocking takes `computers:unlock [{key}]` with the key Electron seals in this Mac's
  keychain (`safeStorage`), which a native frontend would have to read or own.
- `editor:list`, `editor:open`, `project:reveal`, `settings:notify-when-waiting`, `settings:notification-chime`,
  `settings:notification-schedule`, `notification:state`: Electron-only (not daemon methods), done natively instead.
- `daemon:stop`: advertised by the daemon, refused by `call()` (never sent).

## Round 5 (2026-11-12): PR panel, PR chip, account switcher and computers, on client `1ed6ff33`

Re-pinned to `1ed6ff33b` (`66a7795e2` plus `InstalledProject::computers_vault_status` and `unlock_computers`). Every
write below was exercised on the fake daemon only (`live/src/tests/pr_accounts.rs`, `remote_computers.rs`); against
the real daemon the Preview made reads only (`pr:detail`, `pr:diff-files`, `pr:diff-file`, `pr:labels`,
`pr:reviewer-candidates`, `pull-requests:snapshot`, `accounts:scope`, `limits:resume-at-reset:read`,
`computers:vault-status`, `computers:list`).

| Item | Status | Commands |
| --- | --- | --- |
| PR panel | works | `pr:detail [{cwd, number}]` (cwd: the Chat's Worktree folder), every 30 s while the window is active, after every write and on `pull-requests:changed`; files `pr:diff-files [{cwd, base, head}]` + `pr:diff-file [{cwd, base, head, path, oldPath}]` (≤200, again only when the head moved); `pr:labels`, `pr:reviewer-candidates [{cwd}]` once per folder |
| PR writes | works (fake only) | `pr:merge [{cwd, number, method, admin}]`, `{…, auto: true}`, `{…, disableAuto: true}`; `pr:ready [{cwd, number}]` / `{…, draft: true}`; `pr:request-reviewers`, `pr:set-labels`, `pr:reply`, `pr:comment`, `pr:resolve-thread`, `pr:delete-comment`, `pr:submit-review`; `{ok: false, message}` takes the change back with the message |
| Review comments pill, Merge #N pill | works | open the PR tab (no send), hidden while it shows; count = open threads of the shown PR |
| PR blocker pill ("Update branch" …) | fixed | sent with the Chat's own `worktreeId` (was always 1) and a recommended model when the Chat has none (was an empty model); the action card ("Update branch" · "Pull request #N") and the running row show at once, the pill hides (`updateBlockerDismissals`), a refusal brings it back and says why; saved `pr-action` messages render as the card, not the prompt |
| Sidebar PR chip | works | `pull-requests:snapshot` for every loaded Project feeds the rows (the branch PR included, `chatPullRequests`); a click opens the Chat on its PR tab with that PR; the hover card's PR rows open the PR on GitHub |
| Usage card picker / refresh | works (writes fake only) | `accounts:scope [projectPath]`, `accounts:assign [projectPath, provider, id \| null]`, `usage:read [projectPath]` |
| Settings › Accounts default | works (fake only) | `accounts:select [provider, id]` (ready accounts only, Electron's radio) |
| Usage-limit card | works (fake only) | choices = `limitChoices` over `accounts:scope`; `chat:limit-switch [projectPath, sessionId, provider, accountId]`; "Continue at" when `limits:resume-at-reset:read` answers and the reply is the Chat's `limitTurn`: `chat:limit-resume [projectPath, sessionId, sourceMessageId]`, Cancel `chat:limit-resume:cancel [projectPath, sessionId, sendId]`; Add / Manage accounts open Settings › Accounts |
| Computers vault | works | typed `computers_vault_status`; `unlock_computers` only when locked (launch, every adoption, before `computers:add`, on `computers:set-enabled(true)`), never in read-only mode; `KEYCHAIN_UNAVAILABLE` → "Allow Keychain access to use your paired computers." |
| Remote Chats | read-only | `computers:invoke [id, project:recent \| state:read \| chat:runs \| chat:messages, args]` on one request-only lane connection; rows and transcripts show, sends to them are refused here |
| `computers:event` / `computers:forgotten` | works | remote turn ends and waiting notices notify; forgotten drops the computer's rows and notifier state |

Remaining gaps:

- Remote Chats are read, not written: sending, approvals and sidebar writes on another computer's Chat go through
  `computers:invoke` with the remote method, which the Preview does not route yet. Remote state is read again on
  `computers:event` (debounced) and `computers:changed`, not applied event by event.
- No GPUI UI for `computers:set-enabled` / `computers:add` beyond the `milagre://` pairing link (the base's computer
  pages are read-only in preview); `LiveController::set_computers_enabled` exists for when it has one.
- PR panel: the Worktree's uncommitted files ("N files not in the PR yet") are not counted (the daemon's Changes are
  the Project's checkout); `pr:image` (private images in descriptions) is not fetched; the PR the panel shows is
  picked from the chip or the row's first PR, with no panel menu to switch between a Chat's several PRs.
- The PR chip has no tooltip of its own (Electron's `title`); the row's hover card lists the PRs instead.
- `unlock_computers` has not run against the real Keychain item from the Preview (the real vault was already
  unlocked by Electron, so the status read short-circuits it).

## Round 7 (2026-11-12): the Preview's own daemon, on client `a59bbb9d`

Re-pinned to `a59bbb9d5` (`1ed6ff33b` plus `DaemonLaunch::bundle` and the live Keychain check). The Preview now runs on
a Mac without Milagre.app.

| Item | Status | How |
| --- | --- | --- |
| Bundled daemon | works | `scripts/preview-daemon-macos.sh` runs the backend's `bundle-node-daemon.sh` unchanged on a `git archive` of the client commit (never in the backend's checkout) and caches it in `target/preview-daemon/<commit8>-<version>-node<version>/` (284 MB); `bundle-preview-macos.sh` copies it to `Contents/Resources/milagre-daemon` at the installed Milagre.app's version (else `--daemon-version`, else the live crate's) |
| Which daemon starts | works | `daemon::Start::detect`: Milagre.app when installed (`find_installed_app`, its version matches Electron's), else `Start::Bundled` (`DaemonLaunch::bundle` beside the executable), else `Start::Missing`; one already running is adopted either way, never stopped |
| Missing or damaged bundle | works | "This Preview's own daemon is missing or damaged, and Milagre isn't installed…"; a bundled start that fails or times out says "This Preview's own daemon didn't start…" with the client's error |
| Test seams | works | `--no-installed-app` (no Milagre.app lookup), `--daemon-bundle DIR`; never moving `/Applications/Milagre.app` |
| Signing | works (ad hoc) | `scripts/macos-sign.sh`: every Mach-O and nested bundle (`bin/node`, `pty.node`, `spawn-helper`, agent-desktop and serve-sim helpers, `LiveKitWebRTC.framework`, `ServeSimPasteboard.app`), deepest first, then the app; `codesign --verify --deep --strict` passes. `dist-macos.sh --cert` signs the same way with the hardened runtime and gives Node `packaging/node-entitlements.plist` (JIT, unsigned executable memory, library validation off); not notarized yet |
| Settings › About | works | the Version row says the Preview runs its own daemon and what it lacks (below) |

Checks (2026-11-12): the start test covers app first, bundled when the app is missing, damaged and absent bundles
(`tests::daemon::a_window_starts_the_daemon_when_none_runs`). Live, on a throwaway HOME and data folder with the built
app and `--no-installed-app`: the app started the bundle's own Node in its own session (`bin/node … serve`), adopted
it once a Project was opened, `tests::bundled` opened a Terminal through `LiveTerminals` and read a command's output
(node-pty under the bundled Node), Quit left the daemon running (reparented to PID 1), a second launch adopted the same
PID, and it was stopped by that PID. Against the real profile the built app with no arguments chose Milagre.app's
daemon and adopted the running one (no start).

Sizes: the app 118 MB without the daemon, 401 MB with it; the ad hoc zip 36 MB before, 138 MB after.

Remaining gaps:

- No `cloudflared`: Milagre.app's `bin/` is not there, so a phone's Cloudflare tunnel (`phone.cjs` named tunnel) and
  phones' views of this computer's localhost pages (`browser:page-url` quick tunnels) make the daemon download the pinned,
  checksummed cloudflared from GitHub into `~/.milagre/bin` on first use instead. Neither has a row in the Preview (the
  Devices page is hidden), so the note sits under Settings › About › Version. The relay (`relay.milagre.cloud`) and
  computers' links do not use cloudflared.
- Paired computers: the vault key is Electron's (`safeStorage`); without Milagre.app there is none, so `computers:add`
  is refused unless the key file is set up with `milagre computers setup-key`. Said in the same About note. (Closed in
  Round 8: client `bf698770` creates the first key.)
- The bundle carries x64 and Linux helper binaries the arm64 Preview never runs (node-pty, agent-desktop; about 12 MB),
  as the backend's script leaves them. (Closed in Round 8: `901e2fd1d`.)
- `--cert` not run (no Developer ID certificate on this Mac yet) and nothing notarized. The entitlements were checked
  with an ad hoc hardened-runtime signature: with them the bundled Node opens a node-pty terminal; without them it dies
  at start. A notary run may still reject `ServeSimPasteboard.app` (an iOS-simulator app inside node_modules).

## Round 8 (2026-11-12): client `bf698770`, cold start, Project pictures

Re-pinned to `bf6987702` (`a59bbb9d5` plus `901e2fd1d`: the bundled daemon keeps only this Mac's architecture; and
`unlock_computers` creating the first vault key and "Milagre Safe Storage" Keychain item as Electron does,
`ComputerUnlock::Created` in place of `NoVault`).

| Item | Status | How |
| --- | --- | --- |
| Cold start (Milagre.app closed) | fixed | A fresh daemon has loaded no Project, so the snapshot the window opened on listed none and the onboarding layer, which looked once as the window opened, showed "Choose your agent". A live window (`PreviewMode`) no longer starts onboarding from the data source; a sync that finds nothing loaded loads the most recently opened known Project (`project:read {state:false}`, as Electron's window opens its current Project on launch; never `project:open`, never read-only), shown "Loading…" in the sidebar meanwhile |
| Daemon with no Project | unchanged | "No Projects yet: add one with Add Project." (onboarding's steps are fixture data and would open nothing on the daemon) |
| Project pictures | works | `project:image [path]` once per loaded Project per run (`live/src/images.rs`): data URLs decoded, GitHub avatar URLs fetched with `/usr/bin/curl` (https, `avatars.githubusercontent.com` only, 5 MiB, 5 s), a picture that does not decode keeps the letter. Drawn in the sidebar row's mark, the rail tile and the new-Chat Project picker (a 16px tile, as `NewChatHeading`), contained in the tile's size, fill and rounding |
| First computer key | works (fake only) | `Created` needs no notice; the About note no longer says paired computers are unavailable without Milagre.app. Test builds never reach the login Keychain (no stand-in: the vault stays locked) |

Checks (2026-11-12): clean `git archive` export, strict Clippy and tests for the base crate (1449), live (50) and
daemon-check (23); owned suite (2 pass, no process left); `check-preview-exits` (every path, apps left none). New
fake-daemon tests: `tests::cold_start` (daemon up after the window opened; first sync already empty, which failed
before the fix; no Project at all; pictures) and `remote_computers::a_first_vault_key_is_created_without_milagre`.
Live, throwaway HOME and data folder, built app with `--no-installed-app`: empty, the sidebar says to add a Project;
then a Project opened through the daemon's CLI, the daemon stopped by its PID and the app opened again: it started
a new bundled daemon (nothing loaded), loaded the Project and came up on its new-Chat screen, not onboarding. Against
Victor's daemon, read-only: `--snapshot` showed the rows' GitHub and icon pictures; the built app with no arguments
stayed up 10 s and quit on SIGTERM, daemon left running.

Sizes: bundled daemon 285 MB → 258 MB (257 MB in the app); app 401 MB → 375 MB; ad hoc zip 137.8 MB → 124.8 MB.

Remaining gaps:

- Details shows no Project tile in either app (Electron's Details has none), so no picture there; Settings' Project
  rows still draw the letter (their view model carries no path yet).
- Onboarding stays fixture-only in the Preview: a daemon with no Project shows the Add Project notice instead.
- Avatars come through `curl`; a Mac offline at launch keeps the letter until the next run.

## Settings sections (2026-11-12)

Listed sections draw their full pages ([`PreviewSettings`]); rows this window cannot honour are hidden and out of
search (`live/src/settings.rs` `HIDDEN`). Daemon reads go on one request-only connection when the window opens and
each time Settings opens; each change is written at once with Electron's command and arguments (`settings.rs` has the
full table). Every write is tested on the fake daemon only.

| Section | Backed by | Status |
| --- | --- | --- |
| General | `done:settings:*`; Keep awake `app:set-keep-awake` + this window's `preferences.json`; editor in `preferences.json` (Open in editor uses it) | listed; Chat order, Chat list, Plan usage hidden (the sidebar does not follow them) |
| Appearance | this window's `preferences.json` | listed (unchanged) |
| Chat | `context:settings:*` (followUps); Reasoning and Tool calls in `preferences.json`, the transcript follows them | listed |
| Notifications | this window's notifier | listed (unchanged) |
| Keybindings | `keybindings:read`, `keybindings:set-command`, `keybindings:reset`; Open keybindings.json opens the file natively | listed, this computer only (paired computers' are not read) |
| Models | `context:settings:*` (Auto compact, thresholds) | listed; New chats, Replies, Context size, Show Compact hidden (the composer and sends fix them) |
| Accounts, Usage | `accounts:*`, `usage:*` (the PR agent's) | listed (unchanged) |
| Skills | `skills:list`, `skills:read` reachable | hidden: the page's fixture model has no data hook yet |
| MCP | `mcp:*`, `local-mcp:*` reachable | hidden: not wired (the answers carry server env, the sheet writes need care) |
| Browser | Electron's browser partitions (`browser-panel:*` Electron-only) | hidden |
| Worktrees | `main-sync:default:*`; `storage:worktrees` + `storage:remove-worktree` (the cleanup dialog's `CleanupRemover`) | listed |
| Integrations | `linear:*`, `babysit:settings:*` reachable | hidden: the page's state is a fixture with no data hook yet |
| Devices, This Mac | `devices:*`, `phone:*` reachable; computers are the computers agent's | hidden |
| Projects' pages | `project-git:*`, `files-to-copy:*`, `worktree-setup:*`, `main-sync:*` reachable | hidden |
| Experimental | `linked:remote-enabled:*`, `device-notes:*` | listed; Ultracode Fatality and New Chat stats hidden; floating inbox Electron-only |
| About | `app:version`, `app-update:auto:*` | listed; Release channel and Updates hidden (`update:*` Electron-only) |
| Speech model / Voice | `app:dictation-*` Electron-only | not in the port |

No client gap blocks the hidden ones except Browser and Speech (Electron-only); the rest need GPUI-side wiring.

## Round 9 (2026-11-12): client `09a75bfc`, the real Keychain kept to the installed profile

Re-pinned to `09a75bfc3` (`bf6987702` plus `unlock_computers` refusing any data folder but the installed profile's
with `KEYCHAIN_OTHER_PROFILE`, before any Keychain read, and `unlock_computers_with_stand_in(client, password)` for tests
and throwaway profiles). The Preview's test seam is now `Daemon::set_unlocker(Unlocker::StandIn(b"test-password"))`,
which runs the client's own flow against the fake daemon (a 0600 `computer-vault-key.json` sealed in the throwaway data
folder, `computers:unlock` with the key it opens); `Unlocker::Fail` stands in only for a refused Keychain read, which
the stand-in cannot produce. Test builds with no stand-in still never call the real unlock (the vault stays locked).
`KEYCHAIN_OTHER_PROFILE` is shown as a locked vault: computers hidden, no sidebar notice; pairing says "Paired computers
are unavailable here: this daemon doesn't use Milagre's own profile."

## Designs and Artifact tabs, PR skeleton (2026-11-12)

The Designs and Artifact tabs now run on Milagre's daemon in daemon mode (`live/src/canvas.rs`), with the commands
Electron's `ArtifactsProvider` / `ArtifactCanvas` / `ArtifactPage` send through `window.milagre.artifacts`. No client
gap: every read is a renderer command the daemon serves, sent with `InstalledProject::call`.

| What | Command | Status |
| --- | --- | --- |
| The Chat's designs and page | `artifact:list [{chatId}]` (inline replies left out) | works; decides whether each tab shows (`Panel::set_live_canvas`) |
| Every kept version of a design | `artifact:get [{chatId, id, version}]` (`document`), versions `version - versions + 1 ..= version` | works; versions are immutable, read once per Chat |
| The page, its tabs and files | `artifact:get [{chatId, id}]`, then `artifact:asset [{chatId, name, offset}]` per file in 256 KiB chunks (base64) | works; served from the `milagre-artifact` protocol under Electron's CSP (`document.rs`, the page helper first), as before |
| Sent comments | `artifact:comments [{chatId}]` | works; design pins numbered per design, green once resolved; page pins drawn by the page's helper |
| Refresh | the live stream's `agent:event`: an `artifact` step (or `design_*` / `artifact_*` tool, `design_delete`, "Resolved a design comment") in the shown Chat, then its `step-completed` or the turn's end, as Electron's `revisionKey` / `designActivity`; Chat open; resync; after a write | works |
| Delete a design | `artifact:delete [{chatId, id}]` on a write connection | works (fake daemon only); refused in read-only mode, the board comes back with the read |
| Choose a variant + Send | the composer's `chat:send` with Electron's `designFeedbackMessage`: `I chose the design "<title>" (<id>, version <n>). Continue from this one.` | works (fake daemon only) |
| While reading | skeletons (`panel::skeletons`), and the PR panel's "Loading the PR…" line is now a skeleton of its layout | works |

Gaps (not wired, recorded):

- **Resolve a comment**: there is no renderer command. Resolving is the agent's `artifact_resolve_comment` tool
  (`chat-artifacts.cjs` `resolveComment`), which Electron's window never sends either; the window only shows the
  resolved state it reads. A client/daemon method would be needed for a person to resolve one.
- **Add a comment**: `artifact:add-comments [{chatId, comments}]` is reachable (and the fake daemon answers it), but
  the base crate has no comment mode yet (pin placement, the bubble, the text field) on the board or the page, so
  nothing sends it; Send carries the choice only.
- **Edit / design editor Save** needs `artifact:apply [{chatId, id, expectedVersion, operations}]`; the base editor
  saves whole documents, not operations. Edit is hidden in daemon mode.
- **Share** (`artifact:share-page`, `artifact:page-shares`, …) is confined to the desktop (`confine.cjs` denies it
  remotely) and not ported.
- **Live agent drafts** (`useLiveDesignFeed`: designs drawn while the agent writes them) are not ported; the board
  updates when the step ends.
- **Snapshots of the page**: the Artifact page is a native WKWebView over the GPUI window; `CGWindowListCreateImage`
  of a window that is never activated (snapshot mode) shows the tab, its pills and the page area, but not the page's
  own drawing. The webview probe (`MILAGRE_GPUI_WEBVIEW_PROBE=1`) on the real page confirmed it loaded with the helper
  and is placed over the body.
- Snapshot seeds only open a Chat the sidebar lists (or `MILAGRE_GPUI_LIVE_CHAT=<key>`, which may be a Subchat).
