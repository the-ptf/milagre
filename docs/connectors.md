# Connectors

A Connector is an MCP server the host connects to once, by address or by the command that starts it, so every provider and Account uses one sign-in instead of each Account holding its own. The host keeps the tokens and calls the server; agents reach its tools through `milagre`. Nothing passes through the relay or a Milagre server.

## Sign-in

`connectors/index.cjs` drives the MCP SDK's OAuth client (`@modelcontextprotocol/sdk`, a direct dependency of `@milagre/core`):

- Discovery follows the server's protected-resource and authorization-server metadata.
- A server with dynamic client registration registers Milagre on first sign-in. A server without it (Slack) needs a client ID, and a secret when its app is confidential. Added or moved without one, the Connector goes to `needs-app` instead of failing, and its row asks for the app (Add app opens Edit with the preset's create-app link); saving signs in.
- The browser returns to `http://localhost:47616/connectors/callback`, served on `127.0.0.1` and `::1` only for the length of one sign-in. The port is fixed because Slack and other pre-registered apps match the redirect exactly. One sign-in runs at a time; a new one replaces the old.
- PKCE and a random `state` guard the exchange. Refreshes happen in the background; a refused refresh marks the Connector as needing sign-in and never opens a browser by itself.
- Sign out and Remove send the refresh token to the server's revocation endpoint when it has one.

Tokens, client secrets and registrations live in `<dataDir>/connectors/secrets/<id>.json`, owner-only, like Linear's. `connectors.json` holds names, addresses, client IDs and the per-Account off list. Status and list answers never include a token or secret.

## Command connectors

A command connector (`connectors:add` with `command`, `args`, `env`) runs on the computer as one process every Chat shares, started on first use in the home folder with the host's environment plus its own variables, and stopped after 10 idle minutes (`idleMs`). Its variables live with the secrets and only their names leave the host. The tool list it last answered is saved in `<dataDir>/connectors/tools/`, so a restarted host offers its tools without starting it; the first call starts it again. A command that exits on start reports its last stderr line as the problem. A server that keeps per-session state (a browser, a folder) shares it across Chats.

## Moving off Everywhere

When the host starts it moves every Everywhere MCP server with an address or a command into Connectors, with its headers or environment, and keeps it off for the Accounts it was off for. `connectors:moved` lists what moved until the user dismisses the note. A Connector with the same name and target is reused; a different one gets a name ending in 2. SSE servers stay Everywhere. `connectors:move` moves one by hand.

## Linear

Milagre's own Linear sign-in shows as a built-in Connector (id `linear`, reserved) while a workspace is signed in; the Linear preset in Add connector runs that sign-in (with Linear's MCP server one click away), and the expanded row holds Linear's own settings: the switch for issue features, workspaces, and Move issues to In Progress. There is no separate Integrations page; Babysit PRs lives in Settings › Worktrees. It keeps its GraphQL sign-in, so issue starts, Worktree issue links, In Progress moves and Routines triggers work as before; Available to decides which Accounts get the `linear_*` tools, stored in `connectors/builtin.json`. Add workspace and Sign out go through `linear:connect` and `linear:disconnect`. Linear's MCP server (`mcp.linear.app`) is a separate preset.

## Settings

Settings › Connectors (the `mcp` section) is one page with a **Connectors | MCP servers** switch, on desktop and phone.

- **Connectors** lists each Connector with its state, tool count and reach ("All accounts", "2 of 3 accounts"). A row opens **Available to**, one checkbox per provider Account, plus Sign in again, Sign out, Edit and Remove (Linear shows its own settings instead; a command connector has Edit and Remove). Edit changes the name, the OAuth app, headers, or a command's arguments and environment; secrets show masked and stay as they are unless retyped. The address can't change: add a new connector. Add connector offers the presets in `CONNECTOR_PRESETS` (`packages/shared/src/connectors.ts`), an address with optional headers or an OAuth app's client ID and secret, or a command with arguments and environment.
- **MCP servers** is read-only: the servers each Account's own config, Projects, plugins and claude.ai load, with their per-Account checkboxes and sign-in. New servers go in Connectors. The daemon keeps `mcp:save`, `mcp:saveUrl` and `mcp:remove` for the CLI and older apps.
- The phone shows the same switch. It lists Connectors, changes Available to, signs out and removes; adding and signing in say to use the computer, because the browser returns to its loopback callback.

