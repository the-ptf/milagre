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

/** Official hosted services, checked against their setup docs on 2026-10-31. Custom servers use the same save path. */
export type McpCatalogEntry = {
  id: string;
  name: string;
  description: string;
  url: string;
  auth: "browser" | "token";
  docsUrl: string;
  /** Local SVG path (24 × 24) from https://github.com/simple-icons/simple-icons, CC0; see licenses/simple-icons-LICENSE.md. */
  iconPath: string;
  tokenUrl?: string;
};
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: "github",
    iconPath:
      "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
    name: "GitHub",
    description: "Repositories, issues, and pull requests.",
    url: "https://api.githubcopilot.com/mcp/",
    auth: "token",
    docsUrl: "https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-claude.md",
    tokenUrl: "https://github.com/settings/personal-access-tokens/new",
  },
  {
    id: "linear",
    iconPath:
      "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
    name: "Linear",
    description: "Issues, projects, and team planning.",
    url: "https://mcp.linear.app/mcp",
    auth: "browser",
    docsUrl: "https://linear.app/docs/mcp",
  },
  {
    id: "notion",
    iconPath:
      "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
    name: "Notion",
    description: "Pages, databases, and workspace search.",
    url: "https://mcp.notion.com/mcp",
    auth: "browser",
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
  },
  {
    id: "sentry",
    iconPath:
      "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
    name: "Sentry",
    description: "Errors, performance, and debugging.",
    url: "https://mcp.sentry.dev/mcp",
    auth: "browser",
    docsUrl: "https://mcp.sentry.dev/",
  },
  {
    id: "supabase",
    iconPath:
      "M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z",
    name: "Supabase",
    description: "Projects, databases, and development tools.",
    url: "https://mcp.supabase.com/mcp",
    auth: "browser",
    docsUrl: "https://supabase.com/docs/guides/ai-tools/mcp",
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Projects, deployments, and deployment logs.",
    url: "https://mcp.vercel.com",
    auth: "browser",
    docsUrl: "https://vercel.com/docs/agent-resources/vercel-mcp",
    iconPath: "m12 1.608 12 20.784H0Z",
  },
  {
    id: "stripe",
    name: "Stripe",
    description: "Payments, customers, and subscriptions.",
    url: "https://mcp.stripe.com",
    auth: "browser",
    docsUrl: "https://docs.stripe.com/mcp",
    iconPath:
      "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z",
  },
  {
    id: "upstash",
    name: "Upstash",
    description: "Redis, queues, workflows, and vector databases.",
    url: "https://mcp.upstash.com/mcp",
    auth: "browser",
    docsUrl: "https://upstash.com/docs/agent-resources/mcp",
    iconPath:
      "M13.8027 0C11.193 0 8.583.9952 6.5918 2.9863c-3.9823 3.9823-3.9823 10.4396 0 14.4219 1.9911 1.9911 5.2198 1.9911 7.211 0 1.991-1.9911 1.991-5.2198 0-7.211L12 12c.9956.9956.9956 2.6098 0 3.6055-.9956.9955-2.6099.9955-3.6055 0-2.9866-2.9868-2.9866-7.8297 0-10.8164 2.9868-2.9868 7.8297-2.9868 10.8164 0l1.8028-1.8028C19.0225.9952 16.4125 0 13.8027 0zM12 12c-.9956-.9956-.9956-2.6098 0-3.6055.9956-.9955 2.6098-.9955 3.6055 0 2.9867 2.9868 2.9867 7.8297 0 10.8164-2.9867 2.9868-7.8297 2.9868-10.8164 0l-1.8028 1.8028c3.9823 3.9822 10.4396 3.9822 14.4219 0 3.9823-3.9824 3.9823-10.4396 0-14.4219-.9956-.9956-2.3006-1.4922-3.6055-1.4922-1.3048 0-2.6099.4966-3.6054 1.4922-1.9912 1.9912-1.9912 5.2198 0 7.211z",
  },
  {
    id: "neon",
    name: "Neon",
    description: "Postgres databases, branches, and SQL queries.",
    url: "https://mcp.neon.tech/mcp",
    auth: "browser",
    docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
    iconPath: "M24 0V24l-9.365-8.045V24H0V0ZM2.942 21.087h8.751V9.563l9.365 8.204V2.919L2.942 2.914Z",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    description: "Jira issues, Confluence pages, and Bitbucket repositories.",
    url: "https://mcp.atlassian.com/v2/mcp",
    auth: "browser",
    docsUrl: "https://atlassian.github.io/atlassian-mcp-server/",
    iconPath:
      "M7.12 11.084a.683.683 0 00-1.16.126L.075 22.974a.703.703 0 00.63 1.018h8.19a.678.678 0 00.63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.515 15.515 0 00-.906 15.317l3.95 7.9a.703.703 0 00.628.388h8.19a.703.703 0 00.63-1.017L12.63.38a.664.664 0 00-1.196.006z",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "Workers, DNS, storage, and account configuration.",
    url: "https://mcp.cloudflare.com/mcp",
    auth: "browser",
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/",
    iconPath:
      "M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727",
  },
  {
    id: "miro",
    name: "Miro",
    description: "Boards, diagrams, and team collaboration.",
    url: "https://mcp.miro.com/",
    auth: "browser",
    docsUrl: "https://developers.miro.com/docs/miro-mcp-server-frequently-asked-questions",
    iconPath:
      "M17.392 0H13.9L17 4.808 10.444 0H6.949l3.102 6.3L3.494 0H0l3.05 8.131L0 24h3.494L10.05 6.985 6.949 24h3.494L17 5.494 13.899 24h3.493L24 3.672 17.392 0z",
  },
  {
    id: "todoist",
    name: "Todoist",
    description: "Tasks, projects, due dates, and priorities.",
    url: "https://ai.todoist.net/mcp",
    auth: "browser",
    docsUrl: "https://developer.todoist.com/",
    iconPath:
      "M21 0H3C1.35 0 0 1.35 0 3v3.858s3.854 2.24 4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.608 8.136-4.675.279-.161.58-.107.748-.01.164.097.606.348.84.48.232.134.221.502.013.622l-9.712 5.59c-.346.2-.69.204-1.048.002C3.478 10.907.998 9.463 0 8.882v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.008.164.096.606.347.84.48.232.133.221.5.013.62-.208.121-9.288 5.346-9.712 5.59-.346.2-.69.205-1.048.002C3.478 14.951.998 13.506 0 12.926v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.009.164.097.606.348.84.48.232.133.221.502.013.622l-9.712 5.59c-.346.199-.69.204-1.048.001C3.478 18.994.998 17.55 0 16.97V21c0 1.65 1.35 3 3 3h18c1.65 0 3-1.35 3-3V3c0-1.65-1.35-3-3-3z",
  },
  {
    id: "webflow",
    name: "Webflow",
    description: "Sites, CMS content, and website design.",
    url: "https://mcp.webflow.com/mcp",
    auth: "browser",
    docsUrl: "https://developers.webflow.com/mcp/reference/getting-started",
    iconPath:
      "m24 4.515-7.658 14.97H9.149l3.205-6.204h-.144C9.566 16.713 5.621 18.973 0 19.485v-6.118s3.596-.213 5.71-2.435H0V4.515h6.417v5.278l.144-.001 2.622-5.277h4.854v5.244h.144l2.72-5.244H24Z",
  },
  {
    id: "intercom",
    name: "Intercom (US)",
    description: "Support conversations and contacts in US-hosted workspaces.",
    url: "https://mcp.intercom.com/mcp",
    auth: "browser",
    docsUrl: "https://developers.intercom.com/docs/guides/mcp",
    iconPath:
      "M21 0H3C1.343 0 0 1.343 0 3v18c0 1.658 1.343 3 3 3h18c1.658 0 3-1.342 3-3V3c0-1.657-1.342-3-3-3zm-5.801 4.399c0-.44.36-.8.802-.8.44 0 .8.36.8.8v10.688c0 .442-.36.801-.8.801-.443 0-.802-.359-.802-.801V4.399zM11.2 3.994c0-.44.357-.799.8-.799s.8.359.8.799v11.602c0 .44-.357.8-.8.8s-.8-.36-.8-.8V3.994zm-4 .405c0-.44.359-.8.799-.8.443 0 .802.36.802.8v10.688c0 .442-.36.801-.802.801-.44 0-.799-.359-.799-.801V4.399zM3.199 6c0-.442.36-.8.802-.8.44 0 .799.358.799.8v7.195c0 .441-.359.8-.799.8-.443 0-.802-.36-.802-.8V6zM20.52 18.202c-.123.105-3.086 2.593-8.52 2.593-5.433 0-8.397-2.486-8.521-2.593-.335-.288-.375-.792-.086-1.128.285-.334.79-.375 1.125-.09.047.041 2.693 2.211 7.481 2.211 4.848 0 7.456-2.186 7.479-2.207.334-.289.839-.25 1.128.086.289.336.25.84-.086 1.128zm.281-5.007c0 .441-.36.8-.801.8-.441 0-.801-.36-.801-.8V6c0-.442.361-.8.801-.8.441 0 .801.357.801.8v7.195z",
  },
];

export function searchMcpCatalog(query: string): readonly McpCatalogEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/);
  return MCP_CATALOG.filter((entry) => words.every((word) => `${entry.name} ${entry.description}`.toLowerCase().includes(word)));
}

/** Build a new definition each time; a previous service's secret must never carry into another one. */
export function mcpCatalogDefinition(entry: McpCatalogEntry, token = ""): Extract<McpServerDefinition, { url: string }> {
  const value = token.trim().replace(/^Bearer(?:\s+|$)/i, "");
  if (entry.auth === "token" && (!value || /\s/.test(value) || value === MCP_SECRET_MASK)) throw new Error("Enter a valid personal access token.");
  return { name: entry.id, type: "http", url: entry.url, headers: entry.auth === "token" ? { Authorization: `Bearer ${value}` } : {} };
}

export function mcpCatalogAuthHint(entry: McpCatalogEntry, remote: boolean): string {
  if (entry.auth === "token") return "Use a personal access token with access to the repositories you want to work with.";
  return remote
    ? "After adding, finish sign-in in Milagre's MCP settings on the connected computer."
    : `Your browser opens if ${entry.name} needs you to sign in. Choose the account and access to allow.`;
}

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
