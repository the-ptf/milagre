export type McpProvider = "claude" | "codex" | "antigravity" | "kiro" | "pi";
export type McpChipState = "connected" | "failed" | "needs-sign-in" | "pending" | "disabled" | "unchecked";
export type McpTransport = "command" | "url" | "connector";
export type McpScope = "user" | "project" | "local" | "plugin" | "claude.ai" | "built-in" | "everywhere";
export type McpServerReport = {
  name: string;
  transport: McpTransport;
  scope: McpScope;
  state: McpChipState;
  tools: number;
  error: string | null;
  detail: string | null;
  shadowedBy?: McpProvider;
  /** Set when the provider's own config switches it off (Codex enabled = false, a Claude disabled server): Milagre's switch can't turn it on. */
  disabledBy?: "provider";
};
export type McpAccount = { provider: McpProvider; accountId: string; label: string };
/** The answer to mcp:check. `problem` is set when the account could not be checked; `servers` is then empty. */
export type McpAccountCheck = McpAccount & { problem: string | null; servers: McpServerReport[] };
export type McpChip = McpAccount & {
  scope: McpScope;
  state: McpChipState;
  tools: number;
  error: string | null;
  shadowedBy?: McpProvider;
  disabledBy?: "provider";
};
export type McpRow = {
  name: string;
  transport: McpTransport;
  detail: string | null;
  editable: boolean;
  everywhere: boolean;
  source: string | null;
  chips: McpChip[];
};
export type McpTarget = "everywhere" | "claude" | "codex";
export type McpServerDefinition =
  | { name: string; type: "http" | "sse"; url: string; headers: Record<string, string> }
  | { name: string; type: "stdio"; command: string; args: string[]; env: Record<string, string> };
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

const PROVIDER_NAMES: Record<McpProvider, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", kiro: "Kiro", pi: "Pi" };

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

export function mcpSourceRank(source: string): number {
  if (source === "Project") return 0;
  if (source === "Local") return 1;
  if (source.startsWith("Plugin")) return 2;
  if (source === "claude.ai connectors") return 3;
  return 4;
}

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
        ...(server.disabledBy ? { disabledBy: server.disabledBy } : {}),
      });
      row.detail ??= server.detail;
      row.editable ||= server.scope === "user" || server.scope === "everywhere";
      row.everywhere ||= server.scope === "everywhere";
      rows.set(server.name, row);
    }
  }
  const sorted = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const row of sorted) if (!row.editable) row.source = sourceOf(row.name, row.chips[0]?.scope ?? "built-in");
  const needsSignIn = (row: McpRow) => row.transport !== "command" && row.chips.some((chip) => chip.state === "needs-sign-in");
  const attention = sorted.filter(needsSignIn);
  const groups = new Map<string, McpRow[]>();
  const others = sorted.filter((item) => !item.editable && !needsSignIn(item));
  for (const row of others) {
    const source = row.source ?? "Built in";
    groups.set(source, [...(groups.get(source) ?? []), row]);
  }
  return {
    attention,
    user: sorted.filter((item) => item.editable),
    other: [...groups]
      .map(([source, groupRows]) => ({ source, rows: groupRows }))
      .sort((a, b) => mcpSourceRank(a.source) - mcpSourceRank(b.source) || a.source.localeCompare(b.source)),
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

export function mcpSummary(row: McpRow): string {
  const [only] = row.chips;
  if (only && row.chips.length === 1) return STATE_COPY[only.state];
  if (row.chips.some((chip) => chip.state === "disabled")) return `${row.chips.filter((chip) => chip.state !== "disabled").length} of ${row.chips.length} on`;
  const checked = row.chips.filter((chip) => chip.state !== "unchecked");
  if (!checked.length) return STATE_COPY.unchecked;
  return `${checked.filter((chip) => chip.state === "connected").length} of ${checked.length} connected`;
}

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

export function mcpChipLine(chip: McpChip): string {
  if (chip.state === "failed") return chip.error ?? STATE_COPY.failed;
  if (chip.state === "disabled" && chip.disabledBy === "provider") return `Off in ${PROVIDER_NAMES[chip.provider]}’s config`;
  if (chip.state !== "connected") return STATE_COPY[chip.state];
  const parts = [`Connected · ${chip.tools} tools`];
  if (chip.scope === "everywhere") parts.push("from Everywhere");
  if (chip.shadowedBy) parts.push(`uses ${PROVIDER_NAMES[chip.shadowedBy]}’s own`);
  return parts.join(" · ");
}
