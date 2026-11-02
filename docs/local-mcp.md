# Local Milagre MCP

Settings > Milagre MCP lists local clients with enable/disable switches on desktop and phone. Enable a client, choose specific Projects, All Projects or Designs, and save to install its configuration on the computer running Milagre. Restart the client after initial setup to load that configuration; subsequent scope edits on an already-configured client take effect immediately without rotating its credential or restarting the client. The switch represents configured access; it does not claim the client is running or connected.

The endpoint binds to `127.0.0.1` only. Neither LAN nor relay exposes MCP. The existing daemon owns the listener, grants, operations and Project state; connecting an MCP client never starts a host.

Choose explicit Projects or All Projects (`projectPaths: "*"`, which includes Projects opened later) with read access, or allow Worktree/Chat creation and task startup. A separate Designs-only connection binds one Chat and all or selected design IDs. It has no management or public publishing tools. HTML Artifacts and their comments are excluded. A Designs connection has no tools while its adapter is absent.

Automatic setup writes each credential into the client's private configuration. Milagre saves its SHA-256 hash, the grant and installation metadata. Client setup and status responses contain no credential. Turning a client off revokes access before removing the owned configuration entry. Saving scope changes for an already-configured client updates its grant in place while its owned configuration entry and credential remain valid; missing or replaced entries mint a fresh credential.

For another client, turn on Custom MCP to reveal its setup and connection management. This section starts collapsed on desktop and phone. Closing it clears the one-time credential from the screen; existing grants are revoked through their Revoke action. Copy immediately after creating or replacing a credential; Milagre cannot retrieve it later. Revocation and expiration prevent further use. Do not put credentials in a repository or public design page. Listing connections never returns credentials.

## Client setup

All automatic entries use the name `milagre-local`. Existing server entries and unrelated settings are preserved. JSONC comments survive editing; TOML layouts that cannot be edited without changing other values are refused. Files are replaced atomically with owner-only permissions. Symlinks, malformed files and externally changed Milagre entries are left untouched. Use custom configuration for those cases.

