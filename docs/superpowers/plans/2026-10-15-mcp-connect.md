# Settings › MCP: connect servers from Milagre, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From Settings › MCP on desktop and phone, a user adds an MCP server (Everywhere by default), signs in to it, turns it on or off per account, edits and removes it, on a redesigned page.

**Architecture:** `packages/core/src/mcp/` grows a store (`mcp.json`: Everywhere servers and the off list), definition converters, per-provider writers and sign-in runners, and `createMcp` gains `save`, `remove`, `toggle`, `signIn`, `definition` and `forSession`. Chat start asks `forSession` for extra servers and the off list and passes them to Claude (`mcpServers` + `toggleMcpServer`), Codex (thread config) and Antigravity (ACP `mcpServers`). The runtime exposes new `mcp:*` commands; local-only ones (command-server writes, sign-in) are blocked at the existing gates. Desktop and phone render the approved design from shared grouping in `@milagre/shared/mcp`.

**Tech Stack:** Node CommonJS (core, daemon), `@anthropic-ai/claude-agent-sdk` 0.3.288 (unlisted `mcpAuthenticate`), Codex app-server JSON-RPC (`CodexRpc`, CLI ≥ 0.160.0), React + Tailwind (desktop), Expo Router + React Native (phone), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-15-mcp-connect-design.md` (issue #376). Designs in Chat #5019: "Desktop A, grouped cards" v8, "Desktop A, add server sheet" v4, "Phone, MCP list" v6.

**Narrowings against the spec, decided while planning (say so in the PR):**
- Codex and Antigravity can't report the status of an Everywhere server outside their own config without starting a thread or session, so those chips read **"Loads in Chats"** (new state `unchecked`). Sign-in for an Everywhere server runs on Claude accounts only, plus Codex accounts whose own config has the server. Task 1 checks whether Codex `mcpServer/oauth/login` sees thread-config servers; if it does, a follow-up issue adds Codex Everywhere sign-in.
- Claude's status API reports project servers without their path, so "From projects, plugins and claude.ai" groups by **source label**: "Project", "Plugin · <plugin>", "claude.ai connectors".

## Global Constraints

- Desktop and phone ship together (AGENTS.md "Desktop and mobile stay in sync"). JS only: no native dependency or `app.json` change, so the phone gets an OTA. Check the fingerprint before the PR (`apps/mobile/AGENTS.md`).
- Milagre stores no OAuth tokens. Tokens stay in each provider's own storage.
- New servers default to **Everywhere**. "Claude only" writes the default Claude account's user config (`claude mcp add-json --scope user`); "Codex only" writes the default Codex account's config through the app-server.
- Writes never edit `.claude.json` or `config.toml` text directly. Reads of those files for names and definitions are allowed.
- `mcp.json` lives at `<dataDir>/mcp.json`, mode 0600, atomic writes (temp + rename).
- Local-only commands: `mcp:save` (accepts command servers), `mcp:signIn`, `mcp:cancelSignIn`. Remote-allowed: `mcp:accounts`, `mcp:check`, `mcp:definition`, `mcp:saveUrl`, `mcp:remove`, `mcp:toggle`.
- Sign-in cap: 5 minutes per account. Check cap stays 30 s; client deadlines stay 45 s.
- Header and env values never leave the Mac in clear: `mcp:definition` returns them as `MCP_SECRET_MASK` (`"••••••"`); a save that sends the mask back keeps the stored value.
- Visual rules (both platforms): black accents (`ink`), no green, no status dots, red only for failures and Remove, red `triangle-alert` next to a failed row's summary, rows expand in place.
- Copy, verbatim: "Needs sign-in", "Your servers", "From projects, plugins and claude.ai", "Finish in your browser, then come back.", "Load it in", "Everywhere", "Milagre Chats on every provider", "Claude only", "Codex only", "Add and sign in", "On the Mac", "Loads in Chats", "Off in Milagre Chats".
- Before the PR: `npm run typecheck`, `npm run lint`, `npm test -- --unit`, `npm test -- --only test-mcp-settings`.
- PR screenshots go on the orphan `screenshots` branch, linked by SHA, never in PR commits. No Claude attribution anywhere.

## Review Focus

1. **A server name with characters a CLI or TOML key rejects** (`my server`, `a.b`, `../x`): the sheet refuses it with "Use letters, numbers, - and _ only." before any write. Test in Task 2.
2. **Saving an edit without touching a masked header** (`Authorization: ••••••`): the stored token survives; a real new value replaces it. Test in Task 4.
3. **Sign-in where the user closes the browser tab:** the row returns to Sign in after Cancel or the 5-minute cap, the idle Claude session and Codex app-server are closed, and nothing else changes. Tests in Task 6.
4. **An Everywhere server with the same name as one in a provider's config:** that provider keeps its own; the Everywhere copy is not injected and its chip says "Uses Claude's own pencil". Tests in Tasks 7 and 8.
5. **A phone or paired Mac trying to add a command server or start sign-in:** refused at the gate with 403 / `NOT_AVAILABLE_REMOTELY`, and the phone UI never offers it. Tests in Task 11.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/shared/src/mcp.ts` | Types (definitions, targets, events), `groupMcpRows` (attention / user / other by source), `mcpSummary`, `mcpTransportLine`, `validateMcpServer`, `MCP_SECRET_MASK`. |
| `packages/core/src/mcp/store.cjs` (new) | `createMcpStore(file)`: Everywhere list + off list in `mcp.json`. |
| `packages/core/src/mcp/definitions.cjs` (new) | Convert definitions to/from Claude, Codex and ACP shapes; mask/unmask; read server names from a Claude or Codex config. |
| `packages/core/src/mcp/claude.cjs` | `checkClaude` (+ Everywhere, detail), `addClaude`, `removeClaude`, `signInClaude`. |
| `packages/core/src/mcp/codex.cjs` | `checkCodex` (+ detail), `addCodex`, `removeCodex`, `signInCodex`, `readCodexDefinition`. |
| `packages/core/src/mcp/index.cjs` | `createMcp`: accounts (with Antigravity), check (Everywhere, off list, shadowing), definition, save, remove, toggle, signIn, cancelSignIn, forSession; emits `mcp:changed`. |
| `packages/core/src/account-mcp.cjs` | Remove servers an added account inherited once they leave the source. |
| `packages/core/src/agents/session-manager.cjs` | Pass `accountId` to `createSession`. |
| `packages/core/src/agents/{claude-provider,codex-provider,acp-session}.cjs` | Apply `mcpExtras()` at session start. |
| `packages/core/src/runtime.cjs` | Store, `openUrl`, new commands, `mcpExtras` in `createSession`. |
| `apps/daemon/src/{mobile-bridge,peer-policy,confine,client}.cjs`, `apps/desktop/electron/{computer-routing,preload}.cjs`, `apps/mobile/src/{client,live}.ts` | Gates, timeouts, the `mcp` live signal. |
| `apps/desktop/app/src/electron.d.ts` | Bridge types. |
| `apps/desktop/app/src/components/primitives/Switch.tsx` (new) | The Settings switch, shared. |
| `apps/desktop/app/src/components/McpSettings.tsx` | Page + data. |
| `apps/desktop/app/src/components/McpServerRow.tsx` (new) | A row and its expanded panel; the sign-in row. |
| `apps/desktop/app/src/components/McpServerSheet.tsx` (new) | Add / edit dialog. |
| `scripts/test-mcp-settings.cjs` | Electron check for the new page. |
| `apps/mobile/src/use-mcp.ts` (new) | Phone data hook (checks, live refresh). |
| `apps/mobile/src/mcp-section.tsx` | Phone list. |
| `apps/mobile/src/app/mcp-server.tsx`, `apps/mobile/src/app/mcp-add.tsx` (new) | Server detail; add/edit URL server sheet. |

---

### Task 1: Verify the three open items (throwaway probes, nothing committed but notes)

**Files:**
- Create (scratch, not committed): `$TMPDIR/mcp-connect-probe/*.mjs`
- Modify: `docs/superpowers/specs/2026-10-15-mcp-connect-design.md` (append a "Probe results" section)

Run every probe with absolute paths: Claude CLI `/Users/victor/.local/bin/claude` (the shell `claude` alias spawns a stray remote session), SDK `/Users/victor/Code/personal/milagre-ade/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`. Never complete a real sign-in to a server Victor already uses, and never call `mcpClearAuth`.

- [ ] **Step 1: Claude token reuse.** In a temp `CLAUDE_CONFIG_DIR` copy of nothing (fresh dir), start an idle query with `mcpServers: { probe: { type: "http", url: "https://mcp.expo.dev/mcp" } }`, call `mcpAuthenticate("probe")`, print the result, close. Then start a second idle query with the identical `mcpServers` and read `mcpServerStatus()` for `probe`. Expected: first returns `authUrl`; second still `needs-auth` (no sign-in done). Record that the token key includes the config, so the sign-in session must pass exactly the Chat's config (Task 6 does). Ask Victor in the Chat to finish one sign-in for `probe` in that temp dir only if he wants the full loop verified; otherwise record "verified up to authUrl".

- [ ] **Step 2: `toggleMcpServer` on a user server.** Idle query in Victor's real environment (no prompt), wait for status to settle, call `toggleMcpServer("<a connected user server>", false)`, read `mcpServerStatus()`, then `toggleMcpServer(name, true)`. Expected: status reads `disabled` then back. Confirms the off list works per session and does not persist (re-run a fresh idle query: server connected).

- [ ] **Step 3: Codex writes and thread-config login.** Start `codex app-server` with a temp `CODEX_HOME` (copy `auth.json` only). Call `initialize`, then `config/value/write { keyPath: "mcp_servers.probe", value: { url: "https://mcp.expo.dev/mcp", http_headers: { "X-Test": "1" } }, mergeStrategy: "replace" }`; then `config/read` and confirm `mcp_servers.probe` round-trips; then run `codex mcp remove probe` with that `CODEX_HOME` and confirm it is gone. Then call `thread/start { cwd, config: { mcp_servers: { probe2: { url: "https://mcp.expo.dev/mcp" } } }, ephemeral: true }` and `mcpServer/oauth/login { name: "probe2", threadId }`; record whether it returns `authorizationUrl` or an error, and whether `ephemeral` is accepted.

- [ ] **Step 4: Thread config `enabled: false` merges.** With a server present in the temp config, start a thread with `config: { mcp_servers: { probe: { enabled: false } } }` and read `mcpServerStatus/list { threadId }`. Expected: `probe` disabled, its URL still known (merge, not replace). If it replaces instead, Task 9 must send the full definition with `enabled: false`; record which.

- [ ] **Step 5: Record results and commit**

Append to the spec:

```markdown
## Probe results (2026-10-15, Task 1)

- Claude token reuse: <result>
- toggleMcpServer on a user server: <result>
- Codex config/value/write add + `codex mcp remove`: <result>
- Codex oauth/login on a thread-config server: <result>; ephemeral accepted: <yes/no>
- Codex thread config `enabled: false`: <merges / replaces>
```

```bash
git add docs/superpowers/specs/2026-10-15-mcp-connect-design.md
git commit -m "docs: record MCP connect probe results (#376)"
```

If Step 2 or Step 3's write fails, stop and report to Victor before Task 5: those are the write and off-list paths the rest of the plan relies on.

---

### Task 2: Shared types, grouping and validation

**Files:**
- Modify: `packages/shared/src/mcp.ts`
- Modify: `packages/shared/src/mcp.test.ts`

**Interfaces:**
- Produces (all later tasks use these exact names):

```ts
export type McpProvider = "claude" | "codex" | "antigravity";
export type McpChipState = "connected" | "failed" | "needs-sign-in" | "pending" | "disabled" | "unchecked";
export type McpTransport = "command" | "url" | "connector";
export type McpScope = "user" | "project" | "local" | "plugin" | "claude.ai" | "built-in" | "everywhere";
export type McpServerReport = { name: string; transport: McpTransport; scope: McpScope; state: McpChipState; tools: number; error: string | null; detail: string | null; shadowedBy?: McpProvider };
export type McpAccount = { provider: McpProvider; accountId: string; label: string };
export type McpAccountCheck = McpAccount & { problem: string | null; servers: McpServerReport[] };
export type McpChip = McpAccount & { scope: McpScope; state: McpChipState; tools: number; error: string | null; shadowedBy?: McpProvider };
export type McpRow = { name: string; transport: McpTransport; detail: string | null; editable: boolean; everywhere: boolean; source: string | null; chips: McpChip[] };
export type McpTarget = "everywhere" | "claude" | "codex";
export type McpServerDefinition =
  | { name: string; type: "http" | "sse"; url: string; headers: Record<string, string> }
  | { name: string; type: "stdio"; command: string; args: string[]; env: Record<string, string> };
export type McpChangedEvent = { name: string | null; provider?: McpProvider; accountId?: string; signIn?: "done" | "failed" | "cancelled"; error?: string | null; last?: boolean };
export const MCP_SECRET_MASK = "••••••";
export function groupMcpRows(checks: McpAccountCheck[]): { attention: McpRow[]; user: McpRow[]; other: { source: string; rows: McpRow[] }[] };
export function mcpSummary(row: McpRow): string;
export function mcpStateCopy(state: McpChipState): string;
export function mcpTransportLine(row: Pick<McpRow, "transport" | "detail">): string;
export function mcpChipLine(chip: McpChip): string;
export function validateMcpServer(server: McpServerDefinition): string | null;
```

- [ ] **Step 1: Write the failing tests** (replace the body of `mcp.test.ts` below its imports; keep the import line, adding the new names)

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { groupMcpRows, mcpChipLine, mcpSummary, mcpTransportLine, validateMcpServer, type McpAccountCheck, type McpServerReport } from "./mcp.ts";

const server = (over: Partial<McpServerReport>): McpServerReport => ({
  name: "pencil", transport: "command", scope: "user", state: "connected", tools: 14, error: null, detail: "pencil mcp --stdio", ...over,
});
const check = (provider: McpAccountCheck["provider"], accountId: string, servers: McpServerReport[]): McpAccountCheck => ({ provider, accountId, label: accountId, problem: null, servers });

test("rows needing sign-in go to attention and leave the other lists", () => {
  const { attention, user } = groupMcpRows([
    check("claude", "default", [server({ name: "linear", transport: "url", state: "needs-sign-in", detail: "https://mcp.linear.app/mcp" }), server({})]),
    check("codex", "default", [server({ name: "linear", transport: "url", detail: "https://mcp.linear.app/mcp" })]),
  ]);
  assert.deepEqual(attention.map((row) => row.name), ["linear"]);
  assert.deepEqual(user.map((row) => row.name), ["pencil"]);
});

test("a command server that reports needs-sign-in is not offered sign-in", () => {
  const { attention, user } = groupMcpRows([check("claude", "default", [server({ state: "needs-sign-in" })])]);
  assert.equal(attention.length, 0);
  assert.equal(user.length, 1);
});

test("everywhere rows are editable and flagged", () => {
  const { user } = groupMcpRows([check("antigravity", "default", [server({ scope: "everywhere", state: "unchecked" })])]);
  assert.equal(user[0].everywhere, true);
  assert.equal(user[0].editable, true);
});

test("other rows group by source label", () => {
  const { other } = groupMcpRows([
    check("claude", "default", [
      server({ name: "argent", scope: "project" }),
      server({ name: "plugin:engineering:notion", transport: "url", scope: "plugin", detail: "https://mcp.notion.com/mcp" }),
      server({ name: "claude.ai Gmail", transport: "connector", scope: "claude.ai", detail: null }),
    ]),
  ]);
  assert.deepEqual(other.map((group) => group.source), ["Project", "Plugin · engineering", "claude.ai connectors"]);
});

test("summary counts connected, or on when something is off", () => {
  const rows = groupMcpRows([check("claude", "a", [server({})]), check("claude", "b", [server({ state: "disabled" })])]).user;
  assert.equal(mcpSummary(rows[0]), "1 of 2 on");
  const all = groupMcpRows([check("claude", "a", [server({})]), check("codex", "b", [server({})])]).user;
  assert.equal(mcpSummary(all[0]), "2 of 2 connected");
  assert.equal(mcpSummary(groupMcpRows([check("claude", "a", [server({})])]).user[0]), "Connected");
});

test("transport line shows the host for URLs and the command line otherwise", () => {
  assert.equal(mcpTransportLine({ transport: "url", detail: "https://mcp.linear.app/mcp" }), "URL · mcp.linear.app");
  assert.equal(mcpTransportLine({ transport: "command", detail: "npx @playwright/mcp@latest" }), "Command · npx @playwright/mcp@latest");
  assert.equal(mcpTransportLine({ transport: "connector", detail: null }), "claude.ai connector");
  assert.equal(mcpTransportLine({ transport: "url", detail: "not a url" }), "URL · not a url");
});

test("chip line reads tools, off, unchecked and shadowed", () => {
  const base = { provider: "claude" as const, accountId: "a", label: "a", scope: "user" as const, tools: 14, error: null };
  assert.equal(mcpChipLine({ ...base, state: "connected" }), "Connected · 14 tools");
  assert.equal(mcpChipLine({ ...base, state: "disabled" }), "Off in Milagre Chats");
  assert.equal(mcpChipLine({ ...base, state: "unchecked", scope: "everywhere" }), "Loads in Chats");
  assert.equal(mcpChipLine({ ...base, state: "connected", scope: "everywhere" }), "Connected · 14 tools · from Everywhere");
  assert.equal(mcpChipLine({ ...base, state: "failed", error: "spawn x ENOENT" }), "spawn x ENOENT");
  assert.equal(mcpChipLine({ ...base, state: "connected", shadowedBy: "claude" }), "Connected · 14 tools · uses Claude’s own");
});

