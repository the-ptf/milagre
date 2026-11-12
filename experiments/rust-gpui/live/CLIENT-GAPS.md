# What the shared client still lacks for the Preview's daemon mode

Pinned client: `dd4993725` (`experiments/rust-daemon-client`, feature `installed-owner`). Since that commit
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
