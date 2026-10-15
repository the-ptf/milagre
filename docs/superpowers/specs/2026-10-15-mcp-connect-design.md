# Settings › MCP: add, sign in to and switch MCP servers from Milagre

Date: 2026-10-15. Status: designs approved, awaiting spec review. Issue: #376.

Follows [2026-10-09-mcp-settings-design.md](2026-10-09-mcp-settings-design.md), whose PR 1 (the read-only tab, #384)
shipped. This spec replaces that spec's PR 2 and PR 3: it covers everything left in #376 in one round, changes how
sign-in works, and redesigns the tab. Where the two disagree, this one wins.

## Goal

A user connects any MCP server to Milagre without a terminal: add it, sign in to it, turn it on or off per account,
and see at a glance which servers need attention. Desktop and phone ship together.

## What changed since the 2026-10-09 spec

| Topic | 2026-10-09 | Now |
| --- | --- | --- |
| Sign-in | Handed to each CLI: Codex app-server login, a Milagre terminal running `claude` + `/mcp` for Claude | Milagre runs it for both providers through their own APIs (below). No terminal. Milagre still stores no tokens. |
| Where a new server goes | A sheet with Claude, Codex and Everywhere checkboxes | One choice, default **Everywhere**: Milagre's own list, loaded into Milagre Chats on every provider. "Claude only" or "Codex only" writes that CLI's user config. |
| Project, plugin and claude.ai servers | Read-only | Still not editable, but they get the on/off switch and Sign in. |
| Layout | Rows with chips per account | Redesigned (Screens below). |
| Order of work | PR 2 then PR 3 | One round; the plan may split it into PRs. |

Unchanged: status is checked live when the tab opens; edits are user scope only; writes go through each CLI's own
commands; turning a server off is Milagre's off list applied at Chat start; #375 carries user servers to added
accounts, with the deletion fix.

## Sign-in, as probed on 2026-10-15

**Claude.** The Agent SDK (0.3.288, CLI 2.1.299) has unlisted Query methods. Verified live against `expo`:

- `mcpAuthenticate(name)` returns
  `{ authUrl, requiresUserAction, callbackExpected, redirectScheme: "localhost", state, callbackPort }`.
  `redirectUri` is optional.
- The CLI opens a localhost listener on `callbackPort`, a fresh port per call, and does the code-for-token exchange
  itself. It does not open the browser; the host opens `authUrl`.
- No completion event. `mcpServerStatus()` moves from `needs-auth` to `connected` once the exchange finishes.
- claude.ai connectors (`claudeai-proxy`) return a claude.ai URL with `callbackExpected: false`. They finish on
  claude.ai, then show up on the next status check.
- Command servers return the error `Server type "stdio" does not support OAuth authentication`.
- Tokens go in the account's secure storage: the keychain on macOS, `.credentials.json` under `CLAUDE_CONFIG_DIR`
  otherwise. They are keyed by server name and config, so each account signs in separately.

**Codex.** From the app-server schema (codex-cli 0.160.0):

- `mcpServer/oauth/login { name, threadId?, scopes?, timeoutSecs? }` returns `{ authorizationUrl }`. Codex runs the
  callback and token exchange.
- The completion notification is `mcpServer/oauthLogin/completed { name, success, error? }`.

**Antigravity.** ACP has no MCP sign-in. An Everywhere URL server that needs OAuth reads "Sign-in not supported" on
Antigravity.

### The sign-in flow (`mcp:signIn`)

1. Sign in on a row signs in every account that needs it, one at a time, one browser tab each. The row reads "Finish
   in your browser, then come back." and shows Cancel.
2. Claude, per account:
   1. Start an idle SDK session in the account's environment, the same pattern as `checkClaude`.
   2. Pass that account's Everywhere servers through `mcpServers`, with exactly the config a Chat would pass, so the
      token key matches.
   3. Call `mcpAuthenticate`, open `authUrl` with the shell, and poll `mcpServerStatus()` every second.
   4. Stop when the server reads `connected`, on Cancel, or after 5 minutes, then close the session. The session has
      to stay open until then because the CLI hosts the callback.
3. Codex, per account:
   1. Start an app-server with the account's `CODEX_HOME`, call `mcpServer/oauth/login`, and open `authorizationUrl`.
   2. Wait for `mcpServer/oauthLogin/completed`, or for Cancel or 5 minutes.
   3. An Everywhere server is not in Codex's own config. Pass `threadId` of a thread started with Milagre's thread
      config. The plan verifies this first. If login can't see thread-config servers, that chip reads "Add it to
      Codex to sign in" and offers Codex only.
4. When it finishes, that account is checked again and the row moves out of Needs sign-in.
5. Sign in runs on the Mac only. The phone shows "On the Mac", because OAuth callbacks land on the Mac's localhost.
   The Claude callback-URL method (`mcpSubmitOAuthCallbackUrl`) leaves room for phone sign-in later.

## Screens

The approved designs in this Chat: "Desktop A, grouped cards" (v8), "Desktop A, add server sheet" (v4) and
"Phone, MCP list" (v6), all in the Settings › MCP group.

### Visual rules

- Accents are black (`ink`). Sign in buttons, switches, the selected radio and focus rings are black, not blue.
- No green. Connected status is gray text. A failure gets a red `triangle-alert` icon next to its summary, and the
  error text sits under the server name in red. Red appears only for failures and Remove.
- No status dots. A row's summary ("3 of 3 connected", "1 of 2 on") sits just left of its chevron.

### Desktop

The page keeps the Settings layout: a 640 px column, 12 px-radius white cards on the page background.

- **Header.** Title, a Refresh icon button, and Add server (black). Below them: "Tool servers your Chats load, for
  every account on this Mac. Checked 12 s ago."
- **Needs sign-in · N.** Shown only when something needs it.
  - One row per server: an orange globe tile, the name, then "URL · host" with no account named, and Sign in.
  - While the browser is open, the row reads "Finish in your browser, then come back." with Cancel.
- **Your servers · N.** Every user-scope server and every Everywhere server.
  - A row shows a terminal or globe tile, the name, and "Command · command line" or "URL · host" (or the error, in red).
  - Then an Everywhere badge if it applies, the summary, and a chevron.
  - Clicking a row expands it in place, one row open at a time. The open row lists each provider account with its
    status ("Connected · 14 tools", "Off in Milagre Chats", "Connected · 14 tools · from Everywhere") and a switch.
  - The open row's footer has Edit and Remove.
- **From projects, plugins and claude.ai.** One card, collapsed by default, that expands in place and never opens a
  page.
  - Inside: a line saying they are set up outside Milagre, then groups by source: "Project · milagre-ade" with
    `.mcp.json`, "Plugin · engineering", and "claude.ai connectors · personal" with a "Manage on claude.ai" link.
  - Each row has the name, its transport line, the status, and a switch or Sign in.
  - The header count reads "6 · 1 needs sign-in".
- **Add server sheet.**
  - A URL / Command switch, then Name.
  - URL with optional headers (key, value, +); or command, args and env.
  - Then "Load it in": Everywhere (default, "Milagre Chats on every provider"), Claude only or Codex only.
  - Saving runs the write and checks that server again. For a URL server, the button reads "Add and sign in" and goes
    straight into sign-in if the server asks for it.
  - Edit opens the same sheet filled in.

### Phone

Native grouped list, same order: Needs sign-in (trailing "On the Mac"), Your servers (summary under the name, a red
warning icon for failures, a chevron), and a "Projects and plugins" row with its count.

- Tapping a server opens its detail: the per-account switches, Edit and Remove for URL servers, and "Edit on the Mac"
  for command servers.
- Refresh and + sit in the nav bar. + opens the add sheet with URL only.

## Core

### `packages/core/src/mcp/`

- `claude.cjs`:
  - adds `add(account, server)` (`claude mcp add-json <name> <json> --scope user`)
  - adds `remove(account, name)` (`claude mcp remove <name> --scope user`)
  - adds `signIn(account, name, { everywhere, onUrl, signal })` (flow above)
- `codex.cjs`: adds `add` (`codex mcp add`), `remove` (`codex mcp remove`) and `signIn`.
- `antigravity.cjs`:
  - `check` starts an ACP `session/new` with the Everywhere servers that are on and reports which connected.
  - It has no `add`, `remove` or `signIn`.
- `store.cjs`: `<dataDir>/mcp.json`, mode 0600.
  - Holds `{ everywhere: [server…], off: { "<provider>:<accountId>": [name…] } }`.
  - Writes are atomic (temp file plus rename).
- `index.cjs` gains:
  - `add`, `edit` (remove then add, same target)
  - `remove`
  - `toggle(provider, accountId, name, on)`
  - `signIn(name)`, which runs every account that reports `needs-sign-in`, plus `cancelSignIn(name)`
  - `forSession(provider, account)`, which returns the Everywhere servers missing from that account's config, and its
    off list.
- An Everywhere server whose name exists in a provider's own config is "shadowed" there: the provider's config wins
  and the chip says so.

### `@milagre/shared/mcp`

- `groupMcpRows` returns `{ attention, user, other }`.
  - `attention` holds every row with a `needs-sign-in` chip, whatever its scope.
  - `other` is grouped by source: project path, plugin name, or claude.ai account.
- `mcpSummary` keeps its copy: "Connected", "3 of 3 connected", "1 of 2 on".
- New `mcpTransportLine(row)` gives "URL · mcp.linear.app" or "Command · npx …".

### Chat start

- `claude-provider`: Everywhere servers go into `mcpServers` next to `milagre`. After `init`, each server on the off
  list gets `toggleMcpServer(name, false)`.
- `codex-provider`: Everywhere servers go into thread config `mcp_servers`, and each server on the off list gets
  `mcp_servers.<name>.enabled = false`.
- `acp-session`: Everywhere servers that aren't off go into `session/new` and `session/resume` `mcpServers`.
- A failure in `forSession` is logged, and the Chat starts without the extra servers.

### #375 deletion fix

`account-mcp.cjs` records the names it copied into an added account. A recorded name that has left the source is
removed from that account. Servers the account added itself are never touched.

## Commands and remote rules

`runtime.cjs` gets these alongside `mcp:accounts` and `mcp:check`:

- `mcp:add`, `mcp:edit`, `mcp:remove`
- `mcp:toggle`
- `mcp:signIn`, `mcp:cancelSignIn`

They go through the computer bridge, so they act on the selected Mac.

- **Phone and peers** (`peer-policy.cjs`, `mobile-bridge.cjs` `METHODS`): everything except `mcp:signIn` and
  `mcp:cancelSignIn`. A command-server add or edit returns `NOT_AVAILABLE_REMOTELY`.
- **Timeouts:** `mcp:signIn` answers once the browser URL is open. Completion arrives by re-checking, so client
  deadlines (45 s) are untouched.
- **Push:** the phone gets a push signal after add, edit, remove or toggle, so an open MCP screen refreshes.

## Errors

| Case | Shown |
| --- | --- |
| CLI not installed | That provider's lines read "Codex not installed"; its switches and Sign in are disabled. |
| Account signed out | "Not signed in. Sign in from Accounts." Check skipped. |
| CLI write fails | Its stderr inline in the sheet; `mcp.json` untouched. |
| Sign-in times out (5 min) or is cancelled | The row goes back to Sign in; nothing else changes. |
| Sign-in error from the provider | Its message under the server name, in red; Sign in stays. |
| Command server asked to sign in | Not offered: Sign in appears only on URL and connector servers. |
| Everywhere name clash | Provider config wins; the line reads "Shadowed by Claude's own pencil". |
| Check times out | That account's servers read failed with the timeout text; other accounts still fill in. |

## Testing

- **Unit tests**, next to each file:
  - adapter `add`, `remove` and `signIn` with stubbed SDK and app-server (argument arrays, polling, cancel, timeout)
  - `store.cjs`
  - `forSession` merge and shadowing
  - the off list at Chat start for all three providers
  - the #375 deletion fix
  - `groupMcpRows` attention and source grouping
  - daemon refusal of command-server adds and of `mcp:signIn` from a phone or peer
- **Electron check** `scripts/test-mcp-settings.cjs`: a temp profile with fake configs and stubbed CLIs and SDK.
  - Covers: add a URL server Everywhere, expand a row, toggle an account off, run Sign in to a stubbed `authUrl` and
    see the row leave Needs sign-in, expand projects and plugins, remove a server.
  - Takes screenshots when `MILAGRE_SCREENSHOT_DIR` is set.
- **One real sign-in** on Victor's Mac: `expo` for Claude and for Codex, checked with `mcpServerStatus` and
  `mcpServerStatus/list`.
- **Phone:** the Designs QA simulator with a local dev build. Screenshots of the list, a server's detail, the add
  sheet and "On the Mac".

## Open items the plan verifies first

1. A Claude token from an idle sign-in session is used by a Chat that passes the same Everywhere config.
2. Codex `mcpServer/oauth/login` with a `threadId` sees servers from thread config.
3. `claude mcp add-json` and `codex mcp add` accept every field the sheet offers (headers, env) for the installed CLI
   versions.

## Out of scope

- Signing in from the phone.
- Editing project, plugin or claude.ai servers (only on/off and Sign in).
- Per-account settings beyond on/off.
- Copying servers between computers.

## Probe results (2026-10-15, Task 1)

- Claude token reuse: verified up to `authUrl` (no sign-in completed). In a fresh `CLAUDE_CONFIG_DIR`, an idle query
  with `mcpServers: { probe: { type: "http", url: "https://mcp.expo.dev/mcp" } }` reads `needs-auth` (scope
  `dynamic`), and `mcpAuthenticate("probe")` returns `authUrl`, `requiresUserAction: true`, `callbackExpected: true`,
  `redirectScheme: "localhost"`, `state` and `callbackPort`. A second idle query with the identical `mcpServers`
  still reads `needs-auth`, as expected with no sign-in. The completed token-reuse loop was not run, so the token key
  including the config stays from the earlier probe: the sign-in session must pass exactly the Chat's config.
- toggleMcpServer on a user server: works. On `argent` (user scope, connected): `toggleMcpServer(name, false)`
  returns `undefined`, `mcpServerStatus()` then reads `disabled` (config still present); `toggleMcpServer(name, true)`
  returns it to `connected`. A fresh idle query afterwards shows `argent` connected, so the toggle is per session and
  does not persist.
- Codex config/value/write add + `codex mcp remove`: works, no login needed. `config/value/write { keyPath:
  "mcp_servers.probe", value: { url, http_headers: { "X-Test": "1" } }, mergeStrategy: "replace" }` returns
  `status: "ok"` and writes `[mcp_servers.probe]` plus `[mcp_servers.probe.http_headers]` to `config.toml`.
  `config/read` round-trips it (`url`, `http_headers`, `enabled: true`). `codex mcp remove probe` prints
  "Removed global MCP server 'probe'." and `config/read` then returns an empty `mcp_servers`.
- Codex oauth/login on a thread-config server: returns `{ authorizationUrl }` when `threadId` is passed (thread
  started with `config.mcp_servers.probe2`); without `threadId` it errors "No MCP server named 'probe2' found."
  This ran in a credential-less `CODEX_HOME`, so no OpenAI login is needed for it. Ephemeral accepted: yes
  (`thread/start { ephemeral: true }` returns `thread.ephemeral: true`).
- Codex thread config `enabled: false`: merges. With `probe` in `config.toml`, a thread started with `config.mcp_servers.probe
  = { enabled: false }` (no url) starts fine and `mcpServerStatus/list { threadId }` reports `probe` with
  `runtimeStatus: "disabled"` and `httpOrigin: "https://mcp.expo.dev"`, so the definition from `config.toml` is kept.
  The thread-config server `probe2` appears in the same list as `authenticationRequired`.