| Client                                                                               | Default file                                                                                                                   | Transport                      |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| [Claude Code](https://code.claude.com/docs/en/mcp)                                   | `~/.claude.json`                                                                                                               | HTTP                           |
| [Codex](https://developers.openai.com/codex/mcp/)                                    | `~/.codex/config.toml`                                                                                                         | HTTP                           |
| [Gemini](https://geminicli.com/docs/tools/mcp-server/)                               | `~/.gemini/settings.json`                                                                                                      | HTTP                           |
| [Antigravity](https://www.antigravity.google/docs/mcp)                               | `~/.gemini/config/mcp_config.json`                                                                                             | HTTP                           |
| [OpenCode](https://opencode.ai/docs/mcp-servers/)                                    | `~/.config/opencode/opencode.json` or existing `.jsonc`                                                                        | HTTP                           |
| [Kiro](https://kiro.dev/docs/mcp/configuration/)                                     | `~/.kiro/settings/mcp.json`                                                                                                    | HTTP                           |
| [Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers) | `~/Library/Application Support/Claude/claude_desktop_config.json`, or `%APPDATA%/Claude/claude_desktop_config.json` on Windows | stdio adapter to loopback HTTP |

Setup respects `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` and `OPENCODE_CONFIG` after the host loads its login environment. An existing managed installation keeps its recorded path if those variables later change. Claude Desktop uses Milagre's existing Node/Electron executable and `local-mcp-stdio.cjs`; it requires no extra runtime and only accepts the owning host's loopback endpoint. Claude Desktop automatic setup is unavailable on Linux.

Startup reconciles installation intent with the client file. It retains a working credential, repairs a missing owned entry, updates a moved stdio executable, and revokes orphaned grants. Expired or revoked access is never recreated. If a file changed elsewhere, Milagre leaves it alone. Disabling still revokes the credential, even when the changed file cannot be cleaned up.

## UI API

Desktop: `bridge.localMcp`. Mobile: the same methods through `client.call`:

| Method                    | Arguments                   | Result                                                              |
| ------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `local-mcp:status`        | `[]`                        | `{url, connections, clients, groups, projects}` without credentials |
| `local-mcp:enableClient`  | `[clientId, configuration]` | client status after installing private config, no credential        |
| `local-mcp:disableClient` | `[clientId]`                | client status after revoking and removing owned config              |
| `local-mcp:create`        | `[configuration]`           | `{connection, url, token}` once                                     |
| `local-mcp:update`        | `[id, configuration]`       | updated connection, no credential                                   |
| `local-mcp:rotate`        | `[id]`                      | `{connection, url, token}` once                                     |
| `local-mcp:revoke`        | `[id]`                      | no result                                                           |

These are authenticated Milagre UI operations, not MCP tools. Confined demo phones cannot call them. Paired full-access desktop/phone settings manage the owning computer; its loopback address still only works there.

Client IDs are `claude-code`, `codex`, `gemini`, `antigravity`, `opencode`, `kiro` and `claude-desktop`. Client status includes `id`, `label`, `configPath`, `enabled`, `state`, optional `connection`, and optional safe `problem`. States are `configured`, `missing`, `off`, `error` and `unavailable`. Managed connection records have `clientId`; edit them through `enableClient` to update their grant in place (or mint a replacement credential when the owned entry is missing). `rotate` is for custom connections. Generic `revoke` also removes a managed client's owned entry.

The Designs entry point can create and copy a connection without adding a management grant:

```ts
const credential = await bridge.localMcp.create({
  label: "Design editor",
  grants: {
    designs: {
      chatId, // canonical existing Chat ref on this computer
      designIds: "*", // or ["checkout", "profile"]
      capabilities: ["read", "write"],
    },
  },
  // expiresAt: "2026-11-01T00:00:00Z", // optional UTC expiry
});
// @milagre/shared/local-mcp; copy this return value, then discard it.
const configuration = localMcpClientConfig(credential);
```

On mobile use `client.call("local-mcp:create", [input])` and the existing clipboard module. `localMcpClientConfig` returns a URL MCP configuration with an Authorization bearer header. A subsequent Copy action cannot retrieve a credential: keep the initial result only while its one-time panel is open, or explicitly replace it. For Codex clients use the same URL and bearer value in their supported HTTP-header configuration.

The Designs entry point can also pass that same Designs-only input to `bridge.localMcp.enableClient("codex", input)` or `client.call("local-mcp:enableClient", ["codex", input])` to install it directly. This replaces that client's existing Milagre access. Use `create` for a separate connection that does not replace the client's current setup.

The shared types are in `packages/shared/src/local-mcp.ts`. Grant keys are `projects`, `worktrees`, `chats` and `designs`; an omitted group gives no access. Management scopes contain `projectPaths` (`"*"` or `string[]`) and capabilities (`projects: read/create`, `worktrees: read/create`, `chats: read/create/start`). Designs scopes contain `chatId`, `designIds` and `read/write`. Tool arguments cannot modify permissions without user approval in the calling Chat.

## Tool registration and branch composition

`createLocalMcpRegistry({connection})` exports `registerToolGroup(group)` and `toolsFor(connectionId)`. A group is:

```ts
{
  id: "designs",
  enabled: () => artifacts.enabled(),
  tools: ({ scope, currentScope, assertActive, connectionId }) => definitions
}
```

Definitions keep `{name, description, input, readOnly, run}` and require `capability`. Inputs are strict Zod shapes. `assertActive()` rejects revoked/expired connections, changed grant revisions and disabled groups. Call it after awaited preparation and immediately before mutation. The registry also checks before invocation and before releasing results. Edits invalidate old definitions even if the new grant happens to contain the same capability; long-lived in-process agent tool lists consult `currentScope()` on each call so newly granted Projects take effect without restarting the session. The resource adapter still owns filtering and authorization by Project, Chat, design or comment identity.

The Designs branch owns `packages/core/src/design-mcp-tools.cjs` and its `createDesignToolGroup({artifacts})` export. This branch intentionally does not duplicate that file, schemas, store, editor or publishing tools. `runtime.cjs` registers that export when present. Until the two branches are composed, design-only connection creation and isolation work, with zero design tools available.

Compose both diffs into an integration checkout. In `runtime.cjs`, retain the Designs branch's artifact initialization/settings/events and this branch's Local MCP initialization. Keep the adapter registered once; `extraTools` uses its registry definitions when the adapter exists, falling back to the original artifacts only on the pre-Designs checkout. Run both `design-mcp-tools.test.cjs` and the local MCP/runtime tests after composition. The composed adapter carries `assertActive` into the asynchronous design store queue and checks again immediately before committing version metadata or resolved comments. The registry post-check also withholds responses after access changes. A composed regression holds the queue, edits or revokes the grant, releases the queue and verifies no mutation occurred for `design_show`, `design_apply` or `artifact_resolve_comment`. The runtime regression exercises design creation, listing, reading and editing through the authenticated HTTP endpoint, including Designs OFF/ON.

## Operations and recovery

`project_accounts({projectPath, refresh?})` returns the Project's public provider Account choices, effective IDs and computer defaults (`projects: read`). `project_set_account({projectPath, provider, accountId})` chooses one of those IDs, or `null` to follow the computer default (`projects: create`). These tools share the model picker's account routing: every Chat in that Project uses the selection on its next idle turn; running turns and background tasks keep their original Account. Named Links keep their independent selections. Both tools enforce Project grants and connection revocation. They never return credentials, sign in, send a prompt or restart a Chat.

The CLI exposes the same scoped tools to other Chats:

```sh
milagre project accounts --chat /absolute/project#1 --project-path /absolute/project
milagre project set account --chat /absolute/project#1 --project-path /absolute/project --provider codex --account-id ACCOUNT_ID
```

Owner CLI calls also support Link scope keys through `milagre accounts scope --scope-key KEY` and `milagre accounts assign --scope-key KEY --provider codex --account-id ACCOUNT_ID`. Use `--account-id null` to restore inheritance. These are the existing `accounts:scope` and `accounts:assign` daemon operations.

Named tools are `project_list`, `project_add`, `worktree_list`, `worktree_create`, `worktree_remove`, `worktree_link`, `worktree_unlink`, `chat_list`, `chat_read`, `chat_search`, `chat_create`, `chat_start`, `chat_stop`, `chat_set_mode`, `chat_respond` and `chat_update`. Outside callers and Bot rules Chats see only allowed resources; non-bot Chat callers see all registered Projects in `project_list` with `inScope: boolean` and can request user approval to access out-of-scope Projects (`Allow once` for a single call, or `Always allow in this chat` to persist a per-Chat Project grant in `local-mcp/chat-grants.json` until either Project is forgotten, which also unlocks `delegate` to that Project's Worktrees without a canvas Link; Full permission mode approves out-of-scope management calls without persisting a grant across a return to Ask or Auto, while `project_add` persists the grant). `chat_read` returns a bounded number of recent messages and progress, plus the approvals and questions the Chat waits on with their `requestId`, and the messages queued behind its running turn. Worktree creation uses the existing host operation, including file copy, registration and setup before the first turn.

`chat_start` switches the Chat's provider, model and effort when given, as the composer's pickers do; a new provider hands off. When an agent can't take a message mid-turn (Antigravity), `chat_start` adds it to the durable Chat queue and the answer's `note` says it will wait. The message runs after the current turn; Stop keeps it queued for Send now, including after a restart. `files` and `images` are absolute paths inside the Chat's Worktree. Without `permissionMode` it preserves the live Chat permission mode; a Chat without a live provider takes the mode of the Chat whose agent called `chat_start`, and Ask when the caller is an outside client.

One rule gates every tool that widens access: a tool never gives a Chat more than its caller has. Past that, an agent caller gets an approval card in its own Chat, and an outside client, which counts as an Ask caller with no Chat to ask in, is refused.

| Tool                                                | Capability                          | Needs the user's approval when                                                                                                                                                                                                                      |
| --------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_add`                                       | `projects: create`                  | the caller is an agent not in Full mode. Validates a local Git repository outside Milagre's internal `dataDir` and bot homes, registers it without switching focus, and grants the calling Chat access to it. Refused for outside clients and Bots. |
| Management tools on an out-of-scope Project         | group capability                    | the caller is an agent not in Full mode and the Project is registered in Milagre (`Allow once` or `Always allow in this chat`). Outside clients are refused unless their grant includes the Project or `"*"`.                                       |
| `chat_start` with `permissionMode`, `chat_set_mode` | `chats: start`                      | the mode is above the caller's                                                                                                                                                                                                                      |
| `chat_respond`                                      | `chats: start`                      | the answer allows or answers (not deny/dismiss) and the caller isn't in Full permission. A Chat can't answer its own.                                                                                                                               |
| `worktree_link`                                     | `worktrees: create`                 | the caller is an agent in Ask mode. `targetWorktreeId` defaults to the target Project's main checkout Worktree when omitted. An outside client needs both Projects in its scope; an agent may name any Project open in Milagre.                     |
| `chat_stop`, `chat_update`, `worktree_unlink`       | `chats: start`, `worktrees: create` | never once the Project is in scope: they stop, rename, archive or take access away. `worktree_unlink` removes only Worktree-to-Worktree Links; Project Links stay on the canvas.                                                                    |
| `worktree_remove`                                   | `worktrees: create`                 | the caller is an agent in Ask mode. It only does the safe removal: a Worktree Milagre made, with nothing uncommitted, no commits off its base or upstream, no Chat running and its Chats with messages archived; never the caller's own Worktree.   |

`worktree_create`, `chat_create` and `chat_start` require `requestId`. Reuse it only with the identical tool and arguments. The journal is keyed by connection and request ID, with a canonical argument hash. Simultaneous identical calls share a result; different arguments conflict. Completed results persist across host restarts. Worktree, Chat and message markers recover mutations committed before their journal acknowledgement. If a crash left no conclusive marker, retries return an uncertain-outcome error and never replay the mutation. Inspect Milagre before issuing new work. Worktree creation interrupted between Git creation and registration is one such case.

Grant edits and revocation stop new admissions, queued mutations that have not passed their authorization check, and read responses awaiting delivery. They do not roll back a mutation already committed or stop a task already accepted. Restart retains the endpoint port and grants; if that port is unavailable the listener fails closed and Settings reports the failure.

Transport follows the JSON-response form of [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports), with supported protocol versions `2025-03-26` and `2025-06-18`, strict Host/Origin checks, authentication, bounded request bodies and no SSE stream. Existing internal agent URLs use unguessable, memory-only Chat tokens on the same listener. An agent's own grant covers its Chat's Project; a shared Link Chat's covers its Link's member Projects, as the last turn resolved them, and it can `delegate` to their Chats (no Negotiations). Those tokens are rejected when the Chat is unavailable/archived or the host stops. External clients use bearer headers, never URL credentials.

The ordinary request limit is 1 MiB. A single `design_show` or `design_apply` object may use up to 6,000,000 bytes plus 64 KiB for escaped JSON and UTF-8. Large batches and unrelated calls remain rejected. Oversize requests return HTTP 413 with a bounded JSON-RPC error; this transport allowance never grants write permission.

## Verification

Run `npm test -- --only local-mcp` for store/registry/retry, real-host and desktop flow checks. `node --test --test-name-pattern='local MCP' scripts/mobile-ui.test.cjs` exercises the actual phone component and shared hook with a fixture client. The originating Designs Chat reviews the complete diff and verifies the composed design adapter before integration. This branch supplies a commit for the Designs owner to include in the combined PR. No separate PR, deployment, release or merge is part of this work.

Client installers are tested against isolated home directories, all seven configuration formats, expiry, revocation, interrupted writes, moved executable paths, concurrent edits and conflicting files. The stdio adapter is exercised by an MCP SDK client against the loopback service. These checks do not claim to launch all seven vendor applications. Native phone interaction remains unverified because simulator attachment was rejected; the phone component/hook flow and typecheck run without a new native build.

Final integration checks on October 13, 2026: root/mobile typechecks, root lint, the isolated Electron MCP settings flow and both mobile component/hook checks passed. The required default `npm test -- --unit` run passed: 3,312 passed, 11 skipped across 335 files. An earlier default run had an advisor event timeout; its file, a four-worker full run and this final default run passed without advisor code changes. The mobile workspace has no separate lint script; root lint includes mobile. Lint reports warnings but no errors. The iOS native fingerprint stayed `e5a414af8a3ff01532f8dbd5db26667e27e52bb9`. A separate Electron smoke check also loaded the stdio adapter from an `app.asar` archive and completed SDK initialization, discovery and invocation.

Final inspected desktop screenshots are outside the repository in `/tmp/local-mcp-integration-shots/`: `local-mcp-clients-dark.png`, `local-mcp-clients-light.png`, `local-mcp-client-access.png` and `local-mcp-scope.png`. Publish PR evidence through the repository's separate screenshots branch, never in the feature commit.
