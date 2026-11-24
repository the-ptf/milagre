# Connectors

A Connector is a remote MCP server the host signs in to once, so every provider and Account uses one sign-in instead of each Account holding its own. The host keeps the tokens and calls the server; agents reach its tools through `milagre`. Nothing passes through the relay or a Milagre server.

## Sign-in

`connectors/index.cjs` drives the MCP SDK's OAuth client (`@modelcontextprotocol/sdk`, a direct dependency of `@milagre/core`):

- Discovery follows the server's protected-resource and authorization-server metadata.
- A server with dynamic client registration registers Milagre on first sign-in. A server without it (Slack) needs a client ID, and a secret when its app is confidential, entered when the Connector is added.
- The browser returns to `http://localhost:47616/connectors/callback`, served on `127.0.0.1` and `::1` only for the length of one sign-in. The port is fixed because Slack and other pre-registered apps match the redirect exactly. One sign-in runs at a time; a new one replaces the old.
- PKCE and a random `state` guard the exchange. Refreshes happen in the background; a refused refresh marks the Connector as needing sign-in and never opens a browser by itself.
- Sign out and Remove send the refresh token to the server's revocation endpoint when it has one.

Tokens, client secrets and registrations live in `<dataDir>/connectors/secrets/<id>.json`, owner-only, like Linear's. `connectors.json` holds names, addresses, client IDs and the per-Account off list. Status and list answers never include a token or secret.

## Settings

Settings › Connectors (the `mcp` section) is one page with a **Connectors | MCP servers** switch, on desktop and phone.

- **Connectors** lists each Connector with its state, tool count and reach ("All accounts", "2 of 3 accounts"). A row opens **Available to**, one checkbox per provider Account, plus Sign in again, Sign out and Remove. Add connector offers the presets in `CONNECTOR_PRESETS` (`packages/shared/src/connectors.ts`: Slack, then the MCP catalog) or any address with optional headers or an OAuth app's client ID and secret.
- Everywhere MCP servers with an address show under **Move to Connectors**; Move adds the Connector with the same headers and drops the Everywhere entry (`connectors:movable`, `connectors:move`). The server then needs one sign-in in Milagre instead of one per Account.
- **MCP servers** is the per-Account MCP page and Milagre's own MCP, unchanged.
- The phone shows the same switch. It lists Connectors, changes Available to, signs out and removes; adding and signing in say to use the computer, because the browser returns to its loopback callback.

## Who can do what

| Operation                                                                    | Desktop on this computer, CLI | Phone, paired desktop        |
| ---------------------------------------------------------------------------- | ----------------------------- | ---------------------------- |
| `connectors:add`, `connectors:update` (can carry a client secret)            | yes                           | no                           |
| `connectors:sign-in`, `connectors:cancel-sign-in` (browser on this computer) | yes                           | no                           |
| `connectors:call` (runs a tool directly)                                     | yes                           | no                           |
| `connectors:list`, `check`, `tools`, `access`, `sign-out`, `remove`          | yes                           | yes; a demo phone only lists |

The CLI gets every operation from the command contracts: `milagre connectors add --input @slack.json`, `milagre connectors sign-in --id slack_company_a`, `milagre connectors access --id slack_company_a --provider codex --account-id ID --on false`.

## How agents see them

A Chat gets the Connectors its provider Account may use: all of them unless the Account is in a Connector's off list. The session's provider and Account pick the list when the session starts (`linkedFor(chatId, { provider, accountId })`), and the HTTP `milagre` endpoint reads the running session's for later `tools/list` calls. A Chat whose agent isn't running gets none.

- **Claude** gets one in-process server per Connector, named by its id, so tools read `mcp__slack_company_a__<tool>`. These servers don't set `alwaysLoad`, so Claude Code defers them behind its tool search; `milagre` itself stays always loaded. Claude's tool list is fixed when its session starts: a Connector added later shows up in a running Chat's next session.
- **Codex, Antigravity, Kiro and Pi** see the tools inside `milagre` as `<id>__<tool>`, re-read on every `tools/list`.
- A tool the server marks `readOnlyHint` runs without approval. Every other tool follows the Chat's permission mode, like any `milagre` tool that changes something.
- `connectors/tools.cjs` turns the server's JSON Schema into the zod shape every `milagre` tool uses (`z.fromJSONSchema`); a schema zod can't read becomes one `arguments` object. Results keep text and images; resources become text, and an error result fails the call.
- Only Connectors that answered a tool list this run are offered. The host checks every Connector when it starts.

## Ids and tool names

The id comes from the name when the Connector is added (`Slack company A` becomes `slack_company_a`, at most 16 characters) and never changes on rename, because agents see it in tool names. Names longer than Claude's 64-character limit, prefix included, are cut and end in a short hash.

## Slack

Slack's MCP server refuses dynamic registration and only serves internal (single-workspace) apps and Slack Marketplace apps. Until Milagre's own app is listed, each workspace needs an internal Slack app. The Slack preset opens Slack's create-app page with `SLACK_APP_MANIFEST` (`packages/shared/src/connectors.ts`): the callback above, PKCE, rotating tokens, the user scopes the server lists at `https://mcp.slack.com/.well-known/oauth-protected-resource`, and `settings.is_mcp_enabled`. An app made without that key signs in but every call fails with "App is not enabled for Slack MCP server access" until **Agents › Slack Model Context Protocol (MCP) Server** is turned on. Its client ID and secret go into the Connector.
