import { MCP_SECRET_MASK, type McpProvider } from "./mcp.ts";
import { CONNECTOR_PRESETS, type ConnectorCategory, type ConnectorPreset } from "./connector-catalog.ts";

export * from "./connector-catalog.ts";
import { providerName } from "./providers.mjs";

/** `signed-in` has a saved sign-in Milagre hasn't used yet this run; `connected` answered a tool list. */
/** `needs-app`: the server can't register Milagre by itself (Slack), so it needs the Client ID of an app made for it. */
export type ConnectorState = "connected" | "signed-in" | "needs-sign-in" | "needs-app" | "failed";
type ConnectorAccessGroup = { id?: string; name: string; off: string[] };

/** A remote MCP server Milagre signed in to once on this computer. `id` prefixes its tools for agents. */
export type ConnectorSummary = {
  id: string;
  name: string;
  /** `command` runs on the computer, one process shared by every Chat; `linear` is Milagre's own Linear sign-in; `email` its own mailboxes. */
  kind?: "url" | "command" | "linear" | "email";
  url: string;
  command?: string;
  args?: string[];
  /** Names of the environment variables a command connector starts with; their values never leave the computer. */
  env?: string[];
  /** Linear workspaces signed in, or mailbox addresses for the built-in Email connector. */
  workspaces?: string[];
  /** The built-in Email connector's mailboxes and the IMAP server each signs in to. */
  mailboxes?: { address: string; host: string; port: number }[];
  workspaceAccess?: (ConnectorAccessGroup & { id: string })[];
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
/** A mailbox for the built-in Email connector. Host and port default to the provider's IMAP server; username to the address. */
export type EmailConnectInput = { address: string; password: string; host?: string; port?: number; username?: string };

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
export const CONNECTOR_SIGNING_IN = "Finish signing in in your browser, then come back.";
export const CONNECTOR_ON_COMPUTER = "Add connectors and sign in from Milagre on the computer.";
export const CONNECTOR_SECRET_MASK = MCP_SECRET_MASK;

export function searchConnectorPresets(query: string, category?: ConnectorCategory): readonly ConnectorPreset[] {
  const words = query.trim().toLowerCase().split(/\s+/);
  return CONNECTOR_PRESETS.filter(
    (preset) => (!category || preset.category === category) && words.every((word) => `${preset.name} ${preset.description}`.toLowerCase().includes(word)),
  );
}

const sameUrl = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "");
const commandPackage = (preset: ConnectorPreset) => preset.url.slice("command:".length);

/** The preset a saved connector came from: by address (any region's) or, for a command connector, by the package it runs. */
export function connectorPreset(connector: Pick<ConnectorSummary, "url" | "command" | "args">): ConnectorPreset | null {
  if (connector.command)
    return CONNECTOR_PRESETS.find((preset) => preset.command && (connector.args ?? []).some((arg) => arg === commandPackage(preset))) ?? null;
  if (!connector.url) return null;
  return (
    CONNECTOR_PRESETS.find(
      (preset) => !preset.command && (sameUrl(preset.url, connector.url) || preset.regions?.some((region) => sameUrl(region.url, connector.url))),
    ) ?? null
  );
}

export type ConnectorPresetValues = { name: string; token?: string; clientId?: string; clientSecret?: string; region?: string; env?: Record<string, string> };

/** What a preset sends to `connectors:add`. A token becomes a bearer header; an app sends its client ID and secret; a command its environment. */
export function connectorPresetInput(
  preset: ConnectorPreset,
  { name, token = "", clientId = "", clientSecret = "", region, env = {} }: ConnectorPresetValues,
): ConnectorInput {
  const url = preset.regions?.find((item) => item.label === region)?.url ?? preset.url;
  if (preset.command) {
    const values: Record<string, string> = {};
    for (const field of preset.command.env) {
      const value = (env[field.name] ?? "").trim();
      if (!value) throw new Error(`Enter the ${field.label.toLowerCase()}.`);
      values[field.name] = value;
    }
    return { name, command: preset.command.command, args: [...preset.command.args], env: { ...values, ...preset.command.fixedEnv } };
  }
  if (preset.auth === "token") {
    const value = token.trim().replace(/^Bearer(?:\s+|$)/i, "");
    if (!value || /\s/.test(value)) throw new Error("Enter a valid access token.");
    return { name, url, headers: { Authorization: `Bearer ${value}` } };
  }
  if (preset.auth === "app") {
    if (!clientId.trim()) throw new Error(`Paste the Client ID of your ${preset.name} app.`);
    return { name, url, clientId: clientId.trim(), ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}) };
  }
  return { name, url };
}

/** How a preset signs in, in the words its gallery tile uses. */
export function connectorSignInLabel(preset: Pick<ConnectorPreset, "auth">): string {
  if (preset.auth === "token") return "Access token";
  if (preset.auth === "app") return "Your own app";
  if (preset.auth === "email") return "App password";
  if (preset.auth === "command") return "Runs on your computer";
  return "Sign in with browser";
}

export const connectorAccessKey = (provider: McpProvider, accountId: string) => `${provider}:${accountId}`;
export const connectorAllows = (connector: Pick<ConnectorSummary, "off">, provider: McpProvider, accountId: string) =>
  !connector.off.includes(connectorAccessKey(provider, accountId));

export function connectorAccessGroups(connector: ConnectorSummary): readonly ConnectorAccessGroup[] {
  return connector.workspaceAccess?.length ? connector.workspaceAccess : [{ name: connector.name, off: connector.off }];
}

/** The row's second line: the address's host, the command a command connector runs, or the Linear workspaces. */
export function connectorSubtitle(connector: ConnectorSummary): string {
  if (connector.kind === "command") return [connector.command, ...(connector.args ?? [])].join(" ");
  if (connector.kind === "linear") return `Built in · ${connector.workspaces?.length ? connector.workspaces.join(", ") : "Linear"}`;
  if (connector.kind === "email") return `Built in · ${connector.workspaces?.length ? connector.workspaces.join(", ") : "No mailboxes"}`;
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
export function connectorReach(
  connector: Pick<ConnectorSummary, "off" | "workspaceAccess" | "kind">,
  accounts: readonly { provider: McpProvider; accountId: string }[],
): string {
  if (
    connector.workspaceAccess?.some((workspace) =>
      accounts.some(({ provider, accountId }) => connectorAllows(connector, provider, accountId) && !connectorAllows(workspace, provider, accountId)),
    )
  )
    return connector.kind === "email" ? "By mailbox" : "By workspace";
  const on = accounts.filter((account) => connectorAllows(connector, account.provider, account.accountId)).length;
  if (!accounts.length || on === accounts.length) return "All accounts";
  return on ? `${on} of ${accounts.length} accounts` : "No accounts";
}

export const connectorAccountName = (account: { provider: McpProvider; label: string }) =>
  account.label && account.label !== providerName(account.provider) ? `${providerName(account.provider)} · ${account.label}` : providerName(account.provider);
