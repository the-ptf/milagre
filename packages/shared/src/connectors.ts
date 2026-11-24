import { MCP_CATALOG, MCP_SECRET_MASK, type McpCatalogEntry, type McpProvider } from "./mcp.ts";
import { providerName } from "./providers.mjs";

/** `signed-in` has a saved sign-in Milagre hasn't used yet this run; `connected` answered a tool list. */
/** `needs-app`: the server can't register Milagre by itself (Slack), so it needs the Client ID of an app made for it. */
export type ConnectorState = "connected" | "signed-in" | "needs-sign-in" | "needs-app" | "failed";

/** A remote MCP server Milagre signed in to once on this computer. `id` prefixes its tools for agents. */
export type ConnectorSummary = {
  id: string;
  name: string;
  /** `command` runs on the computer, one process shared by every Chat; `linear` is Milagre's own Linear sign-in. */
  kind?: "url" | "command" | "linear";
  url: string;
  command?: string;
  args?: string[];
  /** Names of the environment variables a command connector starts with; their values never leave the computer. */
  env?: string[];
  /** Linear workspaces signed in, for the built-in Linear connector. */
  workspaces?: string[];
  /** A command connector's process is running now. */
  running?: boolean;
  /** Set for servers without dynamic client registration (Slack): the OAuth app Milagre signs in as. */
  clientId: string | null;
  hasClientSecret: boolean;
  /** Names of the headers sent with every request (API keys); their values never leave the computer. */
  headers: string[];
  /** `provider:accountId` keys of the accounts this connector is turned off for. */
  off: string[];
  state: ConnectorState;
  problem?: string;
  tools?: number;
};

/** An address (`url`, with optional OAuth app or headers) or a `command` that starts the server on the computer. */
export type ConnectorInput = {
  name: string;
  url?: string;
  clientId?: string;
  clientSecret?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};
export type ConnectorUpdate = {
  name?: string;
  clientId?: string;
  clientSecret?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};
/** An Everywhere MCP server with an address, which can become a connector. */
export type ConnectorMovable = { name: string; url: string };

export type ConnectorTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
};

export const CONNECTORS_TITLE = "Connectors";
export const CONNECTORS_HINT = "Sign in once. Chats on every provider and account you allow use these tools.";
export const CONNECTOR_CALLBACK_URL = "http://localhost:47616/connectors/callback";
export const CONNECTOR_SIGNING_IN = "Finish signing in in your browser, then come back.";
export const CONNECTOR_ON_COMPUTER = "Add connectors and sign in from Milagre on the computer.";
export const CONNECTOR_SECRET_MASK = MCP_SECRET_MASK;

/** A catalog service as a connector. `app`: the server has no dynamic registration, so the user makes an app and pastes its client ID and secret. */
export type ConnectorPreset = Omit<McpCatalogEntry, "auth"> & { auth: McpCatalogEntry["auth"] | "app"; appUrl?: string; appSteps?: string };

const SLACK_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "search:read.users",
  "emoji:read",
  "files:read",
  "files:write",
  "chat:write",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "channels:read",
  "groups:read",
  "mpim:read",
  "im:read",
  "channels:write",
  "groups:write",
  "im:write",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  "canvases:read",
  "canvases:write",
  "users:read",
  "users:read.email",
  "lists:read",
  "lists:write",
];

/** The Slack app every workspace needs until Milagre's own app is in the Slack Marketplace: user scopes only, PKCE, rotating tokens. */
export const SLACK_APP_MANIFEST = {
  display_information: { name: "Milagre" },
  oauth_config: { redirect_urls: [CONNECTOR_CALLBACK_URL], scopes: { user: SLACK_SCOPES }, pkce_enabled: true },
  settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: true, is_mcp_enabled: true },
};

