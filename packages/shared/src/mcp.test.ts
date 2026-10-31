import test from "node:test";
import assert from "node:assert/strict";
import {
  groupMcpRows,
  MCP_CATALOG,
  mcpCatalogDefinition,
  mcpChipLine,
  mcpEditTarget,
  mcpRemoveTargets,
  mcpTargetPlaces,
  mcpSummary,
  mcpTransportLine,
  validateMcpServer,
  type McpAccountCheck,
  type McpServerReport,
} from "./mcp.ts";

const server = (over: Partial<McpServerReport>): McpServerReport => ({
  name: "pencil",
  transport: "command",
  scope: "user",
  state: "connected",
  tools: 14,
  error: null,
  detail: "pencil mcp --stdio",
  ...over,
});
const check = (provider: McpAccountCheck["provider"], accountId: string, servers: McpServerReport[]): McpAccountCheck => ({
  provider,
  accountId,
  label: accountId,
  problem: null,
  servers,
});

test("rows needing sign-in go to attention; editable ones stay in Your servers too", () => {
  const { attention, user, other } = groupMcpRows([
    check("claude", "default", [
      server({ name: "linear", transport: "url", state: "needs-sign-in", detail: "https://mcp.linear.app/mcp" }),
      server({}),
      server({ name: "plugin:engineering:notion", transport: "url", scope: "plugin", state: "needs-sign-in", detail: "https://mcp.notion.com/mcp" }),
    ]),
    check("codex", "default", [server({ name: "linear", transport: "url", detail: "https://mcp.linear.app/mcp" })]),
  ]);
  assert.deepEqual(
    attention.map((row) => row.name),
    ["linear", "plugin:engineering:notion"],
  );
  // Your servers keeps linear with its switches, Edit and Remove; an outside row only lists under attention.
  assert.deepEqual(
    user.map((row) => row.name),
    ["linear", "pencil"],
  );
  assert.deepEqual(other, []);
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
  assert.deepEqual(
    other.map((group) => group.source),
    ["Project", "Plugin · engineering", "claude.ai connectors"],
  );
});

test("an outside row that needs sign-in keeps its source, so it lists under its group", () => {
  const { attention } = groupMcpRows([
    check("claude", "default", [
      server({ name: "plugin:engineering:notion", transport: "url", scope: "plugin", state: "needs-sign-in", detail: "https://mcp.notion.com/mcp" }),
      server({ name: "linear", transport: "url", state: "needs-sign-in", detail: "https://mcp.linear.app/mcp" }),
    ]),
  ]);
  assert.deepEqual(
    attention.map((row) => [row.name, row.source]),
    [
      ["linear", null],
      ["plugin:engineering:notion", "Plugin · engineering"],
    ],
  );
});

test("summary counts connected, or on when something is off", () => {
  const rows = groupMcpRows([check("claude", "a", [server({})]), check("claude", "b", [server({ state: "disabled" })])]).user;
  assert.equal(mcpSummary(rows[0]), "1 of 2 on");
  const all = groupMcpRows([check("claude", "a", [server({})]), check("codex", "b", [server({})])]).user;
  assert.equal(mcpSummary(all[0]), "2 of 2 connected");
  assert.equal(mcpSummary(groupMcpRows([check("claude", "a", [server({})])]).user[0]), "Connected");
  // An account that only loads it in Chats (Antigravity) is not counted either way.
  const loads = groupMcpRows([
    check("claude", "a", [server({})]),
    check("codex", "b", [server({})]),
    check("antigravity", "c", [server({ scope: "everywhere", state: "unchecked" })]),
  ]).user;
  assert.equal(mcpSummary(loads[0]), "2 of 2 connected");
  const onlyLoads = groupMcpRows([
    check("antigravity", "c", [server({ scope: "everywhere", state: "unchecked" })]),
    check("antigravity", "d", [server({ scope: "everywhere", state: "unchecked" })]),
  ]).user;
  assert.equal(mcpSummary(onlyLoads[0]), "Loads in Chats");
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
  assert.equal(mcpChipLine({ ...base, state: "disabled", disabledBy: "provider" }), "Off in Claude’s config");
  assert.equal(mcpChipLine({ ...base, provider: "codex", state: "disabled", disabledBy: "provider" }), "Off in Codex’s config");
});

test("a chip carries disabledBy from its report", () => {
  const [row] = groupMcpRows([check("codex", "default", [server({ state: "disabled", disabledBy: "provider" })])]).user;
  assert.equal(row.chips[0].disabledBy, "provider");
});

test("validation refuses unsafe names and missing fields", () => {
  const url = { name: "linear", type: "http" as const, url: "https://mcp.linear.app/mcp", headers: {} };
  assert.equal(validateMcpServer(url), null);
  for (const name of ["", "my server", "a.b", "../x", "milagre"]) assert.ok(validateMcpServer({ ...url, name }), name);
  assert.equal(validateMcpServer({ ...url, url: "ftp://x" }), "Enter an http or https URL.");
  assert.equal(validateMcpServer({ name: "x", type: "stdio", command: " ", args: [], env: {} }), "Enter the command to run.");
  assert.equal(validateMcpServer({ ...url, headers: { "": "v" } }), "Every header needs a name.");
});

test("remove reaches Everywhere and every Claude or Codex config the row lives in", () => {
  const [row] = groupMcpRows([
    check("claude", "default", [server({})]),
    check("claude", "work", [server({})]),
    check("codex", "default", [server({})]),
    check("antigravity", "default", [server({ scope: "everywhere" })]),
  ]).user;
  assert.deepEqual(mcpRemoveTargets(row), ["everywhere", "claude", "codex"]);
  const [codexOnly] = groupMcpRows([check("codex", "default", [server({})]), check("claude", "default", [server({ scope: "project" })])]).user;
  assert.deepEqual(mcpRemoveTargets(codexOnly), ["codex"]);
});

test("edit opens Everywhere, else the default account's provider, else the first user provider", () => {
  const everywhere = groupMcpRows([check("claude", "default", [server({})]), check("antigravity", "default", [server({ scope: "everywhere" })])]).user[0];
  assert.equal(mcpEditTarget(everywhere), "everywhere");
  const defaultFirst = groupMcpRows([check("claude", "work", [server({})]), check("codex", "default", [server({})])]).user[0];
  assert.equal(mcpEditTarget(defaultFirst), "codex");
  const noDefault = groupMcpRows([check("claude", "work", [server({})])]).user[0];
  assert.equal(mcpEditTarget(noDefault), "claude");
});

test("remove targets read as the places they live", () => {
  assert.equal(mcpTargetPlaces(["everywhere"]), "Everywhere");
  assert.equal(mcpTargetPlaces(["claude", "codex"]), "Claude’s config and Codex’s config");
  assert.equal(mcpTargetPlaces(["everywhere", "claude", "codex"]), "Everywhere, Claude’s config and Codex’s config");
});

test("catalog tokens are required, normalized, and never carried to a browser-auth service", () => {
  const github = MCP_CATALOG.find((entry) => entry.id === "github")!;
  const notion = MCP_CATALOG.find((entry) => entry.id === "notion")!;
  for (const invalid of ["", "   ", "••••••", "Bearer ", "token\r\nInjected: header"]) {
    assert.throws(() => mcpCatalogDefinition(github, invalid), /valid personal access token/);
  }
  assert.deepEqual(mcpCatalogDefinition(github, "  Bearer test-token  ").headers, { Authorization: "Bearer test-token" });
  assert.deepEqual(mcpCatalogDefinition(notion, "test-token").headers, {});
});
