// MCP servers as Settings › MCP shows them, shared by desktop and phone (docs/superpowers/specs/2026-10-15-mcp-connect-design.md).

export type McpProvider = "claude" | "codex" | "antigravity";
export type McpChipState = "connected" | "failed" | "needs-sign-in" | "pending" | "disabled" | "unchecked";
export type McpTransport = "command" | "url" | "connector";
export type McpScope = "user" | "project" | "local" | "plugin" | "claude.ai" | "built-in" | "everywhere";
/** One server as one account loads it. `detail` is the URL or the command line. */
export type McpServerReport = {
  name: string;
  transport: McpTransport;
  scope: McpScope;
  state: McpChipState;
  tools: number;
  error: string | null;
  detail: string | null;
  shadowedBy?: McpProvider;
};
export type McpAccount = { provider: McpProvider; accountId: string; label: string };
/** The answer to mcp:check. `problem` is set when the account could not be checked; `servers` is then empty. */
export type McpAccountCheck = McpAccount & { problem: string | null; servers: McpServerReport[] };
export type McpChip = McpAccount & { scope: McpScope; state: McpChipState; tools: number; error: string | null; shadowedBy?: McpProvider };
export type McpRow = {
  name: string;
  transport: McpTransport;
  detail: string | null;
  editable: boolean;
  everywhere: boolean;
  source: string | null;
  chips: McpChip[];
};
/** Where a saved server goes: Milagre's own list, or one provider's user config. */
export type McpTarget = "everywhere" | "claude" | "codex";
export type McpServerDefinition =
  | { name: string; type: "http" | "sse"; url: string; headers: Record<string, string> }
  | { name: string; type: "stdio"; command: string; args: string[]; env: Record<string, string> };
/** Sent after a write, a toggle or a finished sign-in, so open screens check again. */
export type McpChangedEvent = {
  name: string | null;
  provider?: McpProvider;
  accountId?: string;
  signIn?: "done" | "failed" | "cancelled";
  error?: string | null;
  last?: boolean;
};
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

/** Order of the `other` groups: projects, local, plugins, claude.ai connectors, built in. */
function groupRank(source: string): number {
  if (source === "Project") return 0;
  if (source === "Local") return 1;
  if (source.startsWith("Plugin")) return 2;
  if (source === "claude.ai connectors") return 3;
  return 4;
}

/** Rows by server name. Attention: URL or connector rows with a chip that needs sign-in. User: editable rows. Other: the rest, by source. */
export function groupMcpRows(checks: McpAccountCheck[]): { attention: McpRow[]; user: McpRow[]; other: { source: string; rows: McpRow[] }[] } {
  const rows = new Map<string, McpRow>();
  for (const check of checks) {
    if (check.problem) continue;
    for (const server of check.servers) {
      const row = rows.get(server.name) ?? {
        name: server.name,
        transport: server.transport,
        detail: server.detail,
        editable: false,
        everywhere: false,
        source: null,
        chips: [],
      };
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
  const others = rest.filter((item) => !item.editable);
  for (const row of others) {
    row.source = sourceOf(row.name, row.chips[0]?.scope ?? "built-in");
    groups.set(row.source, [...(groups.get(row.source) ?? []), row]);
  }
  return {
    attention,
    user: rest.filter((item) => item.editable),
    other: [...groups]
      .map(([source, groupRows]) => ({ source, rows: groupRows }))
      .sort((a, b) => groupRank(a.source) - groupRank(b.source) || a.source.localeCompare(b.source)),
  };
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
