# Settings › MCP: see and manage the MCP servers every Chat loads

Date: 2026-10-09. Status: PR 1 shipped (#384). PR 2 and PR 3 are replaced by
[2026-10-15-mcp-connect-design.md](2026-10-15-mcp-connect-design.md). Issue: #376.

## Goal

Every MCP server Victor has set up works in every Milagre Chat, whatever the provider, account or computer. When one is
missing or broken, Settings shows it before a Chat finds out mid-turn, and it can be fixed from the desktop or the phone
without a terminal.

Follows #375, which makes added Claude and Codex accounts inherit the connected account's servers when a Chat starts.

## Decisions

| Question | Decision |
| --- | --- |
| Source of truth | Both. The CLI configs (`~/.claude.json`, `~/.codex/config.toml`) stay the source for each provider, and the tab edits them. A Milagre-owned "Everywhere" list adds a server to every provider that lacks it, Antigravity included. |
| Status | Checked live when the tab opens, with Refresh. Not saved between sessions. |
| OAuth | Handed off to each CLI. Codex: its app-server's `mcpServer/oauth/login`. Claude: a Milagre terminal tab running `claude` with `/mcp` typed. Milagre stores no MCP tokens. |
| Edit scope | User level, per provider, written to the default account's config. #375 carries it to added accounts. Project servers (`.mcp.json`, `projects[path].mcpServers`) are read-only. |
| Deletions reach added accounts | Yes. #375 is extended to remove servers it copied once they leave the source. |
| Turning a server off | Milagre's off list, per provider and account, applied when a Chat starts (Claude has no user-level switch). The terminal CLIs are unaffected. |
| Phone and peer computers | View, Refresh, on/off, and add or edit URL servers. Adding or editing a command server, and Sign in, happen on the Mac. |
| Reading and writing configs | Writes go through each CLI's own commands (`claude mcp add-json/remove`, `codex mcp add/remove`). Reads use the SDK's `mcpServerStatus()` and Codex app-server `config/read` plus its MCP startup events. |

Rejected: editing the config files directly (a TOML regex round-trip loses comments and races a running CLI), and
parsing `claude mcp list` / `codex mcp list` text (it changes between CLI versions).

## Terms

- **MCP server:** a tool server a provider loads into a Chat. A *command server* is a local process (stdio); a *URL server*
  is remote (HTTP or SSE). Added to GLOSSARY.md.
- **Everywhere server:** a server in Milagre's own list, added at Chat start to each provider whose config lacks one by
  that name.
- **Chip:** one provider and account's view of a server: whether it loads it and its status.

## Screens

### Desktop: Settings › MCP

A new tab between Skills and Devices. It shows the Mac selected in the Settings rail's Computers list.

- One row per server name. The row shows the name, the transport (`command` or `URL`) and one chip per provider and
  account: `Claude · personal ✓`, `Claude · rdplus ⚠ sign in`, `Codex ✗ failed`, `Antigravity –`. A chip's tooltip
  holds the error text and the tool count.
- Row actions: Edit, Remove, an on/off switch per chip, Sign in on a `needs sign-in` chip, and Everywhere.
- A collapsed "From projects and plugins" section lists project, local, plugin and claude.ai servers read-only, with
  their source.
- Add server opens a sheet: name, command or URL, command with args and env (or URL with headers), and checkboxes for
  Claude, Codex and Everywhere. Saving runs the writes, then re-checks that server.
- Opening the tab starts a check. Chips show a spinner until their account reports. Refresh runs it again.

### Phone: Settings › MCP

The same list for the connected Mac, in native rows: name, a summary ("3 of 4 connected"), then the chips. Refresh, the
switches and adding or editing a URL server work. Command servers show "Add on the Mac"; Sign in shows "Sign in on
the Mac".

## Core: `packages/core/src/mcp/`

### Adapters

One file per provider, each exporting `check(account)`, `add(account, server)`,
`remove(account, name)` and `signIn(account, name)`. Every subprocess runs with `accounts.environment(account)`, so it
reads and writes that account's config folder.

- `claude.cjs`
  - `check`: an idle SDK query in the account's environment (the `listClaudeModels` pattern in `agents/models.cjs`).
    Polls `mcpServerStatus()` until no server is `pending`, then closes the query. One call lists every server the
    account loads, with `scope` (`user`, `local`, `project`, `dynamic` for plugins, `claudeai` for claude.ai
    connectors), `status`, `error`, `tools` and `config.type`. Measured 2026-10-09: 24 servers settled in 2.3 s.
    No config file is parsed.
  - `add`: `claude mcp add-json <name> <json> --scope user`. `remove`: `claude mcp remove <name> --scope user`.
  - `signIn`: returns a terminal request (below); the desktop opens it.
- `codex.cjs`
  - `check`: an app-server with the account's `CODEX_HOME` (the `listCodexModels` pattern), `config/read` for each
    server's transport, then `mcpServerStatus/list` with `detail: "toolsAndAuthOnly"`, which connects every server
    without a thread and returns `tools`, `toolsError` and `authStatus`. Measured 2026-10-09: 12 servers in 1.6 s.
  - `add`: `codex mcp add`. `remove`: `codex mcp remove`.
  - `signIn`: the app-server's `mcpServer/oauth/login` request, which opens the browser.
- `antigravity.cjs`
  - No user MCP config of its own: `list` returns the Everywhere servers. `check` starts an ACP `session/new` with them
    and reads which connected.

### Store

`store.cjs` reads and writes `<dataDir>/mcp.json`, mode 0600 (headers may hold tokens):

```json
{
  "everywhere": [{ "name": "pencil", "type": "stdio", "command": "...", "args": [], "env": {} }],
  "off": { "claude:<accountId>": ["figma"] }
}
```

### Snapshot and check

`index.cjs`:

- Rows are grouped by server name in `@milagre/shared/mcp` (`groupMcpRows`), shared by desktop and phone. A row whose
  chips are all outside `user` scope goes under "From projects and plugins", read-only. PR 3 marks an Everywhere
  server "shadowed" for a provider whose config has one with the same name.
- `accounts()` lists every provider and account to check. `check(provider, accountId)` checks one, with a 30 s cap;
  a server still pending then is `failed (timeout)`. The tab calls `check` for every account in parallel, so chips
  fill in as each account answers, without an event stream.
- `forSession(provider, account)` returns the Everywhere servers missing from that account's config and its off list.

### #375 deletion fix

`account-mcp.cjs` records in the added account's folder which server names it copied. On the next merge, a recorded
name no longer in the source is removed from the account. Servers the account added itself are never touched.

## Chat start

- `claude-provider`: Everywhere servers go into the `mcpServers` option next to `milagre`. After `init`, each off server
  gets `toggleMcpServer(name, false)`.
- `codex-provider`: Everywhere servers go into thread config `mcp_servers` next to `milagre`, and each off server gets
  `mcp_servers.<name>.enabled = false`.
- `acp-session`: Everywhere servers not on the off list go into `session/new` `mcpServers` next to `milagre`.
- A failure in `forSession` is logged and the Chat starts without the extra servers, like #375.

## Commands

In `runtime.cjs`: `mcp:accounts`, `mcp:check`, `mcp:add`, `mcp:remove`, `mcp:toggle`, `mcp:everywhere`, `mcp:signIn`.

- Desktop: called through the computer bridge, so they reach the selected Mac. Not added to the local-only lists in
  `preload.cjs` or `computer-routing.cjs`.
- Daemon: `peer-policy.cjs` and `mobile-bridge.cjs` `METHODS` allow all but `mcp:signIn`. From a phone or peer,
  `mcp:add` or an edit with a command server returns `NOT_AVAILABLE_REMOTELY`. The phone gets a push signal when a
  server is added, removed or toggled (PR 2).

### Claude sign-in

`mcp:signIn` for Claude opens a Milagre terminal tab in the account's environment, runs `claude` and types `/mcp`. When
the tab closes, that account is re-checked.

## Errors

| Case | Shown |
| --- | --- |
| CLI not installed on that Mac | Chips read "Codex not installed"; actions disabled. |
| Account signed out | Chips read "Account signed out" with a link to Accounts; check skipped. |
| CLI write fails | Its stderr inline in the sheet; `mcp.json` untouched. |
| Name clash with Everywhere | Provider config wins; the Everywhere copy reads "shadowed". |
| Check times out | That account's servers read `failed (timeout)`; other chips still fill in. |
| Selected computer drops | The Computers "Mac unreachable" banner. |

## Testing

- Unit, next to each file:
  - Adapters against a temp config folder with stubbed CLIs: add/remove argument arrays, `.claude.json` and
    `config/read` parsing, status mapping.
  - `store.cjs`; the deletion fix in `account-mcp.test.cjs`; `forSession` merging and shadowing.
  - Daemon refusing command-server adds from a phone or peer, next to `peer-e2e` and `confine` tests.
- Electron check `scripts/test-mcp-settings.cjs`: fake Claude and Codex configs in a temp profile with stubbed CLIs.
  Open the tab, assert rows and chips, add a URL server, toggle one off, remove one. Screenshots when
  `MILAGRE_SCREENSHOT_DIR` is set.
- Phone: Designs QA simulator with a local dev build. Screenshots of the list and of "Add on the Mac".

## Order of work

Each PR ships desktop and phone together. All JS, so the phone gets each as an OTA update.

1. **Read only.** Adapters' `check`, `mcp:accounts`, `mcp:check`, the tab with chips and Refresh, the phone
   screen, the GLOSSARY entry.
2. **Edit.** Add, remove and on/off through the CLIs; the off list at Chat start; phone and peer rules; the #375
   deletion fix.
3. **Everywhere and sign-in.** `mcp.json`, injection on all three providers, Antigravity chips, Codex `mcpServer/oauth/login`, the
   Claude `/mcp` terminal hand-off.

## Out of scope

- Editing project-scope servers.
- Milagre running MCP OAuth itself.
- Per-account overrides beyond on/off.
- Copying servers between computers.