export const SLACK_PRESET: ConnectorPreset = {
  id: "slack",
  name: "Slack",
  description: "Messages, channels, canvases, and search.",
  url: "https://mcp.slack.com/mcp",
  auth: "app",
  docsUrl: "https://docs.slack.dev/ai/slack-mcp-server",
  appUrl: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(SLACK_APP_MANIFEST))}`,
  appSteps:
    "Slack only lets its own apps use this server. Create one for your workspace with the button, check that Agents › Slack Model Context Protocol (MCP) Server is on, then paste its Client ID and Client Secret from Basic Information.",
  iconPath:
    "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
};

export const CONNECTOR_PRESETS: readonly ConnectorPreset[] = [SLACK_PRESET, ...MCP_CATALOG];

export function searchConnectorPresets(query: string): readonly ConnectorPreset[] {
  const words = query.trim().toLowerCase().split(/\s+/);
  return CONNECTOR_PRESETS.filter((preset) => words.every((word) => `${preset.name} ${preset.description}`.toLowerCase().includes(word)));
}

/** The preset a saved connector came from, by address. */
export const connectorPreset = (connector: Pick<ConnectorSummary, "url">): ConnectorPreset | null =>
  CONNECTOR_PRESETS.find((preset) => preset.url.replace(/\/$/, "") === connector.url.replace(/\/$/, "")) ?? null;

/** What a preset sends to `connectors:add`. A token becomes a bearer header; an app sends its client ID and secret. */
export function connectorPresetInput(
  preset: ConnectorPreset,
  { name, token = "", clientId = "", clientSecret = "" }: { name: string; token?: string; clientId?: string; clientSecret?: string },
): ConnectorInput {
  if (preset.auth === "token") {
    const value = token.trim().replace(/^Bearer(?:\s+|$)/i, "");
    if (!value || /\s/.test(value)) throw new Error("Enter a valid personal access token.");
    return { name, url: preset.url, headers: { Authorization: `Bearer ${value}` } };
  }
  if (preset.auth === "app") {
    if (!clientId.trim()) throw new Error(`Paste the Client ID of your ${preset.name} app.`);
    return { name, url: preset.url, clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) };
  }
  return { name, url: preset.url };
}

export const connectorAccessKey = (provider: McpProvider, accountId: string) => `${provider}:${accountId}`;
export const connectorAllows = (connector: Pick<ConnectorSummary, "off">, provider: McpProvider, accountId: string) =>
  !connector.off.includes(connectorAccessKey(provider, accountId));

/** The row's second line: the address's host, the command a command connector runs, or the Linear workspaces. */
export function connectorSubtitle(connector: ConnectorSummary): string {
  if (connector.kind === "command") return [connector.command, ...(connector.args ?? [])].join(" ");
  if (connector.kind === "linear") return `Built in · ${connector.workspaces?.length ? connector.workspaces.join(", ") : "Linear"}`;
  try {
    return new URL(connector.url).host;
  } catch {
    return connector.url;
  }
}

/** The note after Everywhere servers moved here on their own. */
export function connectorMovedNote(names: readonly string[]): string {
  const list = names.length > 2 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join(" and ");
  return `${list} moved here from Everywhere. Each runs once on the computer for every Chat; sign in once where asked.`;
}

export function connectorStateLine(connector: ConnectorSummary): string {
  if (connector.state === "connected") return connector.tools === 1 ? "1 tool" : `${connector.tools ?? 0} tools`;
  if (connector.state === "signed-in") return "Signed in";
  if (connector.state === "needs-sign-in") return "Needs sign-in";
  if (connector.state === "needs-app") return "Needs its own app";
  return connector.problem ? `Failed: ${connector.problem}` : "Failed";
}

/** "All accounts", "2 of 3 accounts" or "No accounts", for the accounts listed. */
export function connectorReach(connector: Pick<ConnectorSummary, "off">, accounts: readonly { provider: McpProvider; accountId: string }[]): string {
  const on = accounts.filter((account) => connectorAllows(connector, account.provider, account.accountId)).length;
  if (!accounts.length || on === accounts.length) return "All accounts";
  return on ? `${on} of ${accounts.length} accounts` : "No accounts";
}

export const connectorAccountName = (account: { provider: McpProvider; label: string }) =>
  account.label && account.label !== providerName(account.provider) ? `${providerName(account.provider)} · ${account.label}` : providerName(account.provider);
