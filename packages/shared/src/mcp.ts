// MCP servers as Settings › MCP shows them, shared by desktop and phone (docs/superpowers/specs/2026-10-15-mcp-connect-design.md).

export type McpProvider = "claude" | "codex" | "antigravity" | "kiro";
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

const PROVIDER_NAMES: Record<McpProvider, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", kiro: "Kiro" };

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
export function mcpSourceRank(source: string): number {
  if (source === "Project") return 0;
  if (source === "Local") return 1;
  if (source.startsWith("Plugin")) return 2;
  if (source === "claude.ai connectors") return 3;
  return 4;
}

/** Rows by server name. Attention: URL or connector rows with a chip that needs sign-in. User: every editable row, those needing
 * sign-in included (they keep their switches, Edit and Remove). Other: the outside rows that don't need sign-in, by source. */
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
  // Outside rows carry their source even in attention, so a page can list them under their group.
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

const isConfigProvider = (provider: McpProvider): provider is "claude" | "codex" => provider === "claude" || provider === "codex";

/** Every config a remove must reach: Everywhere if the row is there, and each Claude or Codex user config holding it. */
export function mcpRemoveTargets(row: McpRow): McpTarget[] {
  const providers = row.chips.filter((chip) => chip.scope === "user" && isConfigProvider(chip.provider)).map((chip) => chip.provider as McpTarget);
  return [...new Set<McpTarget>([...(row.everywhere ? (["everywhere"] as const) : []), ...providers])];
}

const TARGET_PLACES: Record<McpTarget, string> = { everywhere: "Everywhere", claude: "Claude’s config", codex: "Codex’s config" };
/** "Everywhere, Claude’s config and Codex’s config": where a remove reaches, for its confirmation and its failures. */
export function mcpTargetPlaces(targets: McpTarget[]): string {
  const places = targets.map((target) => TARGET_PLACES[target]);
  return places.length > 1 ? `${places.slice(0, -1).join(", ")} and ${places[places.length - 1]}` : (places[0] ?? "");
}

/** The config Edit reads and writes: Everywhere, else the default account's user config, else the first user config. */
export function mcpEditTarget(row: McpRow): McpTarget {
  if (row.everywhere) return "everywhere";
  const user = row.chips.filter((chip) => chip.scope === "user" && isConfigProvider(chip.provider));
  return ((user.find((chip) => chip.accountId === "default") ?? user[0])?.provider as McpTarget | undefined) ?? "everywhere";
}

const STATE_COPY: Record<McpChipState, string> = {
  connected: "Connected",
  failed: "Failed",
  "needs-sign-in": "Needs sign-in",
  pending: "Checking",
  disabled: "Off in Milagre Chats",
  unchecked: "Loads in Chats",
};

/** "Connected" for one chip; "2 of 3 connected"; "1 of 2 on" once any chip is off. Accounts that only load it in
 * Chats (unchecked) count in neither side of "connected". */
export function mcpSummary(row: McpRow): string {
  const [only] = row.chips;
  if (only && row.chips.length === 1) return STATE_COPY[only.state];
  if (row.chips.some((chip) => chip.state === "disabled")) return `${row.chips.filter((chip) => chip.state !== "disabled").length} of ${row.chips.length} on`;
  const checked = row.chips.filter((chip) => chip.state !== "unchecked");
  if (!checked.length) return STATE_COPY.unchecked;
  return `${checked.filter((chip) => chip.state === "connected").length} of ${checked.length} connected`;
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
  if (chip.state === "disabled" && chip.disabledBy === "provider") return `Off in ${PROVIDER_NAMES[chip.provider]}’s config`;
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