## Who can do what

| Operation                                                                    | Desktop on this computer, CLI | Phone, paired desktop        |
| ---------------------------------------------------------------------------- | ----------------------------- | ---------------------------- |
| `connectors:add`, `connectors:update` (can carry a client secret)            | yes                           | no                           |
| `connectors:sign-in`, `connectors:cancel-sign-in` (browser on this computer) | yes                           | no                           |
| `connectors:call` (runs a tool directly)                                     | yes                           | no                           |
| `connectors:list`, `check`, `tools`, `access`, `sign-out`, `remove`          | yes                           | yes; a demo phone only lists |

A paired computer's Settings page on another desktop lists its Connectors in the same rows, through that computer's bridge: Available to (with that computer's Accounts), Sign out and Remove work from there; Add, Edit and sign-in say to use that computer, and Linear's own settings stay on it. An older computer without Connectors shows a line asking to update it.

The CLI gets every operation from the command contracts: `milagre connectors add --input @slack.json`, `milagre connectors sign-in --id slack_company_a`, `milagre connectors access --id slack_company_a --provider codex --account-id ID --on false`.

## How agents see them

A Chat gets the Connectors its provider Account may use: all of them unless the Account is in a Connector's off list. The session's provider and Account pick the list when the session starts (`linkedFor(chatId, { provider, accountId })`), and the HTTP `milagre` endpoint reads the running session's for later `tools/list` calls. A Chat whose agent isn't running gets none.

- **Claude** gets one in-process server per Connector, named by its id, so tools read `mcp__slack_company_a__<tool>`. These servers don't set `alwaysLoad`, so Claude Code defers them behind its tool search; `milagre` itself stays always loaded. Claude's tool list is fixed when its session starts: a Connector added later shows up in a running Chat's next session.
- **Codex, Antigravity, Kiro and Pi** see the tools inside `milagre` as `<id>__<tool>`, re-read on every `tools/list`.
- A tool the server marks `readOnlyHint` runs without approval. Every other tool follows the Chat's permission mode, like any `milagre` tool that changes something.
- `connectors/tools.cjs` turns the server's JSON Schema into the zod shape every `milagre` tool uses (`z.fromJSONSchema`); a schema zod can't read becomes one `arguments` object. Results keep text and images; resources become text, and an error result fails the call.
- Only Connectors that answered a tool list this run are offered. The host checks every Connector when it starts.
- Outside MCP clients (Settings › Milagre MCP) get Connectors only through a `connectors` grant chosen per client, and the per-Account Available to doesn't apply to them. See [local-mcp.md](local-mcp.md).

## Ids and tool names

The id comes from the name when the Connector is added (`Slack company A` becomes `slack_company_a`, at most 16 characters) and never changes on rename, because agents see it in tool names. Names longer than Claude's 64-character limit, prefix included, are cut and end in a short hash.

## Slack

Slack's MCP server refuses dynamic registration and only serves internal (single-workspace) apps and Slack Marketplace apps. Until Milagre's own app is listed, each workspace needs an internal Slack app. The Slack preset opens Slack's create-app page with `SLACK_APP_MANIFEST` (`packages/shared/src/connectors.ts`): the callback above, PKCE, rotating tokens, the user scopes the server lists at `https://mcp.slack.com/.well-known/oauth-protected-resource`, and `settings.is_mcp_enabled`. An app made without that key signs in but every call fails with "App is not enabled for Slack MCP server access" until **Agents › Slack Model Context Protocol (MCP) Server** is turned on. Its client ID and secret go into the Connector.