test("validation refuses unsafe names and missing fields", () => {
  const url = { name: "linear", type: "http" as const, url: "https://mcp.linear.app/mcp", headers: {} };
  assert.equal(validateMcpServer(url), null);
  for (const name of ["", "my server", "a.b", "../x", "milagre"]) assert.ok(validateMcpServer({ ...url, name }), name);
  assert.equal(validateMcpServer({ ...url, url: "ftp://x" }), "Enter an http or https URL.");
  assert.equal(validateMcpServer({ name: "x", type: "stdio", command: " ", args: [], env: {} }), "Enter the command to run.");
  assert.equal(validateMcpServer({ ...url, headers: { "": "v" } }), "Every header needs a name.");
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test packages/shared/src/mcp.test.ts`
Expected: FAIL (`mcpChipLine is not a function`, attention undefined).

- [ ] **Step 3: Implement** (replace `packages/shared/src/mcp.ts`)

```ts
// MCP servers as Settings › MCP shows them, shared by desktop and phone (docs/superpowers/specs/2026-10-15-mcp-connect-design.md).

export type McpProvider = "claude" | "codex" | "antigravity";
export type McpChipState = "connected" | "failed" | "needs-sign-in" | "pending" | "disabled" | "unchecked";
export type McpTransport = "command" | "url" | "connector";
export type McpScope = "user" | "project" | "local" | "plugin" | "claude.ai" | "built-in" | "everywhere";
/** One server as one account loads it. `detail` is the URL or the command line. */
export type McpServerReport = { name: string; transport: McpTransport; scope: McpScope; state: McpChipState; tools: number; error: string | null; detail: string | null; shadowedBy?: McpProvider };
export type McpAccount = { provider: McpProvider; accountId: string; label: string };
/** The answer to mcp:check. `problem` is set when the account could not be checked; `servers` is then empty. */
export type McpAccountCheck = McpAccount & { problem: string | null; servers: McpServerReport[] };
export type McpChip = McpAccount & { scope: McpScope; state: McpChipState; tools: number; error: string | null; shadowedBy?: McpProvider };
export type McpRow = { name: string; transport: McpTransport; detail: string | null; editable: boolean; everywhere: boolean; source: string | null; chips: McpChip[] };
/** Where a saved server goes: Milagre's own list, or one provider's user config. */
export type McpTarget = "everywhere" | "claude" | "codex";
export type McpServerDefinition =
  | { name: string; type: "http" | "sse"; url: string; headers: Record<string, string> }
  | { name: string; type: "stdio"; command: string; args: string[]; env: Record<string, string> };
/** Sent after a write, a toggle or a finished sign-in, so open screens check again. */
export type McpChangedEvent = { name: string | null; provider?: McpProvider; accountId?: string; signIn?: "done" | "failed" | "cancelled"; error?: string | null; last?: boolean };
/** Header and env values leave the Mac as this; a save that sends it back keeps the stored value. */
export const MCP_SECRET_MASK = "••••••";

const PROVIDER_NAMES: Record<McpProvider, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };

function sourceOf(name: string, scope: McpScope): string {
  if (scope === "project") return "Project";
  if (scope === "local") return "Local";
  if (scope === "claude.ai") return "claude.ai connectors";
  if (scope === "plugin") {
    const plugin = /^plugin:([^:]+):/.exec(name)?.[1];
    return plugin ? `Plugin · ${plugin}` : "Plugin";
  }
  return "Built in";
}

/** Rows by server name. Attention: URL or connector rows with a chip that needs sign-in. User: editable rows. Other: the rest, by source. */
export function groupMcpRows(checks: McpAccountCheck[]): { attention: McpRow[]; user: McpRow[]; other: { source: string; rows: McpRow[] }[] } {
  const rows = new Map<string, McpRow>();
  for (const check of checks) {
    if (check.problem) continue;
    for (const server of check.servers) {
      const row = rows.get(server.name) ?? { name: server.name, transport: server.transport, detail: server.detail, editable: false, everywhere: false, source: null, chips: [] };
      row.chips.push({
        provider: check.provider,
        accountId: check.accountId,
        label: check.label,
        scope: server.scope,
        state: server.state,
        tools: server.tools,
        error: server.error,
        ...(server.shadowedBy ? { shadowedBy: server.shadowedBy } : {}),
      });
      row.detail ??= server.detail;
      row.editable ||= server.scope === "user" || server.scope === "everywhere";
      row.everywhere ||= server.scope === "everywhere";
      rows.set(server.name, row);
    }
  }
  const sorted = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  const needsSignIn = (row: McpRow) => row.transport !== "command" && row.chips.some((chip) => chip.state === "needs-sign-in");
  const attention = sorted.filter(needsSignIn);
  const rest = sorted.filter((row) => !needsSignIn(row));
  const groups = new Map<string, McpRow[]>();
  for (const row of rest.filter((row) => !row.editable)) {
    row.source = sourceOf(row.name, row.chips[0]?.scope ?? "built-in");
    groups.set(row.source, [...(groups.get(row.source) ?? []), row]);
  }
  return { attention, user: rest.filter((row) => row.editable), other: [...groups].map(([source, rows]) => ({ source, rows })) };
}

const STATE_COPY: Record<McpChipState, string> = {
  connected: "Connected",
  failed: "Failed",
  "needs-sign-in": "Needs sign-in",
  pending: "Checking",
  disabled: "Off in Milagre Chats",
  unchecked: "Loads in Chats",
};
export const mcpStateCopy = (state: McpChipState) => STATE_COPY[state];

/** "Connected" for one chip; "2 of 3 connected"; "1 of 2 on" once any chip is off. */
export function mcpSummary(row: McpRow): string {
  const [only] = row.chips;
  if (only && row.chips.length === 1) return STATE_COPY[only.state];
  if (row.chips.some((chip) => chip.state === "disabled")) return `${row.chips.filter((chip) => chip.state !== "disabled").length} of ${row.chips.length} on`;
  return `${row.chips.filter((chip) => chip.state === "connected").length} of ${row.chips.length} connected`;
}

/** "URL · mcp.linear.app", "Command · npx …", "claude.ai connector". */
export function mcpTransportLine(row: Pick<McpRow, "transport" | "detail">): string {
  if (row.transport === "connector") return "claude.ai connector";
  if (row.transport === "command") return row.detail ? `Command · ${row.detail}` : "Command";
  if (!row.detail) return "URL";
  try {
    return `URL · ${new URL(row.detail).host}`;
  } catch {
    return `URL · ${row.detail}`;
  }
}

/** One account's line in an open row. */
export function mcpChipLine(chip: McpChip): string {
  if (chip.state === "failed") return chip.error ?? STATE_COPY.failed;
  if (chip.state !== "connected") return STATE_COPY[chip.state];
  const parts = [`Connected · ${chip.tools} tools`];
  if (chip.scope === "everywhere") parts.push("from Everywhere");
  if (chip.shadowedBy) parts.push(`uses ${PROVIDER_NAMES[chip.shadowedBy]}’s own`);
  return parts.join(" · ");
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The sheet's copy for the first problem, or null. */
export function validateMcpServer(server: McpServerDefinition): string | null {
  if (!NAME.test(server.name)) return "Use letters, numbers, - and _ only.";
  if (server.name === "milagre") return "milagre is Milagre’s own server. Pick another name.";
  if (server.type === "stdio") {
    if (!server.command.trim()) return "Enter the command to run.";
    if (Object.keys(server.env).some((key) => !key.trim())) return "Every variable needs a name.";
    return null;
  }
  if (!/^https?:\/\/\S+$/.test(server.url)) return "Enter an http or https URL.";
  if (Object.keys(server.headers).some((key) => !key.trim())) return "Every header needs a name.";
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `node --test packages/shared/src/mcp.test.ts`
Expected: PASS. Then `npm run typecheck` shows errors only in `McpSettings.tsx` and `mcp-section.tsx` (fixed in Tasks 12 and 13); note them, don't fix here.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/mcp.ts packages/shared/src/mcp.test.ts
git commit -m "feat(shared): MCP definitions, sign-in grouping and validation (#376)"
```

---

### Task 3: The store

**Files:**
- Create: `packages/core/src/mcp/store.cjs`
- Test: `packages/core/src/mcp/store.test.cjs`

**Interfaces:**
- Produces:
  - `createMcpStore(file) → { read(): { everywhere: McpServerDefinition[]; off: Record<string, string[]> }, setEverywhere(list): void, setOff(provider, accountId, name, off: boolean): void, offFor(provider, accountId): string[] }`
  - off keys are `"<provider>:<accountId>"`.

- [ ] **Step 1: Failing test**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMcpStore } = require("./store.cjs");

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-mcp-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const pencil = { name: "pencil", type: "stdio", command: "pencil", args: ["mcp"], env: {} };

test("a missing file reads empty", (t) => {
  assert.deepEqual(createMcpStore(path.join(folder(t), "mcp.json")).read(), { everywhere: [], off: {} });
});

test("everywhere and off persist at mode 0600", (t) => {
  const file = path.join(folder(t), "mcp.json");
  const store = createMcpStore(file);
  store.setEverywhere([pencil]);
  store.setOff("codex", "default", "pencil", true);
  store.setOff("codex", "default", "pencil", true);
  assert.deepEqual(createMcpStore(file).read(), { everywhere: [pencil], off: { "codex:default": ["pencil"] } });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  store.setOff("codex", "default", "pencil", false);
  assert.deepEqual(store.offFor("codex", "default"), []);
  assert.deepEqual(store.read().off, {});
});

test("a corrupt file reads empty and is replaced on the next write", (t) => {
  const file = path.join(folder(t), "mcp.json");
  fs.writeFileSync(file, "{nope");
  const store = createMcpStore(file);
  assert.deepEqual(store.read(), { everywhere: [], off: {} });
  store.setEverywhere([pencil]);
  assert.equal(store.read().everywhere.length, 1);
});
```

- [ ] **Step 2: Run, expect FAIL** (`Cannot find module './store.cjs'`): `node --test packages/core/src/mcp/store.test.cjs`

- [ ] **Step 3: Implement**

```js
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");

// Settings › MCP's own file: Everywhere servers (added to every provider at Chat start) and the off list
// (servers a provider account skips in Milagre Chats). Headers and env may hold tokens, hence 0600.

const EMPTY = () => ({ everywhere: [], off: {} });

function createMcpStore(file) {
  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      return { everywhere: Array.isArray(value.everywhere) ? value.everywhere : [], off: value.off && typeof value.off === "object" ? value.off : {} };
    } catch {
      return EMPTY();
    }
  }
  function write(value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  const offFor = (provider, accountId) => read().off[`${provider}:${accountId}`] ?? [];
  return {
    read,
    offFor,
    setEverywhere(list) {
      write({ ...read(), everywhere: list });
    },
    setOff(provider, accountId, name, off) {
      const value = read();
      const key = `${provider}:${accountId}`;
      const names = new Set(value.off[key] ?? []);
      if (off) names.add(name);
      else names.delete(name);
      if (names.size) value.off[key] = [...names].sort();
      else delete value.off[key];
      write(value);
    },
  };
}

module.exports = { createMcpStore };
```

- [ ] **Step 4: Run, expect PASS**: `node --test packages/core/src/mcp/store.test.cjs`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp/store.cjs packages/core/src/mcp/store.test.cjs
git commit -m "feat(core): mcp.json store for Everywhere servers and the off list (#376)"
```

---

### Task 4: Definition converters, masking and config names

**Files:**
- Create: `packages/core/src/mcp/definitions.cjs`
- Test: `packages/core/src/mcp/definitions.test.cjs`

**Interfaces:**
- Consumes: `MCP_SECRET_MASK` value `"••••••"` (copy the literal; core is CommonJS and does not import `@milagre/shared` TS).
- Produces:
  - `toClaudeConfig(def)`: `{ type: "http"|"sse", url, headers? }` or `{ type: "stdio", command, args, env? }`
  - `toCodexConfig(def)`: `{ url, http_headers? }` or `{ command, args, env? }`
  - `toAcpServer(def)`: `{ type: "http"|"sse", name, url, headers: [{name, value}] }` or `{ name, command, args, env: [{name, value}] }`
  - `fromClaudeConfig(name, config)` and `fromCodexConfig(name, config)`: each returns a definition or null
  - `maskDefinition(def)` and `unmaskDefinition(def, previous)`: definitions
  - `claudeConfigNames(file)` and `codexConfigNames(file)`: each returns `Set<string>`
  - `detailOf(def)`: string

- [ ] **Step 1: Failing test**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const d = require("./definitions.cjs");

const url = { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer abc" } };
const cmd = { name: "pencil", type: "stdio", command: "pencil", args: ["mcp", "--stdio"], env: { TOKEN: "t" } };

test("converts to each provider's shape", () => {
  assert.deepEqual(d.toClaudeConfig(url), { type: "http", url: url.url, headers: url.headers });
  assert.deepEqual(d.toClaudeConfig(cmd), { type: "stdio", command: "pencil", args: ["mcp", "--stdio"], env: { TOKEN: "t" } });
  assert.deepEqual(d.toCodexConfig(url), { url: url.url, http_headers: url.headers });
  assert.deepEqual(d.toCodexConfig({ ...cmd, env: {} }), { command: "pencil", args: ["mcp", "--stdio"] });
  assert.deepEqual(d.toAcpServer(url), { type: "http", name: "linear", url: url.url, headers: [{ name: "Authorization", value: "Bearer abc" }] });
  assert.deepEqual(d.toAcpServer(cmd), { name: "pencil", command: "pencil", args: ["mcp", "--stdio"], env: [{ name: "TOKEN", value: "t" }] });
});

test("reads back from provider configs", () => {
  assert.deepEqual(d.fromClaudeConfig("linear", { type: "http", url: url.url, headers: url.headers }), url);
  assert.deepEqual(d.fromClaudeConfig("pencil", { command: "pencil", args: ["mcp", "--stdio"], env: { TOKEN: "t" } }), cmd);
  assert.deepEqual(d.fromCodexConfig("linear", { url: url.url, http_headers: url.headers }), url);
  assert.equal(d.fromClaudeConfig("x", { type: "claudeai-proxy" }), null);
});

test("masking hides values and unmasking keeps untouched ones", () => {
  const masked = d.maskDefinition(url);
  assert.deepEqual(masked.headers, { Authorization: "••••••" });
  assert.deepEqual(d.unmaskDefinition(masked, url).headers, { Authorization: "Bearer abc" });
  assert.deepEqual(d.unmaskDefinition({ ...masked, headers: { Authorization: "Bearer new" } }, url).headers, { Authorization: "Bearer new" });
  assert.deepEqual(d.unmaskDefinition({ ...masked, headers: { "X-New": "••••••" } }, url).headers, {}, "a masked value with no stored value is dropped");
  assert.deepEqual(d.maskDefinition(cmd).env, { TOKEN: "••••••" });
});

test("reads server names from Claude and Codex configs", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-mcp-names-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ mcpServers: { pencil: {}, linear: {} } }));
  fs.writeFileSync(path.join(dir, "config.toml"), '[mcp_servers.pencil]\ncommand = "p"\n\n[mcp_servers."my-x"]\nurl = "u"\n[mcp_servers.pencil.env]\nA = "1"\n');
  assert.deepEqual([...d.claudeConfigNames(path.join(dir, ".claude.json"))].sort(), ["linear", "pencil"]);
  assert.deepEqual([...d.codexConfigNames(path.join(dir, "config.toml"))].sort(), ["my-x", "pencil"]);
  assert.equal(d.claudeConfigNames(path.join(dir, "missing.json")).size, 0);
});

test("detail is the URL or the command line", () => {
  assert.equal(d.detailOf(url), url.url);
  assert.equal(d.detailOf(cmd), "pencil mcp --stdio");
});
```

- [ ] **Step 2: Run, expect FAIL**: `node --test packages/core/src/mcp/definitions.test.cjs`

- [ ] **Step 3: Implement**

```js
const fs = require("node:fs");

// One MCP server definition (the sheet's shape, @milagre/shared/mcp McpServerDefinition) in each provider's
// own config shape, and back.

const MASK = "••••••"; // MCP_SECRET_MASK in @milagre/shared/mcp
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value) => (isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)])) : {});
const pairs = (record) => Object.entries(record).map(([name, value]) => ({ name, value }));
const withNonEmpty = (key, record) => (Object.keys(record).length ? { [key]: record } : {});

function toClaudeConfig(def) {
  if (def.type === "stdio") return { type: "stdio", command: def.command, args: def.args, ...withNonEmpty("env", def.env) };
  return { type: def.type, url: def.url, ...withNonEmpty("headers", def.headers) };
}

function toCodexConfig(def) {
  if (def.type === "stdio") return { command: def.command, args: def.args, ...withNonEmpty("env", def.env) };
  return { url: def.url, ...withNonEmpty("http_headers", def.headers) };
}

function toAcpServer(def) {
  if (def.type === "stdio") return { name: def.name, command: def.command, args: def.args, env: pairs(def.env) };
  return { type: def.type, name: def.name, url: def.url, headers: pairs(def.headers) };
}

function fromClaudeConfig(name, config) {
  if (!isObject(config)) return null;
  if (config.type === "http" || config.type === "sse") return { name, type: config.type, url: String(config.url ?? ""), headers: strings(config.headers) };
  if ((config.type === undefined || config.type === "stdio") && typeof config.command === "string")
    return { name, type: "stdio", command: config.command, args: Array.isArray(config.args) ? config.args.map(String) : [], env: strings(config.env) };
  return null;
}

function fromCodexConfig(name, config) {
  if (!isObject(config)) return null;
  if (typeof config.url === "string") return { name, type: "http", url: config.url, headers: strings(config.http_headers) };
  if (typeof config.command === "string") return { name, type: "stdio", command: config.command, args: Array.isArray(config.args) ? config.args.map(String) : [], env: strings(config.env) };
  return null;
}

const maskRecord = (record) => Object.fromEntries(Object.keys(record).map((key) => [key, MASK]));
function maskDefinition(def) {
  return def.type === "stdio" ? { ...def, env: maskRecord(def.env) } : { ...def, headers: maskRecord(def.headers) };
}

const unmaskRecord = (record, stored = {}) =>
  Object.fromEntries(Object.entries(record).flatMap(([key, value]) => (value !== MASK ? [[key, value]] : key in stored ? [[key, stored[key]]] : [])));
function unmaskDefinition(def, previous) {
  if (def.type === "stdio") return { ...def, env: unmaskRecord(def.env, previous?.type === "stdio" ? previous.env : {}) };
  return { ...def, headers: unmaskRecord(def.headers, previous && previous.type !== "stdio" ? previous.headers : {}) };
}

function claudeConfigNames(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Set(isObject(value.mcpServers) ? Object.keys(value.mcpServers) : []);
  } catch {
    return new Set();
  }
}

// Section headers only: [mcp_servers.name] or [mcp_servers."name"], not their sub-tables.
function codexConfigNames(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return new Set([...text.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)].map((match) => match[1] ?? match[2]));
  } catch {
    return new Set();
  }
}

const detailOf = (def) => (def.type === "stdio" ? [def.command, ...def.args].join(" ") : def.url);

module.exports = { MASK, toClaudeConfig, toCodexConfig, toAcpServer, fromClaudeConfig, fromCodexConfig, maskDefinition, unmaskDefinition, claudeConfigNames, codexConfigNames, detailOf };
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp/definitions.cjs packages/core/src/mcp/definitions.test.cjs
git commit -m "feat(core): MCP definition converters, masking and config names (#376)"
```

---

### Task 5: Writers (add and remove through each CLI)

**Files:**
- Modify: `packages/core/src/mcp/claude.cjs`, `packages/core/src/mcp/codex.cjs`
- Test: `packages/core/src/mcp/claude.test.cjs`, `packages/core/src/mcp/codex.test.cjs`

**Interfaces:**
- Consumes: `toClaudeConfig`, `toCodexConfig`, `fromCodexConfig` (Task 4).
- Produces:
  - `addClaude({ command, env, def, run })` and `removeClaude({ command, env, name, run })`: each `Promise<void>`
  - `addCodex({ command, env, cwd, def, clientVersion, createRpc })`: `Promise<void>`
  - `removeCodex({ command, env, name, run })`: `Promise<void>`
  - `readCodexDefinition({ command, env, cwd, name, clientVersion, createRpc })`: `Promise<McpServerDefinition | null>`
  - `run(command, args, { env })` resolves `{ stdout, stderr }` or rejects with an `Error` whose message is the CLI's stderr. The default is `runCli` in `claude.cjs`, exported.

- [ ] **Step 1: Failing tests** (append to each test file)

`claude.test.cjs`:

```js
const { addClaude, removeClaude, runCli } = require("./claude.cjs");

test("add and remove call the Claude CLI at user scope", async () => {
  const calls = [];
  const run = async (command, args, options) => (calls.push({ command, args, env: options.env }), { stdout: "", stderr: "" });
  await addClaude({ command: "/bin/claude", env: { A: "1" }, def: { name: "linear", type: "http", url: "https://x", headers: {} }, run });
  await removeClaude({ command: "/bin/claude", env: { A: "1" }, name: "linear", run });
  assert.deepEqual(calls, [
    { command: "/bin/claude", args: ["mcp", "add-json", "linear", '{"type":"http","url":"https://x"}', "--scope", "user"], env: { A: "1" } },
    { command: "/bin/claude", args: ["mcp", "remove", "linear", "--scope", "user"], env: { A: "1" } },
  ]);
});

test("runCli rejects with stderr", async () => {
  await assert.rejects(runCli(process.execPath, ["-e", "process.stderr.write('bad name'); process.exit(1)"], {}), /bad name/);
});
```

`codex.test.cjs`:

```js
const { addCodex, removeCodex, readCodexDefinition } = require("./codex.cjs");

function fakeRpc(answers) {
  const requests = [];
  return {
    requests,
    create: () => ({
      start() {},
      notify() {},
      close() {},
      on() {},
      off() {},
      async request(method, params) {
        requests.push({ method, params });
        return answers[method] ?? {};
      },
    }),
  };
}

test("addCodex writes mcp_servers.<name> through the app-server", async () => {
  const rpc = fakeRpc({});
  await addCodex({ command: "/bin/codex", cwd: "/", def: { name: "linear", type: "http", url: "https://x", headers: { A: "b" } }, createRpc: rpc.create });
  assert.deepEqual(rpc.requests.at(-1), {
    method: "config/value/write",
    params: { keyPath: "mcp_servers.linear", value: { url: "https://x", http_headers: { A: "b" } }, mergeStrategy: "replace" },
  });
});

test("removeCodex calls codex mcp remove", async () => {
  const calls = [];
  await removeCodex({ command: "/bin/codex", env: {}, name: "linear", run: async (command, args) => (calls.push([command, ...args]), { stdout: "", stderr: "" }) });
  assert.deepEqual(calls, [["/bin/codex", "mcp", "remove", "linear"]]);
});

test("readCodexDefinition reads config/read", async () => {
  const rpc = fakeRpc({ "config/read": { config: { mcp_servers: { linear: { url: "https://x" } } } } });
  assert.deepEqual(await readCodexDefinition({ command: "/bin/codex", cwd: "/", name: "linear", createRpc: rpc.create }), { name: "linear", type: "http", url: "https://x", headers: {} });
  assert.equal(await readCodexDefinition({ command: "/bin/codex", cwd: "/", name: "nope", createRpc: rpc.create }), null);
});
```

- [ ] **Step 2: Run, expect FAIL**: `node --test packages/core/src/mcp/claude.test.cjs packages/core/src/mcp/codex.test.cjs`

- [ ] **Step 3: Implement**

In `claude.cjs`, add near the top `const { execFile } = require("node:child_process");` and `const { toClaudeConfig } = require("./definitions.cjs");`, then before `module.exports`:

```js
// A CLI call with no shell; a failure carries the CLI's own message, which the sheet shows.
function runCli(command, args, { env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: env ?? process.env, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function addClaude({ command, env, def, run = runCli }) {
  await run(command, ["mcp", "add-json", def.name, JSON.stringify(toClaudeConfig(def)), "--scope", "user"], { env });
}

async function removeClaude({ command, env, name, run = runCli }) {
  await run(command, ["mcp", "remove", name, "--scope", "user"], { env });
}
```

Export: `module.exports = { checkClaude, claudeServer, addClaude, removeClaude, runCli };` (Task 6 adds `signInClaude`).

In `codex.cjs`, add `const { runCli } = require("./claude.cjs");` and `const { toCodexConfig, fromCodexConfig } = require("./definitions.cjs");`, and factor the handshake out of `checkCodex`:

```js
// An initialised app-server for one account; `use` runs with it and the server always closes.
async function withAppServer({ command, env, cwd, clientVersion = "0.0.0", signal, createRpc = (options) => new CodexRpc(options) }, use) {
  const rpc = createRpc({ command, cwd, ...(env ? { env } : {}) });
  rpc.start();
  const onAbort = () => rpc.close();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    await rpc.request("initialize", { clientInfo: { name: "milagre", title: "Milagre", version: clientVersion }, capabilities: null });
    rpc.notify("initialized");
    return await use(rpc);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    rpc.close();
  }
}

async function addCodex({ def, ...options }) {
  await withAppServer(options, (rpc) => rpc.request("config/value/write", { keyPath: `mcp_servers.${def.name}`, value: toCodexConfig(def), mergeStrategy: "replace" }));
}

async function removeCodex({ command, env, name, run = runCli }) {
  await run(command, ["mcp", "remove", name], { env });
}

async function readCodexDefinition({ name, ...options }) {
  return withAppServer(options, async (rpc) => fromCodexConfig(name, (await rpc.request("config/read", { cwd: options.cwd })).config?.mcp_servers?.[name]));
}
```

Rewrite `checkCodex` to `return withAppServer({ command, env, cwd, clientVersion, signal, createRpc }, async (rpc) => { …the existing body from config/read to return servers… })`. Export `{ checkCodex, codexServer, addCodex, removeCodex, readCodexDefinition, withAppServer }`.

- [ ] **Step 4: Run all mcp tests, expect PASS**: `node --test packages/core/src/mcp/*.test.cjs`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp/claude.cjs packages/core/src/mcp/codex.cjs packages/core/src/mcp/claude.test.cjs packages/core/src/mcp/codex.test.cjs
git commit -m "feat(core): add and remove MCP servers through the Claude and Codex CLIs (#376)"
```

---

### Task 6: Sign-in runners

**Files:**
- Modify: `packages/core/src/mcp/claude.cjs`, `packages/core/src/mcp/codex.cjs`
- Test: same test files

**Interfaces:**
- Consumes: `toClaudeConfig` (Task 4), `withAppServer` (Task 5).
- Produces:
  - `signInClaude({ command, env, cwd, name, everywhere, openUrl, signal, timeoutMs = 300_000, pollMs = 1000, loadSdk, now, sleep })` resolves `{ ok: true } | { ok: false, error: string } | { cancelled: true } | { opened: true }`. `opened` is a claude.ai connector that finishes on claude.ai.
  - `signInCodex({ command, env, cwd, name, openUrl, signal, timeoutMs = 300_000, clientVersion, createRpc })` resolves the same shape, without `opened`.
  - The timeout error copy is `"Sign-in timed out after 5 minutes. Try again."`.

- [ ] **Step 1: Failing tests**

`claude.test.cjs`:

```js
const { signInClaude } = require("./claude.cjs");

function fakeSdk({ auth, statuses }) {
  const seen = { options: null, closed: false, opened: [] };
  let index = 0;
  const loadSdk = async () => ({
    query: ({ options }) => {
      seen.options = options;
      return {
        mcpAuthenticate: async (name) => (typeof auth === "function" ? auth(name) : auth),
        mcpServerStatus: async () => statuses[Math.min(index++, statuses.length - 1)],
        close: () => (seen.closed = true),
      };
    },
  });
  return { seen, loadSdk };
}
const sleep = async () => {};

test("signInClaude opens the URL, waits for connected and closes", async () => {
  const { seen, loadSdk } = fakeSdk({
    auth: { authUrl: "https://auth", callbackExpected: true },
    statuses: [[{ name: "linear", status: "needs-auth" }], [{ name: "linear", status: "connected" }]],
  });
  const everywhere = [{ name: "linear", type: "http", url: "https://x", headers: {} }];
  const result = await signInClaude({ command: "/c", cwd: "/", name: "linear", everywhere, openUrl: (url) => seen.opened.push(url), loadSdk, sleep });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen.opened, ["https://auth"]);
  assert.deepEqual(seen.options.mcpServers, { linear: { type: "http", url: "https://x" } });
  assert.equal(seen.closed, true);
});

test("signInClaude reports a failed server, a cap and a cancel", async () => {
  const failed = fakeSdk({ auth: { authUrl: "u", callbackExpected: true }, statuses: [[{ name: "x", status: "failed", error: "invalid_client" }]] });
  assert.deepEqual(await signInClaude({ command: "/c", cwd: "/", name: "x", openUrl() {}, loadSdk: failed.loadSdk, sleep }), { ok: false, error: "invalid_client" });

  let clock = 0;
  const slow = fakeSdk({ auth: { authUrl: "u", callbackExpected: true }, statuses: [[{ name: "x", status: "needs-auth" }]] });
  const capped = await signInClaude({ command: "/c", cwd: "/", name: "x", openUrl() {}, loadSdk: slow.loadSdk, sleep: async () => void (clock += 1000), now: () => clock, timeoutMs: 3000 });
  assert.deepEqual(capped, { ok: false, error: "Sign-in timed out after 5 minutes. Try again." });
  assert.equal(slow.seen.closed, true);

  const controller = new AbortController();
  const waiting = fakeSdk({ auth: { authUrl: "u", callbackExpected: true }, statuses: [[{ name: "x", status: "needs-auth" }]] });
  const cancelled = signInClaude({ command: "/c", cwd: "/", name: "x", openUrl: () => controller.abort(), loadSdk: waiting.loadSdk, sleep, signal: controller.signal });
  assert.deepEqual(await cancelled, { cancelled: true });
  assert.equal(waiting.seen.closed, true);
});

test("signInClaude returns opened for a claude.ai connector and errors for stdio", async () => {
  const connector = fakeSdk({ auth: { authUrl: "https://claude.ai/x", callbackExpected: false }, statuses: [[]] });
  assert.deepEqual(await signInClaude({ command: "/c", cwd: "/", name: "claude.ai Linear", openUrl() {}, loadSdk: connector.loadSdk, sleep }), { opened: true });
  const stdio = fakeSdk({ auth: () => { throw new Error('Server type "stdio" does not support OAuth authentication'); }, statuses: [[]] });
  assert.deepEqual(await signInClaude({ command: "/c", cwd: "/", name: "p", openUrl() {}, loadSdk: stdio.loadSdk, sleep }), { ok: false, error: 'Server type "stdio" does not support OAuth authentication' });
});
```

`codex.test.cjs`:

```js
const { EventEmitter } = require("node:events");
const { signInCodex } = require("./codex.cjs");

test("signInCodex opens the authorization URL and waits for completion", async () => {
  const emitter = new EventEmitter();
  const requests = [];
  const createRpc = () => Object.assign(emitter, {
    start() {}, notify() {}, close() { emitter.closed = true; },
    async request(method, params) {
      requests.push({ method, params });
      if (method === "mcpServer/oauth/login") return { authorizationUrl: "https://auth" };
      return {};
    },
  });
  const opened = [];
  const result = signInCodex({
    command: "/x", cwd: "/", name: "expo", createRpc,
    openUrl: (url) => {
      opened.push(url);
      setImmediate(() => emitter.emit("notification", { method: "mcpServer/oauthLogin/completed", params: { name: "expo", success: true } }));
    },
  });
  assert.deepEqual(await result, { ok: true });
  assert.deepEqual(opened, ["https://auth"]);
  assert.deepEqual(requests.find((r) => r.method === "mcpServer/oauth/login").params, { name: "expo", timeoutSecs: 300 });
  assert.equal(emitter.closed, true);
});

test("signInCodex reports a failed completion", async () => {
  const emitter = new EventEmitter();
  const createRpc = () => Object.assign(emitter, {
    start() {}, notify() {}, close() {},
    async request(method) { return method === "mcpServer/oauth/login" ? { authorizationUrl: "u" } : {}; },
  });
  const result = signInCodex({
    command: "/x", cwd: "/", name: "expo", createRpc,
    openUrl: () => setImmediate(() => emitter.emit("notification", { method: "mcpServer/oauthLogin/completed", params: { name: "expo", success: false, error: "denied" } })),
  });
  assert.deepEqual(await result, { ok: false, error: "denied" });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

`claude.cjs` (before `module.exports`, and export `signInClaude`):

```js
const SIGN_IN_TIMEOUT = "Sign-in timed out after 5 minutes. Try again.";

// One account's OAuth sign-in to one server through the SDK's unlisted mcpAuthenticate (probed 2026-10-15):
// the CLI listens on a localhost port and swaps the code for a token itself; Milagre only opens the browser and
// watches mcpServerStatus. The session stays open until then because it hosts the callback. Everywhere servers
// are passed exactly as a Chat passes them, because the CLI keys the token by name and config.
async function signInClaude({
  command,
  env,
  cwd,
  name,
  everywhere = [],
  openUrl,
  signal,
  timeoutMs = 300_000,
  pollMs = 1000,
  loadSdk = () => import("@anthropic-ai/claude-agent-sdk"),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const { query } = await loadSdk();
  const idle = {
    // oxlint-disable-next-line require-yield -- never yields: the session stays idle and sends no prompt
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
  };
  const mcpServers = Object.fromEntries(everywhere.map((def) => [def.name, toClaudeConfig(def)]));
  const session = query({
    prompt: idle,
    options: { pathToClaudeCodeExecutable: command, cwd, ...(env ? { env } : {}), ...(everywhere.length ? { mcpServers } : {}) },
  });
  try {
    let auth;
    try {
      auth = await session.mcpAuthenticate(name);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (auth?.authUrl) openUrl(auth.authUrl);
    if (auth?.callbackExpected === false) return { opened: true };
    const deadline = now() + timeoutMs;
    while (!signal?.aborted && now() < deadline) {
      const status = (await session.mcpServerStatus()).find((item) => item.name === name);
      if (status?.status === "connected") return { ok: true };
      if (status?.status === "failed") return { ok: false, error: status.error ?? "Sign-in failed." };
      await sleep(pollMs);
    }
    return signal?.aborted ? { cancelled: true } : { ok: false, error: SIGN_IN_TIMEOUT };
  } finally {
    session.close?.();
  }
}
```

`codex.cjs` (export `signInCodex`):

```js
const SIGN_IN_TIMEOUT = "Sign-in timed out after 5 minutes. Try again.";

// One account's OAuth sign-in through the app-server: it returns the URL, runs the callback and token
// exchange, and announces the end with mcpServer/oauthLogin/completed.
async function signInCodex({ name, openUrl, signal, timeoutMs = 300_000, ...options }) {
  return withAppServer({ ...options, signal }, async (rpc) => {
    let finish;
    const done = new Promise((resolve) => (finish = resolve));
    const onNotification = ({ method, params }) => {
      if (method === "mcpServer/oauthLogin/completed" && params?.name === name)
        finish(params.success ? { ok: true } : { ok: false, error: params.error ?? "Sign-in failed." });
    };
    rpc.on("notification", onNotification);
    const timer = setTimeout(() => finish({ ok: false, error: SIGN_IN_TIMEOUT }), timeoutMs);
    const onAbort = () => finish({ cancelled: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const { authorizationUrl } = await rpc.request("mcpServer/oauth/login", { name, timeoutSecs: Math.round(timeoutMs / 1000) });
      if (authorizationUrl) openUrl(authorizationUrl);
      return await done;
    } catch (error) {
      return signal?.aborted ? { cancelled: true } : { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rpc.off?.("notification", onNotification);
    }
  });
}
```

Note: `withAppServer` closes the rpc on abort, which rejects the pending request; the `catch` maps that to `{ cancelled: true }`.

- [ ] **Step 4: Run, expect PASS**: `node --test packages/core/src/mcp/*.test.cjs`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp/claude.cjs packages/core/src/mcp/codex.cjs packages/core/src/mcp/claude.test.cjs packages/core/src/mcp/codex.test.cjs
git commit -m "feat(core): sign in to MCP servers through the Claude SDK and Codex app-server (#376)"
```

---

### Task 7: Checks report detail, Everywhere and shadowing

**Files:**
- Modify: `packages/core/src/mcp/claude.cjs` (`claudeServer`, `checkClaude`), `packages/core/src/mcp/codex.cjs` (`codexServer`)
- Test: same test files

**Interfaces:**
- Consumes: `toClaudeConfig` (Task 4).
- Produces:
  - `checkClaude({ …existing, everywhere = [] })`: Everywhere servers go into the idle session's `mcpServers`, and their reports have `scope: "everywhere"`.
  - Every report from both checkers has `detail`.
  - `claudeServer(status, { timedOut, everywhereNames })`.
  - `codexServer(status, configured)`: `detail` comes from `configured.url` or from `configured.command` plus its args.

- [ ] **Step 1: Failing tests** (append; and add `detail` to the expected objects in the two existing `claudeServer` deepEqual tests: `detail: null` for both since their configs have no url/command)

```js
test("claude reports carry detail and mark Everywhere servers", () => {
  assert.equal(claudeServer({ name: "l", status: "connected", scope: "user", config: { type: "http", url: "https://mcp.linear.app/mcp" } }).detail, "https://mcp.linear.app/mcp");
  assert.equal(claudeServer({ name: "p", status: "connected", scope: "user", config: { type: "stdio", command: "npx", args: ["-y", "x"] } }).detail, "npx -y x");
  assert.equal(claudeServer({ name: "pencil", status: "connected", scope: "dynamic", config: { type: "stdio", command: "p" } }, { everywhereNames: new Set(["pencil"]) }).scope, "everywhere");
});

test("checkClaude passes Everywhere servers to the idle session", async () => {
  let options;
  const loadSdk = async () => ({ query: (args) => ((options = args.options), { mcpServerStatus: async () => [], close() {} }) });
  await checkClaude({ command: "/c", cwd: "/", loadSdk, everywhere: [{ name: "pencil", type: "stdio", command: "p", args: [], env: {} }] });
  assert.deepEqual(options.mcpServers, { pencil: { type: "stdio", command: "p", args: [] } });
});
```

In `codex.test.cjs`:

```js
test("codex reports carry detail", () => {
  assert.equal(codexServer({ name: "l", tools: {} }, { url: "https://x" }).detail, "https://x");
  assert.equal(codexServer({ name: "p", tools: {} }, { command: "npx", args: ["y"] }).detail, "npx y");
  assert.equal(codexServer({ name: "q", tools: {} }, undefined).detail, null);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

In `claude.cjs`:

```js
function detailOfConfig(config) {
  if (!config) return null;
  if (typeof config.url === "string") return config.url;
  if (typeof config.command === "string") return [config.command, ...(Array.isArray(config.args) ? config.args : [])].join(" ");
  return null;
}

/** One SDK McpServerStatus as a report; null for an in-process SDK server, which the user never configured. */
function claudeServer(status, { timedOut = false, everywhereNames = new Set() } = {}) {
  if (status.config?.type === "sdk") return null;
  const pending = status.status === "pending";
  return {
    name: status.name,
    transport: transportOf(status.config?.type),
    scope: everywhereNames.has(status.name) ? "everywhere" : (SCOPES[status.scope] ?? "built-in"),
    state: pending && timedOut ? "failed" : (STATES[status.status] ?? "failed"),
    tools: Array.isArray(status.tools) ? status.tools.length : 0,
    error: pending && timedOut ? TIMEOUT_ERROR : (status.error ?? null),
    detail: detailOfConfig(status.config),
  };
}
```

In `checkClaude`, add `everywhere = []` to the parameters, build `mcpServers` the same way as `signInClaude`, pass `...(everywhere.length ? { mcpServers } : {})` in `options`, and map with `claudeServer(status, { timedOut, everywhereNames: new Set(everywhere.map((def) => def.name)) })`.

In `codex.cjs` `codexServer`, add `detail: configured?.url ?? (configured?.command ? [configured.command, ...(configured.args ?? [])].join(" ") : null)` to the returned object.

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp/
git commit -m "feat(core): MCP checks report detail and Everywhere servers (#376)"
```

---

### Task 8: `createMcp` gains writes, toggles, sign-in and `forSession`

**Files:**
- Modify: `packages/core/src/mcp/index.cjs`
- Test: `packages/core/src/mcp/index.test.cjs`

**Interfaces:**
- Consumes:
  - `createMcpStore` (Task 3)
  - from Task 4: `unmaskDefinition`, `maskDefinition`, `fromClaudeConfig`, `claudeConfigNames`, `codexConfigNames`, `detailOf`
  - writers (Task 5), sign-in runners (Task 6), checkers (Task 7)
- Produces:
  - `createMcp({ accounts, routing, cwd, clientVersion, store, openUrl, emit, home, checkers, writers, signers, timeoutMs })` returns these methods:
    - `accounts(): Promise<McpAccount[]>`. Antigravity accounts are now included.
    - `check(provider, accountId): Promise<McpAccountCheck>`
    - `definition(name, target): Promise<McpServerDefinition | null>`. Values come back masked.
    - `save(def, target, previous?: { name: string; target: McpTarget }): Promise<void>`
    - `saveUrl(def, target, previous?)`: like `save`, but throws `"Add command servers on the Mac."` when `def.type === "stdio"`.
    - `remove(name, target): Promise<void>`
    - `toggle(provider, accountId, name, on): Promise<void>`
    - `signIn(name, accounts: { provider, accountId }[]): Promise<{ started: true }>`. It resolves once the first account's URL has opened, or the first one has finished.
    - `cancelSignIn(name): void`
    - `forSession(provider, accountId): { servers: McpServerDefinition[]; off: string[] }`
  - `emit("mcp:changed", McpChangedEvent)` fires after save, remove, toggle and each account's sign-in result.
  - Config files for names: Claude's is `path.join(env.CLAUDE_CONFIG_DIR ?? home, ".claude.json")`; Codex's is `path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "config.toml")`. The `env` comes from `routing.forAccount`.

- [ ] **Step 1: Failing tests** (append to `index.test.cjs`; reuse its `snapshot`, `accounts`, `routing`, `report`)

```js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMcpStore } = require("./store.cjs");

function harness(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-mcp-index-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://figma", headers: { Authorization: "Bearer s" } } } }));
  const events = [];
  const calls = [];
  const store = createMcpStore(path.join(dir, "mcp.json"));
  const mcp = createMcp({
    accounts,
    routing: { forAccount: async (provider, accountId) => ({ command: `/bin/${provider}`, env: {}, accountId }) },
    cwd: "/",
    home: dir,
    store,
    emit: (channel, payload) => events.push([channel, payload]),
    openUrl: (url) => calls.push(["open", url]),
    writers: {
      claude: { add: async (o) => calls.push(["claude.add", o.def.name]), remove: async (o) => calls.push(["claude.remove", o.name]) },
      codex: { add: async (o) => calls.push(["codex.add", o.def.name]), remove: async (o) => calls.push(["codex.remove", o.name]), read: async () => null },
    },
    ...overrides,
  });
  return { mcp, store, events, calls, dir };
}
const linear = { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", headers: {} };

test("saving Everywhere writes the store and announces it", async (t) => {
  const { mcp, store, events } = harness(t);
  await mcp.save(linear, "everywhere");
  assert.deepEqual(store.read().everywhere, [linear]);
  assert.deepEqual(events, [["mcp:changed", { name: "linear" }]]);
});

test("saving to Claude or Codex calls the default account's writer", async (t) => {
  const { mcp, calls } = harness(t);
  await mcp.save(linear, "claude");
  await mcp.save(linear, "codex");
  assert.deepEqual(calls, [["claude.add", "linear"], ["codex.add", "linear"]]);
});

test("an edit removes the previous server first, and a masked header keeps its value", async (t) => {
  const { mcp, calls } = harness(t);
  const masked = await mcp.definition("figma", "claude");
  assert.deepEqual(masked.headers, { Authorization: "••••••" });
  let saved;
  const { mcp: editing } = harness(t, { writers: { claude: { add: async (o) => (saved = o.def), remove: async (o) => calls.push(["claude.remove", o.name]) }, codex: {} } });
  await editing.save({ ...masked, name: "figma2" }, "claude", { name: "figma", target: "claude" });
  assert.deepEqual(saved.headers, { Authorization: "Bearer s" });
  assert.deepEqual(calls.at(-1), ["claude.remove", "figma"]);
});

test("invalid servers and stdio over saveUrl are refused before any write", async (t) => {
  const { mcp, calls } = harness(t);
  await assert.rejects(mcp.save({ ...linear, name: "a b" }, "everywhere"), /letters, numbers/);
  await assert.rejects(mcp.saveUrl({ name: "p", type: "stdio", command: "p", args: [], env: {} }, "everywhere"), /Add command servers on the Mac/);
  assert.equal(calls.length, 0);
});

test("toggle writes the off list and check reports it", async (t) => {
  const { mcp } = harness(t, { checkers: { claude: async () => [report] } });
  await mcp.toggle("claude", "default", "pencil", false);
  assert.equal((await mcp.check("claude", "default")).servers[0].state, "disabled");
});

test("forSession skips Everywhere names the provider already has and returns the off list", async (t) => {
  const { mcp, store } = harness(t);
  store.setEverywhere([linear, { ...linear, name: "figma" }]);
  store.setOff("claude", "default", "pencil", true);
  assert.deepEqual(await mcp.forSession("claude", "default"), { servers: [linear], off: ["pencil"] });
});

test("check marks a provider's own server that shadows an Everywhere one", async (t) => {
  const { mcp, store } = harness(t, { checkers: { claude: async () => [{ ...report, name: "figma", transport: "url" }] } });
  store.setEverywhere([{ ...linear, name: "figma" }]);
  assert.equal((await mcp.check("claude", "default")).servers[0].shadowedBy, "claude");
});

test("antigravity lists Everywhere servers as unchecked or off", async (t) => {
  const { mcp, store } = harness(t);
  store.setEverywhere([linear]);
  assert.ok((await mcp.accounts()).some((account) => account.provider === "antigravity"));
  assert.deepEqual((await mcp.check("antigravity", "default")).servers, [
    { name: "linear", transport: "url", scope: "everywhere", state: "unchecked", tools: 0, error: null, detail: "https://mcp.linear.app/mcp" },
  ]);
  await mcp.toggle("antigravity", "default", "linear", false);
  assert.equal((await mcp.check("antigravity", "default")).servers[0].state, "disabled");
});

test("signIn runs each account in turn and announces each result", async (t) => {
  const order = [];
  const { mcp, events } = harness(t, {
    signers: {
      claude: async ({ name, openUrl }) => (order.push(`claude:${name}`), openUrl("https://a"), { ok: true }),
      codex: async () => (order.push("codex"), { ok: false, error: "denied" }),
    },
  });
  await mcp.signIn("linear", [{ provider: "claude", accountId: "default" }, { provider: "codex", accountId: "default" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["claude:linear", "codex"]);
  assert.deepEqual(events.map(([, payload]) => payload.signIn), ["done", "failed"]);
  assert.deepEqual(events.map(([, payload]) => payload.last), [false, true]);
  assert.equal(events[1][1].error, "denied");
});

test("cancelSignIn aborts the running account and skips the rest", async (t) => {
  let started = 0;
  const { mcp, events } = harness(t, {
    signers: { claude: ({ signal }) => (started++, new Promise((resolve) => signal.addEventListener("abort", () => resolve({ cancelled: true })))), codex: async () => (started++, { ok: true }) },
  });
  const running = mcp.signIn("linear", [{ provider: "claude", accountId: "default" }, { provider: "codex", accountId: "default" }]);
  mcp.cancelSignIn("linear");
  await running;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1);
  assert.equal(events.at(-1)[1].signIn, "cancelled");
});
```

- [ ] **Step 2: Run, expect FAIL**: `node --test packages/core/src/mcp/index.test.cjs`

- [ ] **Step 3: Implement** (replace `index.cjs`)

```js
const path = require("node:path");
const fs = require("node:fs");
const { checkClaude, addClaude, removeClaude, signInClaude } = require("./claude.cjs");
const { checkCodex, addCodex, removeCodex, readCodexDefinition, signInCodex } = require("./codex.cjs");
const { claudeConfigNames, codexConfigNames, detailOf, fromClaudeConfig, maskDefinition, unmaskDefinition } = require("./definitions.cjs");

// Settings › MCP: which accounts to check, one account's check (capped), and the edits: Everywhere servers and
// the off list in mcp.json, Claude and Codex user servers through their CLIs, and OAuth sign-in. Grouping for the
// screens lives in @milagre/shared/mcp; Chat start asks forSession for the extra servers and the off list.

const PROVIDERS = new Set(["claude", "codex", "antigravity"]);
// The caller waits longer than this cap (45 s): SLOW_METHODS in apps/daemon/src/client.cjs and MCP_CALLS in apps/mobile/src/client.ts.
const TIMEOUT_PROBLEM = "Timed out after 30 s. Check the servers in a terminal.";
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const URL_PATTERN = /^https?:\/\/\S+$/;

// The same rules as validateMcpServer in @milagre/shared/mcp; the runtime checks again because phones call it too.
function invalid(def) {
  if (!def || !NAME.test(String(def.name))) return "Use letters, numbers, - and _ only.";
  if (def.name === "milagre") return "milagre is Milagre’s own server. Pick another name.";
  if (def.type === "stdio") return String(def.command ?? "").trim() ? null : "Enter the command to run.";
  if (def.type !== "http" && def.type !== "sse") return "Pick URL or Command.";
  return URL_PATTERN.test(String(def.url)) ? null : "Enter an http or https URL.";
}

function createMcp({
  accounts,
  routing,
  cwd,
  clientVersion,
  store,
  openUrl = () => {},
  emit = () => {},
  home = require("node:os").homedir(),
  checkers = {},
  writers = {},
  signers = {},
  timeoutMs = 30_000,
}) {
  const run = { claude: checkers.claude ?? checkClaude, codex: checkers.codex ?? checkCodex };
  const write = {
    claude: { add: addClaude, remove: removeClaude, ...writers.claude },
    codex: { add: addCodex, remove: removeCodex, read: readCodexDefinition, ...writers.codex },
  };
  const sign = { claude: signers.claude ?? signInClaude, codex: signers.codex ?? signInCodex };
  const signIns = new Map(); // server name → AbortController

  async function listed() {
    // The cheap snapshot: it inspects nothing, so a first open never waits on identity checks.
    const snapshot = await accounts.snapshot();
    return snapshot.providers.filter((group) => PROVIDERS.has(group.provider)).flatMap((group) => group.accounts.map((account) => ({ group, account })));
  }

  async function list() {
    return (await listed()).map(({ group, account }) => ({ provider: group.provider, accountId: account.id, label: account.email || account.label }));
  }

  function configNames(provider, env = {}) {
    if (provider === "claude") return claudeConfigNames(path.join(env.CLAUDE_CONFIG_DIR ?? home, ".claude.json"));
    if (provider === "codex") return codexConfigNames(path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "config.toml"));
    return new Set();
  }

  function forSessionWith(provider, accountId, env) {
    const own = configNames(provider, env);
    return { servers: store.read().everywhere.filter((def) => !own.has(def.name)), off: store.offFor(provider, accountId) };
  }

  async function check(provider, accountId) {
    const controller = new AbortController();
    let timer;
    const cap = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(TIMEOUT_PROBLEM);
      }, timeoutMs);
    });
    let base = { provider, accountId, label: accountId };
    const answer = (problem, servers = []) => ({ ...base, problem, servers });
    const work = async () => {
      const found = (await listed()).find(({ group, account }) => group.provider === provider && account.id === accountId);
      if (!found) return answer("Account not found. Refresh and try again.");
      base = { provider, accountId, label: found.account.email || found.account.label };
      if (found.account.state === "signed-out") return answer("Not signed in. Sign in from Accounts.");
      const off = new Set(store.offFor(provider, accountId));
      const everywhere = store.read().everywhere;
      if (provider === "antigravity")
        return answer(
          null,
          everywhere.map((def) => ({ name: def.name, transport: def.type === "stdio" ? "command" : "url", scope: "everywhere", state: off.has(def.name) ? "disabled" : "unchecked", tools: 0, error: null, detail: detailOf(def) })),
        );
      const cli = await routing.forAccount(provider, accountId);
      if (cli.problem || !cli.command) return answer(cli.problem || "Install the provider CLI first.");
      const session = forSessionWith(provider, accountId, cli.env);
      const shadowed = new Set(everywhere.map((def) => def.name).filter((name) => !session.servers.some((def) => def.name === name)));
      const servers = await run[provider]({
        command: cli.command,
        env: cli.env,
        cwd,
        clientVersion,
        signal: controller.signal,
        timeoutMs: Math.max(0, timeoutMs - 5000),
        everywhere: provider === "claude" ? session.servers : [],
      });
      const reports = servers.map((server) => ({
        ...server,
        ...(off.has(server.name) ? { state: "disabled" } : {}),
        ...(shadowed.has(server.name) && server.scope === "user" ? { shadowedBy: provider } : {}),
      }));
      // Codex can't see Everywhere servers outside its config without a thread; they load at Chat start.
      if (provider === "codex")
        for (const def of session.servers)
          if (!reports.some((server) => server.name === def.name))
            reports.push({ name: def.name, transport: def.type === "stdio" ? "command" : "url", scope: "everywhere", state: off.has(def.name) ? "disabled" : "unchecked", tools: 0, error: null, detail: detailOf(def) });
      return answer(null, reports);
    };
    try {
      const result = await Promise.race([work(), cap]);
      return result === TIMEOUT_PROBLEM ? answer(TIMEOUT_PROBLEM) : result;
    } catch (error) {
      return answer(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  async function storedDefinition(name, target) {
    if (target === "everywhere") return store.read().everywhere.find((def) => def.name === name) ?? null;
    const cli = await routing.forAccount(target, "default");
    if (target === "claude") {
      try {
        const file = path.join(cli.env?.CLAUDE_CONFIG_DIR ?? home, ".claude.json");
        return fromClaudeConfig(name, JSON.parse(fs.readFileSync(file, "utf8")).mcpServers?.[name]);
      } catch {
        return null;
      }
    }
    return write.codex.read({ command: cli.command, env: cli.env, cwd, name, clientVersion });
  }

  async function definition(name, target) {
    const def = await storedDefinition(name, target);
    return def ? maskDefinition(def) : null;
  }

  async function removeFrom(name, target) {
    if (target === "everywhere") return store.setEverywhere(store.read().everywhere.filter((def) => def.name !== name));
    const cli = await routing.forAccount(target, "default");
    await write[target].remove({ command: cli.command, env: cli.env, name });
  }

  async function save(def, target, previous) {
    const problem = invalid(def);
    if (problem) throw new Error(problem);
    const stored = previous ? await storedDefinition(previous.name, previous.target) : null;
    const full = unmaskDefinition(def, stored);
    if (previous) await removeFrom(previous.name, previous.target);
    if (target === "everywhere") store.setEverywhere([...store.read().everywhere.filter((item) => item.name !== full.name), full]);
    else {
      const cli = await routing.forAccount(target, "default");
      await write[target].add({ command: cli.command, env: cli.env, cwd, clientVersion, def: full });
    }
    emit("mcp:changed", { name: full.name });
  }

  async function saveUrl(def, target, previous) {
    if (def?.type === "stdio") throw new Error("Add command servers on the Mac.");
    return save(def, target, previous);
  }

  async function remove(name, target) {
    await removeFrom(name, target);
    emit("mcp:changed", { name });
  }

  async function toggle(provider, accountId, name, on) {
    store.setOff(provider, accountId, name, !on);
    emit("mcp:changed", { name, provider, accountId });
  }

  // One account at a time, so each browser tab belongs to one sign-in. Resolves once the first account has
  // opened its URL (or finished); the rest runs on and reports through mcp:changed.
  async function signIn(name, targets) {
    signIns.get(name)?.abort();
    const controller = new AbortController();
    signIns.set(name, controller);
    let firstOpened;
    const opened = new Promise((resolve) => (firstOpened = resolve));
    const all = (async () => {
      for (const [index, { provider, accountId }] of targets.entries()) {
        if (controller.signal.aborted) break;
        if (!sign[provider]) continue;
        const cli = await routing.forAccount(provider, accountId);
        const result = await sign[provider]({
          command: cli.command,
          env: cli.env,
          cwd,
          clientVersion,
          name,
          everywhere: provider === "claude" ? forSessionWith(provider, accountId, cli.env).servers : [],
          signal: controller.signal,
          openUrl: (url) => {
            openUrl(url);
            firstOpened();
          },
        }).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
        firstOpened();
        const signInState = result.cancelled ? "cancelled" : result.ok || result.opened ? "done" : "failed";
        emit("mcp:changed", { name, provider, accountId, signIn: signInState, error: result.error ?? null, last: result.cancelled || index === targets.length - 1 });
        if (result.cancelled) break;
      }
      if (signIns.get(name) === controller) signIns.delete(name);
      firstOpened();
    })();
    await Promise.race([opened, all]);
    return { started: true };
  }

  function cancelSignIn(name) {
    signIns.get(name)?.abort();
  }

  async function forSession(provider, accountId) {
    const cli = provider === "antigravity" ? { env: {} } : await routing.forAccount(provider, accountId);
    return forSessionWith(provider, accountId, cli.env);
  }

  return { accounts: list, check, definition, save, saveUrl, remove, toggle, signIn, cancelSignIn, forSession };
}

module.exports = { createMcp };
```

`forSession` is async because `routing.forAccount` is. Also update the existing first test ("accounts lists Claude and Codex accounts, not Antigravity"): it now expects the Antigravity account too; rename it to "accounts lists Claude, Codex and Antigravity accounts" and add `{ provider: "antigravity", accountId: "default", label: "Default account" }`.

- [ ] **Step 4: Run, expect PASS**: `node --test packages/core/src/mcp/*.test.cjs`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp/index.cjs packages/core/src/mcp/index.test.cjs
git commit -m "feat(core): save, remove, toggle and sign in to MCP servers (#376)"
```

---

### Task 9: Chat start applies Everywhere servers and the off list

**Files:**
- Modify: `packages/core/src/agents/session-manager.cjs` (`createSession` call, ~line 104)
- Modify: `packages/core/src/agents/claude-provider.cjs` (constructor ~88, `sdk.query` options ~281-306, `readMessages` init ~399)
- Modify: `packages/core/src/agents/codex-provider.cjs` (constructor ~133, config ~318-326)
- Modify: `packages/core/src/agents/acp-session.cjs` (constructor ~104, ~322)
- Modify: `packages/core/src/runtime.cjs` (`createSession` closure ~887)
- Test: `packages/core/src/agents/claude-provider.test.cjs`, `codex-provider.test.cjs`, `acp-session.test.cjs`, `session-manager.test.cjs`

**Interfaces:**
- Consumes:
  - `mcp.forSession(provider, accountId)` (Task 8)
  - `toClaudeConfig`, `toCodexConfig`, `toAcpServer` (Task 4)
- Produces:
  - Every provider session constructor accepts `mcpExtras = null`. It is an `async () => ({ servers: McpServerDefinition[]; off: string[] })`.
  - SessionManager passes `accountId` in `createSession` options.

- [ ] **Step 1: Failing tests**

`session-manager.test.cjs`: find the existing test that records `createSession` options (search `createSession:` in the file) and add, in a new test using the same helper:

```js
test("createSession receives the turn's accountId", async () => {
  let seen;
  const manager = new SessionManager({ createSession: (provider, options) => ((seen = options), fakeSession()), send() {} });
  await manager.startTurn({ chatId: "c", provider: "claude", cwd: "/", accountId: "work", prompt: "hi" });
  assert.equal(seen.accountId, "work");
});
```

(`fakeSession` is the file's existing stub factory; if it has another name, use that.)

`claude-provider.test.cjs`, using the file's existing fake SDK pattern (search `loadSdk:`):

```js
test("Everywhere servers join mcpServers and off servers are toggled after init", async () => {
  const toggled = [];
  let options;
  const session = new ClaudeSession({
    cwd: "/", command: "/c", emit() {},
    mcpExtras: async () => ({ servers: [{ name: "linear", type: "http", url: "https://x", headers: {} }], off: ["figma"] }),
    loadSdk: async () => ({ query: (args) => ((options = args.options), fakeQuery({ onToggle: (name, on) => toggled.push([name, on]), messages: [{ type: "system", subtype: "init" }] })) }),
  });
  await session.startTurn({ prompt: "hi" });
  assert.deepEqual(options.mcpServers.linear, { type: "http", url: "https://x" });
  assert.deepEqual(toggled, [["figma", false]]);
});
```

(`fakeQuery` here is the file's existing fake; add a `toggleMcpServer: async (name, on) => onToggle?.(name, on)` method to it.)

`codex-provider.test.cjs`, using the file's fake app-server (search `thread/start`):

```js
test("Everywhere servers and the off list reach thread config", async () => {
  const { session, requests } = startFakeCodex({ mcpExtras: async () => ({ servers: [{ name: "linear", type: "http", url: "https://x", headers: {} }], off: ["figma"] }) });
  await session.startTurn({ prompt: "hi" });
  const config = requests.find((r) => r.method === "thread/start").params.config;
  assert.deepEqual(config.mcp_servers.linear, { url: "https://x" });
  assert.deepEqual(config.mcp_servers.figma, { enabled: false });
});
```

`acp-session.test.cjs`:

```js
test("Everywhere servers that aren't off reach session/new", async () => {
  const { session, requests } = startFakeAcp({ mcpExtras: async () => ({ servers: [{ name: "linear", type: "http", url: "https://x", headers: {} }, { name: "figma", type: "http", url: "https://f", headers: {} }], off: ["figma"] }) });
  await session.startTurn({ prompt: "hi" });
  assert.deepEqual(requests.find((r) => r.method === "session/new").params.mcpServers.map((s) => s.name), ["linear"]);
});
```

Where a test file has no `startFakeCodex` / `startFakeAcp` helper, copy the setup from the nearest existing test that asserts on `thread/start` or `session/new` params and add the `mcpExtras` option to it.

- [ ] **Step 2: Run, expect FAIL**: `node --test packages/core/src/agents/session-manager.test.cjs packages/core/src/agents/claude-provider.test.cjs packages/core/src/agents/codex-provider.test.cjs packages/core/src/agents/acp-session.test.cjs`

- [ ] **Step 3: Implement**

`session-manager.cjs`, in the `this.createSession(provider, { … })` object, add after `designsEnabled,`:

```js
      accountId,
```

`claude-provider.cjs`:
- Add `mcpExtras = null,` to the constructor's destructuring and to the `Object.assign(this, { … })` list.
- At the top add `const { toClaudeConfig } = require("../mcp/definitions.cjs");`.
- Before `this.query = sdk.query({`, add:

```js
    // Settings › MCP: Everywhere servers join the Chat's servers; off servers are switched off once Claude Code has started.
    const extras = this.mcpExtras ? await this.mcpExtras().catch(() => null) : null;
    this.mcpOff = extras?.off ?? [];
    const linked = this.linked?.tools.length ? linkedOptions(this.linked.tools, sdk) : {};
    const extraServers = Object.fromEntries((extras?.servers ?? []).map((def) => [def.name, toClaudeConfig(def)]));
```

- Replace `...(this.linked?.tools.length ? linkedOptions(this.linked.tools, sdk) : {}),` with:

```js
        ...linked,
        ...(Object.keys(extraServers).length ? { mcpServers: { ...extraServers, ...linked.mcpServers } } : {}),
```

- In `readMessages`, right after the existing `init` line, add:

```js
        if (message.type === "system" && message.subtype === "init" && this.mcpOff.length) {
          const off = this.mcpOff;
          this.mcpOff = [];
          for (const name of off) this.query.toggleMcpServer?.(name, false).catch(() => {});
        }
```

  If the method that builds `sdk.query` isn't `async`, make it `async` and check every caller that relies on `this.query` existing right after it returns. Await it there, or move the `extras` read into `startTurn` before that call.

`codex-provider.cjs`:
- Add `mcpExtras = null` to the constructor's destructuring and assign it.
- Add `const { toCodexConfig } = require("../mcp/definitions.cjs");`.
- Replace the `const config = …` block with:

```js
    const extras = !this.analysisOnly && this.mcpExtras ? await this.mcpExtras().catch(() => null) : null;
    const extraServers = {
      ...Object.fromEntries((extras?.servers ?? []).map((def) => [def.name, toCodexConfig(def)])),
      // Merged into the user's own definition by Codex (Task 1, probe step 4).
      ...Object.fromEntries((extras?.off ?? []).map((name) => [name, { enabled: false }])),
    };
    const servers = { ...extraServers, ...(url ? { milagre: { url, tool_timeout_sec: 86400 } } : {}) };
    const config = this.analysisOnly ? advisorCodexConfig(inherited, url) : Object.keys(servers).length ? { ...THREAD_CONFIG, mcp_servers: servers } : THREAD_CONFIG;
```

  If Task 1 step 4 found that thread config replaces rather than merges, change the off entries to the full definition plus `enabled: false`. To do that, read the definitions with `fromCodexConfig` from `inherited ?? (await rpc.request("config/read", { cwd: this.cwd })).config`, and record the change in the commit message.

`acp-session.cjs`:
- Add `mcpExtras = null` to the constructor and assign it.
- Add `const { toAcpServer } = require("../mcp/definitions.cjs");`.
- Replace the `mcpServers` line with:

```js
    const extras = this.mcpExtras ? await this.mcpExtras().catch(() => null) : null;
    const off = new Set(extras?.off ?? []);
    const mcpServers = [
      ...(url ? [{ type: "http", name: "milagre", url, headers: [] }] : []),
      ...(extras?.servers ?? []).filter((def) => !off.has(def.name)).map(toAcpServer),
    ];
```

`runtime.cjs`: replace the default `createSession` arrow with:

```js
      ((provider, options) => {
        // Settings › MCP: Everywhere servers and the off list for this provider account (mcp is created further down).
        const withMcp = { ...options, mcpExtras: () => mcp.forSession(provider, options.accountId ?? "default") };
        return provider === "codex"
          ? new CodexSession({ ...withMcp, clientVersion: version })
          : provider === "antigravity"
            ? new AcpSession({ ...withMcp, clientVersion: version, config: antigravityAcp })
            : new ClaudeSession(withMcp);
      }),
```

- [ ] **Step 4: Run, expect PASS**, then the whole core suite: `npm test -w packages/core` (or `node --test packages/core/src/*.test.cjs packages/core/src/agents/*.test.cjs`).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/agents/ packages/core/src/runtime.cjs
git commit -m "feat(core): Chats load Everywhere MCP servers and skip servers switched off (#376)"
```

---

### Task 10: Added accounts drop servers removed from the source (#375 fix)

**Files:**
- Modify: `packages/core/src/account-mcp.cjs`
- Test: `packages/core/src/account-mcp.test.cjs`

**Interfaces:**
- Produces: `inheritMcp` behaves as before, plus it records the names it copied in `<targetDir>/milagre-inherited-mcp.json` (`{ "names": [...] }`, mode 0600). A recorded name that has left the source is removed from the target. Names the target added itself are never touched.

- [ ] **Step 1: Failing tests** (follow the file's `folder(t)` helper)

```js
test("a Claude server removed from the source leaves the added account", (t) => {
  const dir = folder(t);
  const source = path.join(dir, "source.json");
  const targetDir = path.join(dir, "account");
  fs.mkdirSync(targetDir);
  const target = path.join(targetDir, ".claude.json");
  fs.writeFileSync(source, JSON.stringify({ mcpServers: { a: { command: "a" }, b: { command: "b" } } }));
  fs.writeFileSync(target, JSON.stringify({ mcpServers: { own: { command: "own" } } }));
  inheritClaudeMcp(source, target);
  fs.writeFileSync(source, JSON.stringify({ mcpServers: { a: { command: "a" } } }));
  inheritClaudeMcp(source, target);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(target, "utf8")).mcpServers).sort(), ["a", "own"]);
});

test("a Codex server removed from the source leaves the added account", (t) => {
  const dir = folder(t);
  const source = path.join(dir, "source.toml");
  const targetDir = path.join(dir, "account");
  fs.mkdirSync(targetDir);
  const target = path.join(targetDir, "config.toml");
  fs.writeFileSync(source, '[mcp_servers.a]\ncommand = "a"\n\n[mcp_servers.b]\ncommand = "b"\n');
  fs.writeFileSync(target, '[mcp_servers.own]\ncommand = "own"\n');
  inheritCodexMcp(source, target);
  fs.writeFileSync(source, '[mcp_servers.a]\ncommand = "a"\n');
  inheritCodexMcp(source, target);
  const text = fs.readFileSync(target, "utf8");
  assert.match(text, /\[mcp_servers\.a\]/);
  assert.match(text, /\[mcp_servers\.own\]/);
  assert.doesNotMatch(text, /\[mcp_servers\.b\]/);
});
```

- [ ] **Step 2: Run, expect FAIL**: `node --test packages/core/src/account-mcp.test.cjs`

- [ ] **Step 3: Implement.** In `account-mcp.cjs`:

```js
// The names copied last time, beside the target config, so a server removed from the source can be removed again
// without touching servers the account added itself.
const recordFile = (targetFile) => path.join(path.dirname(targetFile), "milagre-inherited-mcp.json");
function readRecorded(targetFile) {
  try {
    const names = JSON.parse(fs.readFileSync(recordFile(targetFile), "utf8")).names;
    return new Set(Array.isArray(names) ? names : []);
  } catch {
    return new Set();
  }
}
function writeRecorded(targetFile, names) {
  const file = recordFile(targetFile);
  writeIfChanged(file, readText(file), `${JSON.stringify({ names: [...names].sort() })}\n`);
}
```

In `inheritClaudeMcp`, before merging:

```js
  const sourceNames = new Set(isObject(source.mcpServers) ? Object.keys(source.mcpServers) : []);
  if (isObject(target.mcpServers)) for (const name of readRecorded(targetFile)) if (!sourceNames.has(name)) delete target.mcpServers[name];
```

After the write, call `writeRecorded(targetFile, sourceNames)`. In `inheritCodexMcp`:
1. Compute the source's section names with the regex the file already uses for sections.
2. For each recorded name missing from the source, remove its `[mcp_servers.<name>]` section and its `[mcp_servers.<name>.*]` sub-tables from the target text, using the same section-splitting helper the merge uses.
3. Write, then call `writeRecorded`.

- [ ] **Step 4: Run, expect PASS** (including the three existing tests in that file).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/account-mcp.cjs packages/core/src/account-mcp.test.cjs
git commit -m "fix(accounts): drop inherited MCP servers once they leave the source (#376)"
```

---

### Task 11: Runtime commands, gates and the phone signal

**Files:**
- Modify: `packages/core/src/runtime.cjs` (~1057-1059)
- Modify: `apps/daemon/src/mobile-bridge.cjs` (METHODS ~116; event signals ~556-575; signal types ~512-516)
- Modify: `apps/daemon/src/peer-policy.cjs` (DENIED ~5)
- Modify: `apps/daemon/src/client.cjs` (SLOW_METHODS ~24)
- Modify: `apps/daemon/src/confine.test.cjs` (~721)
- Modify: `apps/desktop/electron/computer-routing.cjs` (LOCAL_ONLY ~6-23) and the copy in `apps/desktop/electron/preload.cjs` (~8)
- Modify: `apps/desktop/electron/preload.cjs` (`mcp:` bridge ~151)
- Modify: `apps/desktop/app/src/electron.d.ts` (~276)
- Modify: `apps/mobile/src/client.ts` (MCP_CALLS ~72), `apps/mobile/src/live.ts` (~2-5)
- Test: `apps/daemon/src/mobile-bridge.test.cjs` (or the file asserting METHODS), `apps/daemon/src/peer-policy.test.cjs`, `apps/desktop/electron/computer-routing.test.cjs`, `confine.test.cjs`

**Interfaces:**
- Consumes: `createMcp` (Task 8).
- Produces these runtime commands, with argument order fixed:
  - `mcp:definition(name, target)`
  - `mcp:save(def, target, previous?)`
  - `mcp:saveUrl(def, target, previous?)`
  - `mcp:remove(name, target)`
  - `mcp:toggle(provider, accountId, name, on)`
  - `mcp:signIn(name, accounts)`
  - `mcp:cancelSignIn(name)`
- Produces the runtime event `mcp:changed` (`McpChangedEvent`) and the phone live signal `"mcp"`.
- Produces the desktop bridge:

```ts
mcp: {
  accounts: () => Promise<McpAccount[]>;
  check: (provider: McpProvider, accountId: string) => Promise<McpAccountCheck>;
  definition: (name: string, target: McpTarget) => Promise<McpServerDefinition | null>;
  save: (def: McpServerDefinition, target: McpTarget, previous?: { name: string; target: McpTarget }) => Promise<void>;
  saveUrl: (def: McpServerDefinition, target: McpTarget, previous?: { name: string; target: McpTarget }) => Promise<void>;
  remove: (name: string, target: McpTarget) => Promise<void>;
  toggle: (provider: McpProvider, accountId: string, name: string, on: boolean) => Promise<void>;
  signIn: (name: string, accounts: { provider: McpProvider; accountId: string }[]) => Promise<{ started: true }>;
  cancelSignIn: (name: string) => Promise<void>;
  onChanged: (callback: (event: McpChangedEvent) => void) => () => void;
};
```

- [ ] **Step 1: Failing tests**

In `confine.test.cjs`, beside the existing `mcp:check` refusal (~721), loop over the new methods:

```js
for (const method of ["mcp:definition", "mcp:save", "mcp:saveUrl", "mcp:remove", "mcp:toggle", "mcp:signIn", "mcp:cancelSignIn"]) {
  test(`${method} is refused on the demo computer`, async () => {
    // same body as the existing mcp:check refusal test, with `method`
  });
}
```

Copy the existing test's body verbatim into the loop. Don't leave the comment in.

In the mobile-bridge test that lists allowed methods (search `"mcp:check"` under `apps/daemon/src/*.test.cjs`), assert:

```js
for (const method of ["mcp:definition", "mcp:saveUrl", "mcp:remove", "mcp:toggle"]) assert.ok(METHODS.has(method), method);
for (const method of ["mcp:save", "mcp:signIn", "mcp:cancelSignIn"]) assert.ok(!METHODS.has(method), method);
```

If METHODS isn't exported, export it from `mobile-bridge.cjs` as `module.exports.METHODS = METHODS` in the same change.

In `peer-policy.test.cjs`:

```js
test("paired Macs can't add command servers or start MCP sign-in", () => {
  for (const method of ["mcp:save", "mcp:signIn", "mcp:cancelSignIn"]) assert.equal(peerPolicy.denies(method), true, method);
  for (const method of ["mcp:saveUrl", "mcp:toggle", "mcp:remove", "mcp:definition"]) assert.equal(peerPolicy.denies(method), false, method);
});
```

In `computer-routing.test.cjs`: `for (const name of ["mcp:save", "mcp:signIn", "mcp:cancelSignIn"]) assert.equal(isLocalOnly(name), true);`. The existing copy-equality test already covers preload.

- [ ] **Step 2: Run, expect FAIL**: `node --test apps/daemon/src/*.test.cjs apps/desktop/electron/computer-routing.test.cjs`

- [ ] **Step 3: Implement**

`runtime.cjs` (replace lines 1057-1059):

```js
  const mcp = createMcp({
    accounts,
    routing,
    cwd: require("node:os").homedir(),
    clientVersion: version,
    store: createMcpStore(path.join(dataDir, "mcp.json")),
    openUrl: (url) => openInBrowser(url),
    emit,
  });
  commands.handle("mcp:accounts", () => mcp.accounts());
  commands.handle("mcp:check", (_event, provider, accountId) => mcp.check(String(provider), String(accountId)));
  commands.handle("mcp:definition", (_event, name, target) => mcp.definition(String(name), String(target)));
  commands.handle("mcp:save", (_event, def, target, previous) => mcp.save(def, String(target), previous ?? undefined));
  commands.handle("mcp:saveUrl", (_event, def, target, previous) => mcp.saveUrl(def, String(target), previous ?? undefined));
  commands.handle("mcp:remove", (_event, name, target) => mcp.remove(String(name), String(target)));
  commands.handle("mcp:toggle", (_event, provider, accountId, name, on) => mcp.toggle(String(provider), String(accountId), String(name), on === true));
  commands.handle("mcp:signIn", (_event, name, targets) => mcp.signIn(String(name), Array.isArray(targets) ? targets : []));
  commands.handle("mcp:cancelSignIn", (_event, name) => mcp.cancelSignIn(String(name)));
```

Add the requires at the top: `const { createMcpStore } = require("./mcp/store.cjs");` and `const { openInBrowser } = require("./antigravity-account.cjs");`. Use whatever `require("node:path")` binding the file already has.

`mobile-bridge.cjs`:
- METHODS: add `"mcp:definition", "mcp:saveUrl", "mcp:remove", "mcp:toggle"` beside `"mcp:check"`.
- Event handler: add `if (channel === "mcp:changed" && !confine) signal(entry, "mcp", 0);`.
- Add `"mcp"` to the signal types list.

`peer-policy.cjs`: add `"mcp:save", "mcp:signIn", "mcp:cancelSignIn"` to `DENIED`.

`client.cjs`: `SLOW_METHODS` gets `"mcp:save": 45000, "mcp:saveUrl": 45000, "mcp:remove": 45000, "mcp:signIn": 45000, "mcp:definition": 45000`.

`computer-routing.cjs` LOCAL_ONLY and its copy in `preload.cjs`: add `"mcp:save", "mcp:signIn", "mcp:cancelSignIn"`.

`preload.cjs` bridge (replace `mcp:` block):

```js
    mcp: {
      accounts: () => invoke("mcp:accounts"),
      check: (provider, accountId) => invoke("mcp:check", provider, accountId),
      definition: (name, target) => invoke("mcp:definition", name, target),
      save: (def, target, previous) => invoke("mcp:save", def, target, previous ?? null),
      saveUrl: (def, target, previous) => invoke("mcp:saveUrl", def, target, previous ?? null),
      remove: (name, target) => invoke("mcp:remove", name, target),
      toggle: (provider, accountId, name, on) => invoke("mcp:toggle", provider, accountId, name, on),
      signIn: (name, accounts) => invoke("mcp:signIn", name, accounts),
      cancelSignIn: (name) => invoke("mcp:cancelSignIn", name),
      onChanged: (callback) => listen("mcp:changed", callback),
    },
```

`electron.d.ts`: replace the `mcp` member with the interface above and import `McpProvider, McpTarget, McpServerDefinition, McpChangedEvent` from `@milagre/shared/mcp`.

`apps/mobile/src/client.ts`: `MCP_CALLS` gets `"mcp:definition", "mcp:saveUrl", "mcp:remove", "mcp:toggle"`.

`apps/mobile/src/live.ts`: add `"mcp"` to `LiveSignal` and to its validator.

- [ ] **Step 4: Run, expect PASS**, plus `npm run typecheck` (only the two screens may still fail; Tasks 12 and 13 fix them).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime.cjs apps/daemon apps/desktop/electron apps/desktop/app/src/electron.d.ts apps/mobile/src/client.ts apps/mobile/src/live.ts
git commit -m "feat: MCP save, toggle and sign-in commands with remote gates (#376)"
```

---

### Task 12: Desktop page redesign

**Files:**
- Create: `apps/desktop/app/src/components/primitives/Switch.tsx` (move `Switch` out of `Settings.tsx:402-418`; `Settings.tsx` imports it)
- Create: `apps/desktop/app/src/components/McpServerRow.tsx`
- Create: `apps/desktop/app/src/components/McpServerSheet.tsx`
- Modify: `apps/desktop/app/src/components/McpSettings.tsx`
- Modify: `apps/desktop/app/src/components/Settings.tsx` (import Switch; pass `remote` to `McpSettings` on the computer page ~347)
- Test: `scripts/test-mcp-settings.cjs`

**Interfaces:**
- Consumes:
  - bridge `mcp` (Task 11)
  - from `@milagre/shared/mcp`: `groupMcpRows`, `mcpSummary`, `mcpTransportLine`, `mcpChipLine`, `validateMcpServer`, `MCP_SECRET_MASK`
- Produces:
  - `McpSettings({ bridge?, remote? })`. With `remote` set, the page shows no Sign in (it reads "On the Mac"), and the sheet only offers URL.
  - `data-mcp-*` attributes the check uses:
    - rows: `data-mcp-row={name}` with `data-open`
    - attention rows: `data-mcp-attention={name}`
    - the account switch: `data-mcp-switch="<provider>:<accountId>:<name>"`
    - buttons: `data-mcp-sign-in={name}` and `data-mcp-cancel={name}`
    - the projects expander: `data-mcp-other`
    - the sheet: `data-mcp-sheet`
    - the add button: `data-mcp-add`

- [ ] **Step 1: Update the Electron check first (failing)**

In `scripts/test-mcp-settings.cjs`:

1. Replace the fixture's `answers` with reports that carry `detail`, for example `{ name: 'linear', transport: 'url', scope: 'user', state: 'needs-sign-in', tools: 0, error: null, detail: 'https://mcp.linear.app/mcp' }`. Cover:
   - `pencil`: user, connected, command
   - `linear`: needs sign-in, url
   - `argent`: failed with error `spawn argent ENOENT`
   - `claude.ai Gmail`: connector, claude.ai scope
   - `plugin:engineering:notion`: plugin, needs-sign-in
2. Extend `window.milagre.mcp` with recording stubs:

```js
    definition: async (name) => ({ name, type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: '••••••' } }),
    save: async (...args) => { window.saved = args; },
    saveUrl: async (...args) => { window.saved = args; },
    remove: async (...args) => { window.removed = args; },
    toggle: async (...args) => { window.toggled = args; },
    signIn: async (...args) => { window.signedIn = args; return { started: true }; },
    cancelSignIn: async (name) => { window.cancelled = name; },
    onChanged: (callback) => { window.mcpChanged = callback; return () => {}; },
```

3. Replace the assertions with these, keeping the file's `waitFor` / `evaluate` / `shot` helpers:
   - After release, `[data-mcp-attention="linear"]` exists and `[data-mcp-row="linear"]` does not.
   - `[data-mcp-row="pencil"]` exists; clicking it sets `data-open="true"`, and `[data-mcp-switch="claude:default:pencil"]` is visible.
   - Clicking that switch sets `window.toggled` to `['claude','default','pencil',false]`.
   - `[data-mcp-row="argent"]` contains the text `2 of 3 connected` or a `[data-mcp-failed]` icon.
   - Clicking `[data-mcp-sign-in="linear"]` sets `window.signedIn[0] === 'linear'`, and the row shows `Finish in your browser, then come back.`. Calling `window.mcpChanged({ name: 'linear', provider: 'claude', accountId: 'default', signIn: 'done', last: true })` brings the Sign in button back.
   - Clicking `[data-mcp-other]` shows `Plugin · engineering` and `claude.ai connectors` inline, with no page change.
   - Clicking `[data-mcp-add]` opens `[data-mcp-sheet]` with Everywhere selected. Type name `docs` and URL `https://docs.example/mcp`, submit, and `window.saved` equals `[{ name: 'docs', type: 'http', url: 'https://docs.example/mcp', headers: {} }, 'everywhere', undefined]`.
   - Typing name `a b` shows `Use letters, numbers, - and _ only.` and doesn't call save.
   - Shots: `mcp-page.png` (light and dark), `mcp-open-row.png`, `mcp-sheet.png`, `mcp-other.png`.

Run: `npm test -- --only test-mcp-settings`. Expected: FAIL (old page).

- [ ] **Step 2: Move the Switch**

Create `primitives/Switch.tsx` exporting the exact `Switch` from `Settings.tsx:402-418` (unchanged markup: `bg-ink` when on, `bg-line-strong` off). In `Settings.tsx` delete the local function and `import { Switch } from "./primitives/Switch";`.

- [ ] **Step 3: Write `McpServerRow.tsx`**

```tsx
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowUp01Icon, Alert02Icon, CommandLineIcon, Globe02Icon, FolderGitIcon } from "@hugeicons/core-free-icons";
import { mcpChipLine, mcpSummary, mcpTransportLine, type McpChip, type McpRow } from "@milagre/shared/mcp";
import { providerName } from "@milagre/shared/providers";
import { Switch } from "./primitives/Switch";

const keyOf = (chip: Pick<McpChip, "provider" | "accountId">) => `${chip.provider}:${chip.accountId}`;
export const outlineButton =
  "rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-hover disabled:opacity-40";
export const solidButton = "rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-semibold text-surface transition-opacity hover:opacity-90 disabled:opacity-40";

function Tile({ row, warn = false }: { row: McpRow; warn?: boolean }) {
  const icon = row.transport === "command" ? CommandLineIcon : Globe02Icon;
  return (
    <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${warn ? "bg-orange-tint text-orange" : "bg-hover text-ink-2"}`}>
      <HugeiconsIcon icon={icon} size={16} strokeWidth={1.75} color="currentColor" />
    </span>
  );
}

/** A row in Needs sign-in: Sign in, or Cancel while the browser is open. */
export function McpSignInRow({ row, signingIn, remote, onSignIn, onCancel }: { row: McpRow; signingIn: boolean; remote: boolean; onSignIn: () => void; onCancel: () => void }) {
  return (
    <div data-mcp-attention={row.name} className="flex min-h-15 items-center gap-3 px-4 py-3">
      <Tile row={row} warn />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-[13.5px] font-semibold text-ink">{row.name}</span>
        <span className="truncate text-[12px] text-ink-3">{signingIn ? "Finish in your browser, then come back." : mcpTransportLine(row)}</span>
      </div>
      {remote ? (
        <span className="text-[12px] text-ink-3">On the Mac</span>
      ) : signingIn ? (
        <button type="button" data-mcp-cancel={row.name} className={outlineButton} onClick={onCancel}>
          Cancel
        </button>
      ) : (
        <button type="button" data-mcp-sign-in={row.name} className={solidButton} onClick={onSignIn}>
          Sign in
        </button>
      )}
    </div>
  );
}

/** A server row; open, it lists each account with a switch, then Edit and Remove when editable. */
export function McpServerRow({
  row,
  open,
  onToggleOpen,
  onSwitch,
  onEdit,
  onRemove,
  compact = false,
}: {
  row: McpRow;
  open: boolean;
  onToggleOpen: () => void;
  onSwitch: (chip: McpChip, on: boolean) => void;
  onEdit?: () => void;
  onRemove?: () => void;
  compact?: boolean;
}) {
  const failed = row.chips.find((chip) => chip.state === "failed");
  const subtitle = failed ? `${providerName(failed.provider)}: ${failed.error ?? "Failed"}` : mcpTransportLine(row);
  return (
    <div data-mcp-row={row.name} data-open={open}>
      <button type="button" onClick={onToggleOpen} className={`flex w-full items-center gap-3 text-left ${compact ? "px-3 py-2.5" : "min-h-15 px-4 py-3"}`}>
        {!compact && <Tile row={row} />}
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-[13.5px] font-semibold text-ink">{row.name}</span>
          <span className={`truncate text-[12px] ${failed ? "text-red" : "text-ink-3"}`}>{subtitle}</span>
        </span>
        {row.everywhere && <span className="rounded-full bg-hover px-2.5 py-0.5 text-[11.5px] font-medium text-ink">Everywhere</span>}
        <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
          {failed && <HugeiconsIcon data-mcp-failed icon={Alert02Icon} size={14} strokeWidth={2} className="text-red" color="currentColor" />}
          {mcpSummary(row)}
        </span>
        <HugeiconsIcon icon={open ? ArrowUp01Icon : ArrowDown01Icon} size={16} strokeWidth={1.75} className="text-ink-3" color="currentColor" />
      </button>
      {open && (
        <div className="bg-inset px-4 py-2">
          {row.chips.map((chip) => (
            <div key={keyOf(chip)} className="flex min-h-10 items-center gap-3">
              <span className="w-64 truncate text-[13px] text-ink">
                {providerName(chip.provider)} · {chip.label}
              </span>
              <span className={`min-w-0 flex-1 truncate text-[12px] ${chip.state === "failed" ? "text-red" : "text-ink-2"}`}>{mcpChipLine(chip)}</span>
              <span data-mcp-switch={`${keyOf(chip)}:${row.name}`}>
                <Switch label={`${row.name} for ${providerName(chip.provider)} ${chip.label}`} checked={chip.state !== "disabled"} onChange={(on) => onSwitch(chip, on)} />
              </span>
            </div>
          ))}
          {(onEdit || onRemove) && (
            <div className="flex min-h-11 items-center gap-2">
              <span className="min-w-0 flex-1 text-[12px] text-ink-3">{row.everywhere ? "Everywhere adds it to providers whose config lacks it." : ""}</span>
              {onEdit && (
                <button type="button" className={outlineButton} onClick={onEdit}>
                  Edit
                </button>
              )}
              {onRemove && (
                <button type="button" className={`${outlineButton} text-red`} onClick={onRemove}>
                  Remove
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function McpOtherHeader({ open, count, attention, onToggle }: { open: boolean; count: number; attention: number; onToggle: () => void }) {
  return (
    <button type="button" data-mcp-other onClick={onToggle} className="flex min-h-13 w-full items-center gap-3 px-4 text-left">
      <HugeiconsIcon icon={FolderGitIcon} size={16} strokeWidth={1.75} className="text-ink-2" color="currentColor" />
      <span className="flex-1 text-[13px] font-medium text-ink">From projects, plugins and claude.ai</span>
      <span className="text-[12px] text-ink-3">{attention ? `${count} · ${attention} needs sign-in` : count}</span>
      <HugeiconsIcon icon={open ? ArrowUp01Icon : ArrowDown01Icon} size={16} strokeWidth={1.75} className="text-ink-3" color="currentColor" />
    </button>
  );
}
```

Check each Hugeicons name exists: `node -e "const i=require('@hugeicons/core-free-icons');console.log(['ArrowDown01Icon','ArrowUp01Icon','Alert02Icon','CommandLineIcon','Globe02Icon','FolderGitIcon'].map(n=>n+':'+!!i[n]))"`. Swap any missing one for the closest name in that package (`grep -o '[A-Za-z0-9]*Icon' node_modules/@hugeicons/core-free-icons/dist/esm/index.d.ts | grep -i <word>`).

- [ ] **Step 4: Write `McpServerSheet.tsx`**

```tsx
import { useState } from "react";
import { createPortal } from "react-dom";
import { MCP_SECRET_MASK, validateMcpServer, type McpServerDefinition, type McpTarget } from "@milagre/shared/mcp";
import { outlineButton, solidButton } from "./McpServerRow";

type Pair = { key: string; value: string };
const toPairs = (record: Record<string, string>): Pair[] => Object.entries(record).map(([key, value]) => ({ key, value }));
const toRecord = (pairs: Pair[]) => Object.fromEntries(pairs.filter((pair) => pair.key || pair.value).map((pair) => [pair.key, pair.value]));
const field = "w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-ink";
const TARGETS: { value: McpTarget; label: string; hint: string }[] = [
  { value: "everywhere", label: "Everywhere", hint: "Milagre Chats on every provider" },
  { value: "claude", label: "Claude only", hint: "Written to Claude’s config" },
  { value: "codex", label: "Codex only", hint: "Written to Codex’s config" },
];

/** Add or edit one server. `initial` set means edit; `remote` limits it to URL servers. */
export function McpServerSheet({
  initial,
  initialTarget = "everywhere",
  remote,
  onSave,
  onClose,
}: {
  initial?: McpServerDefinition;
  initialTarget?: McpTarget;
  remote: boolean;
  onSave: (def: McpServerDefinition, target: McpTarget) => Promise<void>;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<"url" | "command">(initial?.type === "stdio" ? "command" : "url");
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial && initial.type !== "stdio" ? initial.url : "");
  const [command, setCommand] = useState(initial?.type === "stdio" ? [initial.command, ...initial.args].join(" ") : "");
  const [pairs, setPairs] = useState<Pair[]>(toPairs(initial ? (initial.type === "stdio" ? initial.env : initial.headers) : {}));
  const [target, setTarget] = useState<McpTarget>(initialTarget);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [first = "", ...rest] = command.trim().split(/\s+/);
  const def: McpServerDefinition =
    kind === "url" ? { name: name.trim(), type: "http", url: url.trim(), headers: toRecord(pairs) } : { name: name.trim(), type: "stdio", command: first, args: rest, env: toRecord(pairs) };
  const submit = async () => {
    const problem = validateMcpServer(def);
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    try {
      await onSave(def, target);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={initial ? "Edit MCP server" : "Add MCP server"}
        data-mcp-sheet
        className="w-[520px] space-y-4 rounded-2xl bg-surface p-6 shadow-card"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 className="text-[17px] font-semibold text-ink">{initial ? "Edit MCP server" : "Add MCP server"}</h2>
        <div className="flex gap-1 rounded-[9px] bg-field p-[3px]">
          {(["url", "command"] as const).map((value) => (
            <button
              key={value}
              type="button"
              disabled={value === "command" && remote}
              onClick={() => setKind(value)}
              className={`flex-1 rounded-[7px] py-1.5 text-[13px] ${kind === value ? "bg-surface font-medium text-ink shadow-card" : "text-ink-2"} disabled:opacity-40`}
            >
              {value === "url" ? "URL" : remote ? "Command (on the Mac)" : "Command"}
            </button>
          ))}
        </div>
        <label className="block space-y-1.5 text-[12px] font-medium text-ink-2">
          Name
          <input aria-label="Name" autoFocus className={field} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {kind === "url" ? (
          <label className="block space-y-1.5 text-[12px] font-medium text-ink-2">
            URL
            <input aria-label="URL" className={field} placeholder="https://" value={url} onChange={(event) => setUrl(event.target.value)} />
            <span className="block font-normal text-ink-3">If the server asks you to sign in, your browser opens after you add it.</span>
          </label>
        ) : (
          <label className="block space-y-1.5 text-[12px] font-medium text-ink-2">
            Command
            <input aria-label="Command" className={field} placeholder="npx -y @scope/server" value={command} onChange={(event) => setCommand(event.target.value)} />
          </label>
        )}
        <div className="space-y-1.5">
          <span className="text-[12px] font-medium text-ink-2">{kind === "url" ? "Headers (optional)" : "Environment (optional)"}</span>
          {[...pairs, { key: "", value: "" }].map((pair, index) => (
            <div key={index} className="flex gap-2">
              <input
                aria-label={kind === "url" ? "Header" : "Variable"}
                className={`${field} w-44`}
                placeholder={kind === "url" ? "Header" : "Variable"}
                value={pair.key}
                onChange={(event) => setPairs(Object.assign([...pairs], { [index]: { ...pair, key: event.target.value } }))}
              />
              <input
                aria-label="Value"
                className={field}
                placeholder="Value"
                value={pair.value}
                onFocus={() => pair.value === MCP_SECRET_MASK && setPairs(Object.assign([...pairs], { [index]: { ...pair, value: "" } }))}
                onChange={(event) => setPairs(Object.assign([...pairs], { [index]: { ...pair, value: event.target.value } }))}
              />
            </div>
          ))}
        </div>
        <fieldset className="space-y-1.5">
          <legend className="text-[12px] font-medium text-ink-2">Load it in</legend>
          <div className="divide-y divide-line rounded-[10px] border border-line">
            {TARGETS.map((option) => (
              <label key={option.value} className="flex min-h-11 cursor-pointer items-center gap-2.5 px-3">
                <input type="radio" name="target" className="accent-[var(--ink)]" checked={target === option.value} onChange={() => setTarget(option.value)} />
                <span className={`flex-1 text-[13px] ${target === option.value ? "font-medium text-ink" : "text-ink-2"}`}>{option.label}</span>
                <span className="text-[12px] text-ink-3">{option.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="text-[12.5px] break-words text-red">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={outlineButton} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={solidButton} disabled={busy}>
            {busy ? "Saving…" : initial ? "Save" : kind === "url" ? "Add and sign in" : "Add server"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
```

Note: a focused masked value clears so the user types a new one; an untouched one is sent back as the mask and kept by the runtime (Global Constraints).

- [ ] **Step 5: Rewrite `McpSettings.tsx`**

Keep the existing data loading (accounts, then a parallel check per account, the `run` ref guard). Add an `onChanged` subscription and these actions:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { groupMcpRows, type McpAccount, type McpAccountCheck, type McpChip, type McpRow, type McpServerDefinition, type McpTarget } from "@milagre/shared/mcp";
import { providerName } from "@milagre/shared/providers";
import type { MilagreBridge } from "../electron";
import { McpOtherHeader, McpServerRow, McpSignInRow, outlineButton, solidButton } from "./McpServerRow";
import { McpServerSheet } from "./McpServerSheet";

const keyOf = (account: Pick<McpAccount, "provider" | "accountId">) => `${account.provider}:${account.accountId}`;
const card = "divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface";
type Entry = { account: McpAccount; check: McpAccountCheck | null };
// Where an editable row lives: Everywhere if any chip says so, else the first user-scope provider.
const targetOf = (row: McpRow): McpTarget => (row.everywhere ? "everywhere" : (row.chips.find((chip) => chip.scope === "user")?.provider as McpTarget) ?? "everywhere");

/** Settings › MCP for one computer: this one by default, or a paired Mac's bridge on its computer page. */
export function McpSettings({ bridge = window.milagre, remote = false }: { bridge?: MilagreBridge; remote?: boolean }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [otherOpen, setOtherOpen] = useState(false);
  const [signingIn, setSigningIn] = useState<Set<string>>(new Set());
  const [sheet, setSheet] = useState<{ initial?: McpServerDefinition; target?: McpTarget; previous?: { name: string; target: McpTarget } } | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const run = useRef(0);

  const checkOne = useCallback(
    async (account: McpAccount, id: number) => {
      const check = await bridge.mcp
        .check(account.provider, account.accountId)
        .catch((cause): McpAccountCheck => ({ ...account, problem: cause instanceof Error ? cause.message : String(cause), servers: [] }));
      if (id !== run.current) return;
      setEntries((current) => current?.map((entry) => (keyOf(entry.account) === keyOf(account) ? { ...entry, check } : entry)) ?? null);
    },
    [bridge],
  );
  const refresh = useCallback(async () => {
    const id = ++run.current;
    setError("");
    let accounts: McpAccount[];
    try {
      accounts = await bridge.mcp.accounts();
    } catch (cause) {
      if (id === run.current) setError(cause instanceof Error ? cause.message : "Could not reach the computer. Check the connection, then refresh.");
      return;
    }
    if (id !== run.current) return;
    setEntries(accounts.map((account) => ({ account, check: null })));
    await Promise.all(accounts.map((account) => checkOne(account, id)));
    if (id === run.current) setCheckedAt(Date.now());
  }, [bridge, checkOne]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(
    () =>
      bridge.mcp.onChanged?.((event) => {
        if (event.signIn) {
          // One account finished; the row stays "signing in" while the next account's tab is open.
          if (event.last || event.signIn !== "done") setSigningIn((current) => new Set([...current].filter((name) => name !== event.name)));
          const account = entries?.find((entry) => keyOf(entry.account) === `${event.provider}:${event.accountId}`)?.account;
          if (account) void checkOne(account, run.current);
          return;
        }
        void refresh();
      }),
    [bridge, checkOne, entries, refresh],
  );

  const checks = (entries ?? []).flatMap((entry) => (entry.check ? [entry.check] : []));
  const { attention, user, other } = groupMcpRows(checks);
  const problems = checks.filter((check) => check.problem);
  const checking = entries === null || (entries ?? []).some((entry) => !entry.check);
  const otherAttention = attention.filter((row) => !row.editable);
  const signIn = (row: McpRow) => {
    setSigningIn((current) => new Set(current).add(row.name));
    const targets = row.chips.filter((chip) => chip.state === "needs-sign-in").map(({ provider, accountId }) => ({ provider, accountId }));
    void bridge.mcp.signIn(row.name, targets).catch((cause) => {
      setSigningIn((current) => new Set([...current].filter((name) => name !== row.name)));
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const onSwitch = (row: McpRow) => (chip: McpChip, on: boolean) => void bridge.mcp.toggle(chip.provider, chip.accountId, row.name, on).then(refresh);
  const edit = async (row: McpRow) => {
    const target = targetOf(row);
    const initial = await bridge.mcp.definition(row.name, target);
    if (initial) setSheet({ initial, target, previous: { name: row.name, target } });
  };
  const removeRow = (row: McpRow) => void bridge.mcp.remove(row.name, targetOf(row)).then(refresh);
  const save = async (def: McpServerDefinition, target: McpTarget) => {
    await (def.type === "stdio" || !remote ? bridge.mcp.save : bridge.mcp.saveUrl)(def, target, sheet?.previous);
    await refresh();
  };
  const seconds = checkedAt ? Math.max(1, Math.round((Date.now() - checkedAt) / 1000)) : null;

  return (
    <div className="mt-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[13px] text-ink-2">
          Tool servers your Chats load, for every account on this Mac.{checking ? " Checking…" : seconds ? ` Checked ${seconds} s ago.` : ""}
        </p>
        <div className="flex shrink-0 gap-2">
          <button type="button" aria-label="Refresh" className={`${outlineButton} px-2.5`} disabled={checking} onClick={() => void refresh()}>
            <HugeiconsIcon icon={RefreshIcon} size={15} strokeWidth={1.75} color="currentColor" />
          </button>
          <button type="button" data-mcp-add className={`${solidButton} inline-flex items-center gap-1.5`} onClick={() => setSheet({})}>
            <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} color="currentColor" />
            Add server
          </button>
        </div>
      </div>
      {error && <p className="text-[13px] text-red">{error}</p>}
      {problems.map((check) => (
        <p key={keyOf(check)} data-mcp-problem={keyOf(check)} className="text-[12px] text-ink-3">
          {providerName(check.provider)} · {check.label}: {check.problem}
        </p>
      ))}
      {attention.filter((row) => row.editable).length > 0 && (
        <section className="space-y-2">
          <h2 className="px-1 text-[12px] font-medium text-ink-2">Needs sign-in · {attention.filter((row) => row.editable).length}</h2>
          <div className={card}>
            {attention
              .filter((row) => row.editable)
              .map((row) => (
                <McpSignInRow key={row.name} row={row} remote={remote} signingIn={signingIn.has(row.name)} onSignIn={() => signIn(row)} onCancel={() => void bridge.mcp.cancelSignIn(row.name)} />
              ))}
          </div>
        </section>
      )}
      {user.length > 0 && (
        <section className="space-y-2">
          <h2 className="px-1 text-[12px] font-medium text-ink-2">Your servers · {user.length}</h2>
          <div className={card}>
            {user.map((row) => (
              <McpServerRow
                key={row.name}
                row={row}
                open={open === row.name}
                onToggleOpen={() => setOpen(open === row.name ? null : row.name)}
                onSwitch={onSwitch(row)}
                onEdit={remote && row.transport === "command" ? undefined : () => void edit(row)}
                onRemove={() => removeRow(row)}
              />
            ))}
          </div>
        </section>
      )}
      {(other.length > 0 || otherAttention.length > 0) && (
        <div className={card}>
          <McpOtherHeader open={otherOpen} count={other.reduce((sum, group) => sum + group.rows.length, 0) + otherAttention.length} attention={otherAttention.length} onToggle={() => setOtherOpen(!otherOpen)} />
          {otherOpen && (
            <div className="space-y-2.5 bg-inset px-4 py-4">
              <p className="text-[12px] text-ink-2">Set up outside Milagre. Turn them on or off here; change them where they live.</p>
              {otherAttention.length > 0 && (
                <div className={card}>
                  {otherAttention.map((row) => (
                    <McpSignInRow key={row.name} row={row} remote={remote} signingIn={signingIn.has(row.name)} onSignIn={() => signIn(row)} onCancel={() => void bridge.mcp.cancelSignIn(row.name)} />
                  ))}
                </div>
              )}
              {other.map((group) => (
                <div key={group.source} className="space-y-1.5">
                  <h3 className="px-1 text-[12px] font-medium text-ink-2">{group.source}</h3>
                  <div className={card}>
                    {group.rows.map((row) => (
                      <McpServerRow key={row.name} compact row={row} open={open === row.name} onToggleOpen={() => setOpen(open === row.name ? null : row.name)} onSwitch={onSwitch(row)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {entries && !checking && !attention.length && !user.length && !other.length && !problems.length && (
        <p className="text-[13px] text-ink-3">No MCP servers yet. Add one with Add server.</p>
      )}
      {sheet && <McpServerSheet initial={sheet.initial} initialTarget={sheet.target} remote={remote} onSave={save} onClose={() => setSheet(null)} />}
    </div>
  );
}
```

Two points about this code:
- Sign-in rows from projects and plugins are listed inside the expander, so they aren't lost.
- A new URL server that needs sign-in shows up in Needs sign-in on the refresh after saving. The user clicks Sign in there. Automatic sign-in right after "Add and sign in" is Step 6.

In `Settings.tsx` around line 347, pass `remote` on the computer page: `<McpSettings key={id} bridge={bridgeFor(id)} remote />`.

- [ ] **Step 6: "Add and sign in" starts sign-in**

In `save`, after `await refresh()`:
1. When `def.type !== "stdio"` and `!remote`, call `bridge.mcp.check` for each account and collect the chips for `def.name` whose state is `needs-sign-in`.
2. If there are any, call `signIn` with a row built from those chips. Reuse the `signIn` function by passing `{ name: def.name, chips } as McpRow`.

Add this case to the Electron check:
1. Stub `check` to answer `needs-sign-in` for `docs` after a save.
2. Assert that `window.signedIn[0] === 'docs'`.

- [ ] **Step 7: Run the check, expect PASS; look at the screenshots**

Run: `MILAGRE_SCREENSHOT_DIR=$TMPDIR/mcp-shots npm test -- --only test-mcp-settings`.
Expected: PASS.

Open each PNG and compare it with the approved designs:
- black Sign in buttons
- no green and no dots
- the summary sits next to the chevron
- the projects-and-plugins section expands in place

Fix any difference before committing.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/app/src/components scripts/test-mcp-settings.cjs
git commit -m "feat(desktop): redesigned Settings › MCP with add, sign-in and switches (#376)"
```

---

### Task 13: Phone screens

**Files:**
- Create: `apps/mobile/src/use-mcp.ts`
- Modify: `apps/mobile/src/mcp-section.tsx`
- Create: `apps/mobile/src/app/mcp-server.tsx`, `apps/mobile/src/app/mcp-add.tsx`
- Modify: `apps/mobile/src/app/_layout.tsx` (register both; `mcp-add` with the `sheet` options at ~31)
- Modify: `apps/mobile/src/app/mcp.tsx` (nav-bar Refresh and + via `Stack.Screen` `headerRight`)
- Modify: `apps/mobile/src/ui.tsx` (`Toggle` gains optional `tint?: ColorValue`, default `colors.green`, passed as `seedColor`)

**Interfaces:**
- Consumes:
  - the phone client `client.call(method, args)` with the methods allowed in Task 11
  - the `"mcp"` live signal
  - shared grouping and copy
- Produces:
  - `useMcp()` returns `{ entries, checks, groups: ReturnType<typeof groupMcpRows>, problems, error, checking, refresh, toggle(chip, name, on), remove(name, target), definition(name, target), saveUrl(def, target, previous?) }`
  - `useMcp` keeps one store per connected client. It's a module-level `Map` keyed by client URL with subscribers, so the list, detail and sheet screens share one state.

- [ ] **Step 1: `use-mcp.ts`**

Move the loading logic out of `mcp-section.tsx` (`McpForComputer`'s `refresh`, the 403 copy and the per-account parallel checks) into a module store:

```ts
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { groupMcpRows, type McpAccount, type McpAccountCheck, type McpChip, type McpServerDefinition, type McpTarget } from "@milagre/shared/mcp";
import { useSession } from "./session";

type Entry = { account: McpAccount; check: McpAccountCheck | null };
type State = { entries: Entry[] | null; error: string };
type Client = NonNullable<ReturnType<typeof useSession>["client"]>;
const keyOf = (account: Pick<McpAccount, "provider" | "accountId">) => `${account.provider}:${account.accountId}`;

function createStore(client: Client) {
  let state: State = { entries: null, error: "" };
  let run = 0;
  const listeners = new Set<() => void>();
  const set = (next: Partial<State>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  async function refresh() {
    const id = ++run;
    let accounts: McpAccount[];
    try {
      accounts = await client.call<McpAccount[]>("mcp:accounts", []);
    } catch (cause) {
      if (id === run)
        set({
          error:
            (cause as { status?: number }).status === 403
              ? "Not available on this computer. Update Milagre on the Mac, then refresh."
              : "Could not reach the computer. Check the connection, then refresh.",
        });
      return;
    }
    if (id !== run) return;
    set({ error: "", entries: accounts.map((account) => ({ account, check: null })) });
    await Promise.all(
      accounts.map(async (account) => {
        const check = await client
          .call<McpAccountCheck>("mcp:check", [account.provider, account.accountId])
          .catch((): McpAccountCheck => ({ ...account, problem: "Could not check. Check the computer connection, then refresh.", servers: [] }));
        if (id === run) set({ entries: state.entries?.map((entry) => (keyOf(entry.account) === keyOf(account) ? { ...entry, check } : entry)) ?? null });
      }),
    );
  }
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    toggle: (chip: McpChip, name: string, on: boolean) => client.call("mcp:toggle", [chip.provider, chip.accountId, name, on]).then(refresh),
    remove: (name: string, target: McpTarget) => client.call("mcp:remove", [name, target]).then(refresh),
    definition: (name: string, target: McpTarget) => client.call<McpServerDefinition | null>("mcp:definition", [name, target]),
    saveUrl: (def: McpServerDefinition, target: McpTarget, previous?: { name: string; target: McpTarget }) => client.call("mcp:saveUrl", [def, target, previous ?? null]).then(refresh),
  };
}

const stores = new Map<string, ReturnType<typeof createStore>>();

export function useMcp() {
  const client = useSession().client;
  const store = client ? (stores.get(client.url) ?? stores.set(client.url, createStore(client)).get(client.url)!) : null;
  const state = useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.get ?? (() => ({ entries: null, error: "" })));
  useEffect(() => {
    if (!store || !client) return;
    if (state.entries === null) void store.refresh();
    let live = client.live("", { onSignal: (signal) => signal === "mcp" && void store.refresh() });
    const watch = AppState.addEventListener("change", (status) => {
      if (status !== "active") return;
      live.close();
      live = client.live("", { onSignal: (signal) => signal === "mcp" && void store.refresh() });
      void store.refresh();
    });
    return () => {
      live.close();
      watch.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one subscription per store
  }, [store, client]);
  const checks = (state.entries ?? []).flatMap((entry) => (entry.check ? [entry.check] : []));
  return {
    ...state,
    checks,
    groups: groupMcpRows(checks),
    problems: checks.filter((check) => check.problem),
    checking: state.entries === null || state.entries.some((entry) => !entry.check),
    refresh: () => store?.refresh(),
    toggle: (chip: McpChip, name: string, on: boolean) => store?.toggle(chip, name, on),
    remove: (name: string, target: McpTarget) => store?.remove(name, target),
    definition: (name: string, target: McpTarget) => store?.definition(name, target) ?? Promise.resolve(null),
    saveUrl: (def: McpServerDefinition, target: McpTarget, previous?: { name: string; target: McpTarget }) => store?.saveUrl(def, target, previous),
  };
}
```

`client.live(scope, handlers)` and `client.url` come from the existing phone client (`use-designs.ts:44-49`). If `url` has another name on the client type, key the map by that.

- [ ] **Step 2: `mcp-section.tsx`, the grouped list**

Rewrite it to use `useMcp()`. Keep the existing `useStyles`, `useTheme`, `ErrorNotice` and `ListRow` from `./ui`, and the separators and grouped card style of the current file (surface, radius 14, `borderCurve: "continuous"`, hairline separators). Sections:
- **NEEDS SIGN-IN.** Header text "Needs sign-in", in caps through the style. Each row has an orange key tile (`Key01Icon`), the name, `mcpTransportLine(row)` under it, and a trailing "On the Mac" in `ink3`. Not pressable.
- **YOUR SERVERS.** Each row has the name. Under it: `Everywhere · ${mcpSummary(row)}` when `row.everywhere`; otherwise `${row.transport === "command" ? "Command" : "URL"} · ${mcpSummary(row)}`, or for a failed chip `${providerName(failed.provider)} failed · ${mcpSummary(row)}` in `colors.red`. A failed row also gets a trailing red `Alert02Icon` before the chevron. `onPress` calls `router.push({ pathname: "/mcp-server", params: { name: row.name } })`.
- **Projects and plugins.** One row with the count. On press it expands in place: `useState`, with the groups rendered below as compact rows and the source as a small header. Tapping a compact row also pushes `/mcp-server`.
- Problems and the empty copy stay as they are.

- [ ] **Step 3: `app/mcp-server.tsx`, the detail**

```tsx
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Text, View } from "react-native";
import { mcpChipLine, mcpTransportLine, type McpRow, type McpTarget } from "@milagre/shared/mcp";
import { providerName } from "@milagre/shared/providers";
import { useMcp } from "../use-mcp";
import { Button, PageScroll, Toggle, useStyles } from "../ui";
import { useTheme } from "../theme";
import { confirm } from "../confirm-store";

const targetOf = (row: McpRow): McpTarget => (row.everywhere ? "everywhere" : ((row.chips.find((chip) => chip.scope === "user")?.provider as McpTarget) ?? "everywhere"));

export default function McpServerScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const mcp = useMcp();
  const styles = useStyles();
  const { colors } = useTheme();
  const { attention, user, other } = mcp.groups;
  const row = [...attention, ...user, ...other.flatMap((group) => group.rows)].find((item) => item.name === name);
  if (!row) return <Stack.Screen options={{ title: name ?? "MCP" }} />;
  return (
    <>
      <Stack.Screen options={{ title: row.name }} />
      <PageScroll>
        <Text style={[styles.muted, { paddingHorizontal: 4 }]}>{mcpTransportLine(row)}</Text>
        <View style={{ backgroundColor: colors.surface, borderRadius: 14, borderCurve: "continuous", paddingHorizontal: 16 }}>
          {row.chips.map((chip, index) => (
            <View key={`${chip.provider}:${chip.accountId}`} style={{ borderTopWidth: index ? 1 : 0, borderColor: colors.line, paddingVertical: 8, gap: 2 }}>
              <Toggle title={`${providerName(chip.provider)} · ${chip.label}`} selected={chip.state !== "disabled"} tint={colors.ink} onPress={() => void mcp.toggle(chip, row.name, chip.state === "disabled")} />
              <Text style={[styles.muted, { color: chip.state === "failed" ? colors.red : colors.ink2 }]} selectable>
                {mcpChipLine(chip)}
              </Text>
            </View>
          ))}
        </View>
        {row.editable && row.transport === "url" ? (
          <View style={{ gap: 10 }}>
            <Button title="Edit" secondary onPress={() => router.push({ pathname: "/mcp-add", params: { name: row.name, target: targetOf(row) } })} />
            <Button
              title="Remove"
              secondary
              onPress={() => confirm(`Remove ${row.name}?`, "Chats stop loading it.", async () => {
                await mcp.remove(row.name, targetOf(row));
                router.back();
              })}
            />
          </View>
        ) : row.editable ? (
          <Text style={[styles.muted, { paddingHorizontal: 4 }]}>Edit on the Mac.</Text>
        ) : null}
      </PageScroll>
    </>
  );
}
```

Check the `confirm(title, message, action)` and `Button({ title, secondary, onPress })` signatures in `confirm-store.ts:42` and `ui.tsx:122`, and adjust the props if they differ. Show Remove's text in `colors.red` if `Button` takes a tone; otherwise leave it as it is.

- [ ] **Step 4: `app/mcp-add.tsx`, the URL sheet**

A form sheet with these fields:
- Name and URL, using `Field` from `ui.tsx`.
- Headers as key/value `Field` pairs plus an "Add header" text button.
- "Load it in" as three rows (Everywhere / Claude only / Codex only) with a check icon on the selected one. Everywhere is the default.
- Save.
- Error text in `colors.error`.

Editing: with `name` and `target` params, load `mcp.definition(name, target)` and prefill the fields. A masked value clears on focus, the same as desktop. Validate with `validateMcpServer`, then save:

```ts
await mcp.saveUrl({ name: name.trim(), type: "http", url: url.trim(), headers }, target, params.name ? { name: params.name, target: params.target as McpTarget } : undefined);
router.back();
```

On a reject, show `error.message`.

- [ ] **Step 5: Wire routes and the nav bar.**
- `_layout.tsx`: add `<Stack.Screen name="mcp-server" />` and `<Stack.Screen name="mcp-add" options={{ ...sheet, title: "Add MCP server" }} />`.
- `app/mcp.tsx`: `headerRight` gets two 44 pt buttons. Refresh calls `mcp.refresh()`, and + calls `router.push("/mcp-add")`.

- [ ] **Step 6: Typecheck, lint and verify on the simulator**

Run: `npm run typecheck && npm run lint`. Expected: clean.

Then run the phone check recipe from the memory note `mcp-settings-tab` (a throwaway real-runtime daemon with `startMobileBridge` on 8897, Metro on 8790, the Designs QA simulator, Add computer). Its iOS simulator must be slimmed with `simslim` first (`simslim list`).

Take screenshots of:
- the list
- a server's detail
- the add sheet
- a "On the Mac" row

Compare them with the "Phone, MCP list" design and send them to Victor (memory `send-test-screenshots`).

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/src
git commit -m "feat(mobile): Settings › MCP add, edit and switches on the phone (#376)"
```

---

### Task 14: Real sign-in, docs and PR

**Files:**
- Modify: `GLOSSARY.md` if names changed during the build; `docs/superpowers/specs/2026-10-15-mcp-connect-design.md` status line ("Status: built in PR #…").

- [ ] **Step 1: One real sign-in per provider.** Build and run a separate dev copy of the desktop app (never touch the open Milagre; memory `dont-touch-open-milagre`). In Settings › MCP, click Sign in on `expo` (it needs sign-in for both Claude and Codex on Victor's Mac). Finish it in the browser only with Victor present, because it changes his real tokens. Ask him in the Chat first. Confirm the row leaves Needs sign-in and that a new Chat lists expo's tools.

- [ ] **Step 2: Full checks.** Run `npm run typecheck && npm run lint && npm test -- --unit && npm test -- --only test-mcp-settings`. All must pass. Check the phone fingerprint is unchanged (`apps/mobile/AGENTS.md`).

- [ ] **Step 3: Push and open the PR.**
- Push the branch and open a PR titled `feat: connect MCP servers from Settings › MCP (#376)`.
- The body covers what shipped, the two narrowings from the plan header, the probe results and the test commands. It ends with the screenshots, desktop and phone, uploaded to the orphan `screenshots` branch and linked by SHA.
- No Claude attribution.

- [ ] **Step 4: Record in memory.** Update `mcp-settings-tab.md` with the PR number and anything non-obvious found during the build.
