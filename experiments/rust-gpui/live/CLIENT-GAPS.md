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
| Start the daemon | works | `daemon::Start::Installed`; without Milagre.app: "Install Milagre to use this preview" |
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
