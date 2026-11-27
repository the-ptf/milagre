/** How a catalog entry signs in: `browser` (OAuth with dynamic registration), `token` (a bearer header), `app` (an OAuth app the user makes), `email` (Milagre's own IMAP connector) or `command` (a local process). */
export type ConnectorAuth = "browser" | "token" | "app" | "email" | "command";
export type ConnectorCategory = "builtin" | "team" | "developer" | "observability" | "search" | "business" | "design" | "email";

/** Gallery sections in order. */
export const CONNECTOR_CATEGORIES: readonly { id: ConnectorCategory; label: string }[] = [
  { id: "builtin", label: "Built in" },
  { id: "team", label: "Team" },
  { id: "developer", label: "Developer" },
  { id: "observability", label: "Observability" },
  { id: "search", label: "Search and web" },
  { id: "business", label: "Business" },
  { id: "design", label: "Design" },
  { id: "email", label: "Email" },
];

/** An environment variable a command preset asks for; `secret` values stay masked and never leave the computer. */
export type ConnectorPresetEnv = { name: string; label: string; placeholder?: string; secret?: boolean };

/** A catalog service. Icons are 24 × 24 paths from https://github.com/simple-icons/simple-icons, CC0 (licenses/simple-icons-LICENSE.md); empty draws the name's first letter. */
export type ConnectorPreset = {
  id: string;
  name: string;
  description: string;
  /** The MCP address; `command:<package>` for a command preset, `imap://` for the built-in Email connector. */
  url: string;
  auth: ConnectorAuth;
  category: ConnectorCategory;
  docsUrl: string;
  iconPath: string;
  tokenUrl?: string;
  appUrl?: string;
  appSteps?: string;
  /** Regional addresses, the first one the default. */
  regions?: readonly { label: string; url: string }[];
  command?: { command: string; args: readonly string[]; env: readonly ConnectorPresetEnv[]; fixedEnv: Readonly<Record<string, string>>; note: string };
};

export const CONNECTOR_CALLBACK_URL = "http://localhost:47616/connectors/callback";

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
  category: "team",
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

export const EMAIL_PRESET: ConnectorPreset = {
  id: "email",
  category: "builtin",
  name: "Email",
  description: "Sign-in codes and links from your inbox, read-only.",
  url: "imap://",
  auth: "email",
  docsUrl: "https://milagre.dev/docs",
  iconPath: "",
};

const MCP_PRESETS: readonly ConnectorPreset[] = [
  {
    id: "airtable",
    name: "Airtable",
    description: "Bases, tables, and records.",
    url: "https://mcp.airtable.com/mcp",
    auth: "browser",
    docsUrl: "https://support.airtable.com/docs/using-the-airtable-mcp-server",
    iconPath:
      "M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596zM.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z",
    category: "team",
  },
  {
    id: "asana",
    name: "Asana",
    description: "Tasks, projects, and goals.",
    url: "https://mcp.asana.com/v2/mcp",
    auth: "app",
    docsUrl: "https://developers.asana.com/docs/integrating-with-asanas-mcp-server",
    iconPath:
      "M18.78 12.653c-2.882 0-5.22 2.336-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.34 5.22-5.22-2.336-5.22-5.22-5.22zm-13.56 0c-2.88 0-5.22 2.337-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.338 5.22-5.22-2.336-5.22-5.22-5.22zm12-6.525c0 2.883-2.337 5.22-5.22 5.22-2.882 0-5.22-2.337-5.22-5.22 0-2.88 2.338-5.22 5.22-5.22 2.883 0 5.22 2.34 5.22 5.22z",
    category: "team",
    appUrl: "https://app.asana.com/0/my-apps",
    appSteps:
      "Asana's MCP server only takes apps you register. Create an app, choose MCP app, add the redirect URL below, then paste its Client ID and Client Secret.",
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
    category: "team",
  },
  {
    id: "axiom",
    name: "Axiom",
    description: "Logs and traces.",
    url: "https://mcp.axiom.co/mcp",
    auth: "browser",
    docsUrl: "https://axiom.co/docs/console/intelligence/mcp-server",
    iconPath: "",
    category: "observability",
    regions: [
      {
        label: "US",
        url: "https://mcp.axiom.co/mcp",
      },
      {
        label: "EU",
        url: "https://mcp.eu.axiom.co/mcp",
      },
    ],
  },
  {
    id: "box",
    name: "Box",
    description: "Files, search, and Box AI answers.",
    url: "https://mcp.box.com",
    auth: "app",
    docsUrl: "https://developer.box.com/guides/box-mcp/remote/",
    iconPath:
      "M.959 5.523c-.54 0-.959.42-.959.899v7.549a4.59 4.59 0 004.613 4.494 4.717 4.717 0 004.135-2.457c.779 1.438 2.337 2.457 4.074 2.457 2.577 0 4.674-2.037 4.674-4.613.06-2.457-2.037-4.495-4.613-4.495-1.738 0-3.295.959-4.074 2.397-.78-1.438-2.338-2.397-4.135-2.397-1.079 0-2.038.36-2.817.899V6.422a.92.92 0 00-.898-.899zM17.602 9.26a.95.95 0 00-.704.158c-.36.3-.479.899-.18 1.318l2.397 3.116-2.396 3.115c-.3.42-.24.96.18 1.26.419.3 1.016.298 1.316-.122l2.039-2.636 2.096 2.697c.3.36.899.419 1.318.12.36-.3.42-.84.121-1.259l-2.338-3.115 2.338-3.057c.3-.419.298-1.018-.121-1.318-.48-.3-1.019-.24-1.318.18l-2.096 2.576-2.04-2.695c-.149-.18-.373-.3-.612-.338zM4.613 11.154c1.558 0 2.817 1.26 2.817 2.758 0 1.558-1.259 2.756-2.817 2.756-1.558 0-2.816-1.198-2.816-2.756 0-1.498 1.258-2.758 2.816-2.758zm8.27 0c1.558 0 2.816 1.26 2.816 2.758-.06 1.558-1.318 2.756-2.816 2.756-1.558 0-2.817-1.198-2.817-2.756 0-1.498 1.259-2.758 2.817-2.758Z",
    category: "team",
    appUrl: "https://developer.box.com/guides/box-mcp/remote/",
    appSteps: "A Box admin creates a Box MCP server integration in the Admin Console with the redirect URL below, then shares its Client ID and Client Secret.",
  },
  {
    id: "canva",
    name: "Canva",
    description: "Designs, brand kits, and exports.",
    url: "https://mcp.canva.com/mcp",
    auth: "browser",
    docsUrl: "https://www.canva.com/help/mcp-agent-setup/",
    iconPath: "",
    category: "design",
  },
  {
    id: "clickup",
    name: "ClickUp",
    description: "Tasks, docs, and spaces.",
    url: "https://mcp.clickup.com/mcp",
    auth: "browser",
    docsUrl: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
    iconPath:
      "M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z",
    category: "team",
  },
  {
    id: "close",
    name: "Close",
    description: "CRM leads and activities.",
    url: "https://mcp.close.com/mcp",
    auth: "browser",
    docsUrl: "https://developer.close.com/mcp",
    iconPath: "",
    category: "business",
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
    category: "developer",
  },
  {
    id: "cloudinary",
    name: "Cloudinary",
    description: "Images, videos, and transformations.",
    url: "https://asset-management.mcp.cloudinary.com/mcp",
    auth: "browser",
    docsUrl: "https://cloudinary.com/documentation/cloudinary_llm_mcp",
    iconPath:
      "M24 14.8598c0 2.1729-1.3757 3.974-3.5903 4.6996l-.0995.0318V17.989c1.3777-.5805 2.1869-1.7275 2.1869-3.1291-.0072-2-1.6087-3.6288-3.6082-3.6699h-.5964l-.1432-.5686c-.7025-2.8996-3.2886-4.9489-6.2721-4.97a6.3915 6.3915 0 0 0-5.811 3.664l-.1828.3757-.4175.0437a4.4311 4.4311 0 0 0-3.3052 2.088c-1.2803 2.0856-.6274 4.8143 1.4583 6.0947v1.6897h-.01l-.149-.0675a5.9402 5.9402 0 0 1-3.3658-4.3494c-.5787-3.2291 1.57-6.3161 4.7991-6.8948a7.8766 7.8766 0 0 1 6.9839-4.149c3.4724.025 6.535 2.28 7.5901 5.5883 2.5789.3366 4.5138 2.5245 4.5327 5.1251zm-15.3176-1.322h.5647a.0656.0656 0 0 0 .0457-.1113L7.084 11.2158l-.0007-.0007a.0656.0656 0 0 0-.0927.0007L4.78 13.4265a.0656.0656 0 0 0 .0477.1113h.5566a.0656.0656 0 0 1 .0657.0656v5.0574c0 .6588.534 1.1928 1.1928 1.1928H9.247a.0656.0656 0 0 0 .0457-.1113l-.33-.33a1.1928 1.1928 0 0 1-.348-.839v-4.97a.0676.0676 0 0 1 .0676-.0655zm9.769 2.5466h.5667a.0655.0655 0 0 0 .0457-.1133l-2.2107-2.2087-.0015-.0015a.0636.0636 0 0 0-.0899.0015L14.551 15.971a.0657.0657 0 0 0 .0457.1133h.5567a.0656.0656 0 0 1 .0656.0656v2.5108c0 .6588.534 1.1928 1.1928 1.1928h2.6063a.0655.0655 0 0 0 .0457-.1113l-.33-.33a1.1928 1.1928 0 0 1-.348-.839V16.15a.0656.0656 0 0 1 .0657-.0656zm-4.8844-1.2743h.5646a.0656.0656 0 0 0 .0477-.1114l-2.2107-2.2027-.0006-.0006a.0656.0656 0 0 0-.0928.0006l-2.2087 2.2068a.0656.0656 0 0 0 .0457.1113h.5626a.0676.0676 0 0 1 .0657.0676v3.7791c0 .6588.534 1.1928 1.1928 1.1928h2.5983a.0656.0656 0 0 0 .0477-.1113l-.332-.33a1.193 1.193 0 0 1-.346-.839v-3.6956c0-.0366.0291-.0665.0657-.0676z",
    category: "design",
  },
  {
    id: "context7",
    name: "Context7",
    description: "Current docs for any library.",
    url: "https://mcp.context7.com/mcp",
    auth: "browser",
    docsUrl: "https://github.com/upstash/context7",
    iconPath: "",
    category: "developer",
  },
  {
    id: "datadog",
    name: "Datadog",
    description: "Logs, metrics, monitors, and incidents.",
    url: "https://mcp.datadoghq.com/v1/mcp",
    auth: "browser",
    docsUrl: "https://docs.datadoghq.com/mcp_server/setup/",
    iconPath:
      "M19.57 17.04l-1.997-1.316-1.665 2.782-1.937-.567-1.706 2.604.087.82 9.274-1.71-.538-5.794zm-8.649-2.498l1.488-.204c.241.108.409.15.697.223.45.117.97.23 1.741-.16.18-.088.553-.43.704-.625l6.096-1.106.622 7.527-10.444 1.882zm11.325-2.712l-.602.115L20.488 0 .789 2.285l2.427 19.693 2.306-.334c-.184-.263-.471-.581-.96-.989-.68-.564-.44-1.522-.039-2.127.53-1.022 3.26-2.322 3.106-3.956-.056-.594-.15-1.368-.702-1.898-.02.22.017.432.017.432s-.227-.289-.34-.683c-.112-.15-.2-.199-.319-.4-.085.233-.073.503-.073.503s-.186-.437-.216-.807c-.11.166-.137.48-.137.48s-.241-.69-.186-1.062c-.11-.323-.436-.965-.343-2.424.6.421 1.924.321 2.44-.439.171-.251.288-.939-.086-2.293-.24-.868-.835-2.16-1.066-2.651l-.028.02c.122.395.374 1.223.47 1.625.293 1.218.372 1.642.234 2.204-.116.488-.397.808-1.107 1.165-.71.358-1.653-.514-1.713-.562-.69-.55-1.224-1.447-1.284-1.883-.062-.477.275-.763.445-1.153-.243.07-.514.192-.514.192s.323-.334.722-.624c.165-.109.262-.178.436-.323a9.762 9.762 0 0 0-.456.003s.42-.227.855-.392c-.318-.014-.623-.003-.623-.003s.937-.419 1.678-.727c.509-.208 1.006-.147 1.286.257.367.53.752.817 1.569.996.501-.223.653-.337 1.284-.509.554-.61.99-.688.99-.688s-.216.198-.274.51c.314-.249.66-.455.66-.455s-.134.164-.259.426l.03.043c.366-.22.797-.394.797-.394s-.123.156-.268.358c.277-.002.838.012 1.056.037 1.285.028 1.552-1.374 2.045-1.55.618-.22.894-.353 1.947.68.903.888 1.609 2.477 1.259 2.833-.294.295-.874-.115-1.516-.916a3.466 3.466 0 0 1-.716-1.562 1.533 1.533 0 0 0-.497-.85s.23.51.23.96c0 .246.03 1.165.424 1.68-.039.076-.057.374-.1.43-.458-.554-1.443-.95-1.604-1.067.544.445 1.793 1.468 2.273 2.449.453.927.186 1.777.416 1.997.065.063.976 1.197 1.15 1.767.306.994.019 2.038-.381 2.685l-1.117.174c-.163-.045-.273-.068-.42-.153.08-.143.241-.5.243-.572l-.063-.111c-.348.492-.93.97-1.414 1.245-.633.359-1.363.304-1.838.156-1.348-.415-2.623-1.327-2.93-1.566 0 0-.01.191.048.234.34.383 1.119 1.077 1.872 1.56l-1.605.177.759 5.908c-.337.048-.39.071-.757.124-.325-1.147-.946-1.895-1.624-2.332-.599-.384-1.424-.47-2.214-.314l-.05.059a2.851 2.851 0 0 1 1.863.444c.654.413 1.181 1.481 1.375 2.124.248.822.42 1.7-.248 2.632-.476.662-1.864 1.028-2.986.237.3.481.705.876 1.25.95.809.11 1.577-.03 2.106-.574.452-.464.69-1.434.628-2.456l.714-.104.258 1.834 11.827-1.424zM15.05 6.848c-.034.075-.085.125-.007.37l.004.014.013.032.032.073c.14.287.295.558.552.696.067-.011.136-.019.207-.023.242-.01.395.028.492.08.009-.048.01-.119.005-.222-.018-.364.072-.982-.626-1.308-.264-.122-.634-.084-.757.068a.302.302 0 0 1 .058.013c.186.066.06.13.027.207m1.958 3.392c-.092-.05-.52-.03-.821.005-.574.068-1.193.267-1.328.372-.247.191-.135.523.047.66.511.382.96.638 1.432.575.29-.038.546-.497.728-.914.124-.288.124-.598-.058-.698m-5.077-2.942c.162-.154-.805-.355-1.556.156-.554.378-.571 1.187-.041 1.646.053.046.096.078.137.104a4.77 4.77 0 0 1 1.396-.412c.113-.125.243-.345.21-.745-.044-.542-.455-.456-.146-.749",
    category: "observability",
    regions: [
      {
        label: "US1",
        url: "https://mcp.datadoghq.com/v1/mcp",
      },
      {
        label: "US3",
        url: "https://mcp.us3.datadoghq.com/v1/mcp",
      },
      {
        label: "US5",
        url: "https://mcp.us5.datadoghq.com/v1/mcp",
      },
      {
        label: "EU",
        url: "https://mcp.datadoghq.eu/v1/mcp",
      },
      {
        label: "AP1",
        url: "https://mcp.ap1.datadoghq.com/v1/mcp",
      },
    ],
  },
  {
    id: "email_mcp",
    name: "Email MCP server",
    description: "IMAP mail tools, including waiting for a sign-in code. Read-only.",
    url: "command:@codefuturist/email-mcp",
    auth: "command",
    docsUrl: "https://github.com/codefuturist/email-mcp",
    iconPath: "",
    category: "email",
    command: {
      command: "npx",
      args: ["-y", "@codefuturist/email-mcp", "stdio"],
      env: [
        {
          name: "MCP_EMAIL_ADDRESS",
          label: "Address",
          placeholder: "you@example.com",
        },
        {
          name: "MCP_EMAIL_PASSWORD",
          label: "App password",
          secret: true,
        },
        {
          name: "MCP_EMAIL_IMAP_HOST",
          label: "IMAP server",
          placeholder: "imap.gmail.com",
        },
        {
          name: "MCP_EMAIL_SMTP_HOST",
          label: "SMTP server",
          placeholder: "smtp.gmail.com",
        },
      ],
      fixedEnv: {
        MCP_EMAIL_READ_ONLY: "true",
        MCP_EMAIL_VERIFICATION_AUTO_COPY: "false",
        MCP_EMAIL_VERIFICATION_NOTIFY: "false",
      },
      note: "Runs on this computer with Node 24 or later. Milagre starts it read-only, with clipboard copying off.",
    },
  },
  {
    id: "exa",
    name: "Exa",
    description: "Web and code search.",
    url: "https://mcp.exa.ai/mcp",
    auth: "browser",
    docsUrl: "https://docs.exa.ai/reference/exa-mcp",
    iconPath: "",
    category: "search",
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    description: "Scrape and crawl websites.",
    url: "https://mcp.firecrawl.dev/v2/mcp-oauth",
    auth: "browser",
    docsUrl: "https://docs.firecrawl.dev/mcp-server",
    iconPath: "",
    category: "search",
  },
  {
    id: "fireflies",
    name: "Fireflies",
    description: "Meeting transcripts and notes.",
    url: "https://api.fireflies.ai/mcp",
    auth: "browser",
    docsUrl: "https://docs.fireflies.ai/getting-started/mcp-configuration",
    iconPath: "",
    category: "team",
  },
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
    category: "developer",
  },
  {
    id: "granola",
    name: "Granola",
    description: "Meeting notes.",
    url: "https://mcp.granola.ai/mcp",
    auth: "browser",
    docsUrl: "https://docs.granola.ai/help-center/sharing/integrations/mcp",
    iconPath: "",
    category: "team",
  },
  {
    id: "honeycomb",
    name: "Honeycomb",
    description: "Traces, queries, and boards.",
    url: "https://mcp.honeycomb.io/mcp",
    auth: "browser",
    docsUrl: "https://docs.honeycomb.io/integrations/mcp/configuration-guide/",
    iconPath: "",
    category: "observability",
    regions: [
      {
        label: "US",
        url: "https://mcp.honeycomb.io/mcp",
      },
      {
        label: "EU",
        url: "https://mcp.eu1.honeycomb.io/mcp",
      },
    ],
  },
  {
    id: "hubspot",
    name: "HubSpot",
    description: "CRM contacts, companies, and deals.",
    url: "https://mcp.hubspot.com/",
    auth: "app",
    docsUrl: "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
    iconPath:
      "M18.164 7.93V5.084a2.198 2.198 0 001.267-1.978v-.067A2.2 2.2 0 0017.238.845h-.067a2.2 2.2 0 00-2.193 2.193v.067a2.196 2.196 0 001.252 1.973l.013.006v2.852a6.22 6.22 0 00-2.969 1.31l.012-.01-7.828-6.095A2.497 2.497 0 104.3 4.656l-.012.006 7.697 5.991a6.176 6.176 0 00-1.038 3.446c0 1.343.425 2.588 1.147 3.607l-.013-.02-2.342 2.343a1.968 1.968 0 00-.58-.095h-.002a2.033 2.033 0 102.033 2.033 1.978 1.978 0 00-.1-.595l.005.014 2.317-2.317a6.247 6.247 0 104.782-11.134l-.036-.005zm-.964 9.378a3.206 3.206 0 113.215-3.207v.002a3.206 3.206 0 01-3.207 3.207z",
    category: "business",
    appUrl: "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
    appSteps: "In HubSpot, open Development › MCP Connectors and create one with the redirect URL below, then paste its Client ID and Client Secret.",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    description: "Models, datasets, Spaces, and papers.",
    url: "https://huggingface.co/mcp",
    auth: "browser",
    docsUrl: "https://huggingface.co/docs/hub/hf-mcp-server",
    iconPath:
      "M12.025 1.13c-5.77 0-10.449 4.647-10.449 10.378 0 1.112.178 2.181.503 3.185.064-.222.203-.444.416-.577a.96.96 0 0 1 .524-.15c.293 0 .584.124.84.284.278.173.48.408.71.694.226.282.458.611.684.951v-.014c.017-.324.106-.622.264-.874s.403-.487.762-.543c.3-.047.596.06.787.203s.31.313.4.467c.15.257.212.468.233.542.01.026.653 1.552 1.657 2.54.616.605 1.01 1.223 1.082 1.912.055.537-.096 1.059-.38 1.572.637.121 1.294.187 1.967.187.657 0 1.298-.063 1.921-.178-.287-.517-.44-1.041-.384-1.581.07-.69.465-1.307 1.081-1.913 1.004-.987 1.647-2.513 1.657-2.539.021-.074.083-.285.233-.542.09-.154.208-.323.4-.467a1.08 1.08 0 0 1 .787-.203c.359.056.604.29.762.543s.247.55.265.874v.015c.225-.34.457-.67.683-.952.23-.286.432-.52.71-.694.257-.16.547-.284.84-.285a.97.97 0 0 1 .524.151c.228.143.373.388.43.625l.006.04a10.3 10.3 0 0 0 .534-3.273c0-5.731-4.678-10.378-10.449-10.378M8.327 6.583a1.5 1.5 0 0 1 .713.174 1.487 1.487 0 0 1 .617 2.013c-.183.343-.762-.214-1.102-.094-.38.134-.532.914-.917.71a1.487 1.487 0 0 1 .69-2.803m7.486 0a1.487 1.487 0 0 1 .689 2.803c-.385.204-.536-.576-.916-.71-.34-.12-.92.437-1.103.094a1.487 1.487 0 0 1 .617-2.013 1.5 1.5 0 0 1 .713-.174m-10.68 1.55a.96.96 0 1 1 0 1.921.96.96 0 0 1 0-1.92m13.838 0a.96.96 0 1 1 0 1.92.96.96 0 0 1 0-1.92M8.489 11.458c.588.01 1.965 1.157 3.572 1.164 1.607-.007 2.984-1.155 3.572-1.164.196-.003.305.12.305.454 0 .886-.424 2.328-1.563 3.202-.22-.756-1.396-1.366-1.63-1.32q-.011.001-.02.006l-.044.026-.01.008-.03.024q-.018.017-.035.036l-.032.04a1 1 0 0 0-.058.09l-.014.025q-.049.088-.11.19a1 1 0 0 1-.083.116 1.2 1.2 0 0 1-.173.18q-.035.029-.075.058a1.3 1.3 0 0 1-.251-.243 1 1 0 0 1-.076-.107c-.124-.193-.177-.363-.337-.444-.034-.016-.104-.008-.2.022q-.094.03-.216.087-.06.028-.125.063l-.13.074q-.067.04-.136.086a3 3 0 0 0-.135.096 3 3 0 0 0-.26.219 2 2 0 0 0-.12.121 2 2 0 0 0-.106.128l-.002.002a2 2 0 0 0-.09.132l-.001.001a1.2 1.2 0 0 0-.105.212q-.013.036-.024.073c-1.139-.875-1.563-2.317-1.563-3.203 0-.334.109-.457.305-.454m.836 10.354c.824-1.19.766-2.082-.365-3.194-1.13-1.112-1.789-2.738-1.789-2.738s-.246-.945-.806-.858-.97 1.499.202 2.362c1.173.864-.233 1.45-.685.64-.45-.812-1.683-2.896-2.322-3.295s-1.089-.175-.938.647 2.822 2.813 2.562 3.244-1.176-.506-1.176-.506-2.866-2.567-3.49-1.898.473 1.23 2.037 2.16c1.564.932 1.686 1.178 1.464 1.53s-3.675-2.511-4-1.297c-.323 1.214 3.524 1.567 3.287 2.405-.238.839-2.71-1.587-3.216-.642-.506.946 3.49 2.056 3.522 2.064 1.29.33 4.568 1.028 5.713-.624m5.349 0c-.824-1.19-.766-2.082.365-3.194 1.13-1.112 1.789-2.738 1.789-2.738s.246-.945.806-.858.97 1.499-.202 2.362c-1.173.864.233 1.45.685.64.451-.812 1.683-2.896 2.322-3.295s1.089-.175.938.647-2.822 2.813-2.562 3.244 1.176-.506 1.176-.506 2.866-2.567 3.49-1.898-.473 1.23-2.037 2.16c-1.564.932-1.686 1.178-1.464 1.53s3.675-2.511 4-1.297c.323 1.214-3.524 1.567-3.287 2.405.238.839 2.71-1.587 3.216-.642.506.946-3.49 2.056-3.522 2.064-1.29.33-4.568 1.028-5.713-.624",
    category: "developer",
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
    category: "business",
  },
  {
    id: "jam",
    name: "Jam",
    description: "Bug reports with console and network logs.",
    url: "https://mcp.jam.dev/mcp",
    auth: "browser",
    docsUrl: "https://jam.dev/docs/debug-a-jam/mcp",
    iconPath: "",
    category: "team",
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
    category: "builtin",
  },
  {
    id: "microsoft365",
    name: "Microsoft 365 mail",
    description: "Outlook and Microsoft 365 mail, read-only.",
    url: "command:@softeria/ms-365-mcp-server",
    auth: "command",
    docsUrl: "https://github.com/Softeria/ms-365-mcp-server",
    iconPath: "",
    category: "email",
    command: {
      command: "npx",
      args: ["-y", "@softeria/ms-365-mcp-server", "--preset", "mail", "--read-only"],
      env: [],
      fixedEnv: {},
      note: "The first time, ask an agent to sign in: it shows a Microsoft code to enter in your browser.",
    },
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
    category: "team",
  },
  {
    id: "monday",
    name: "monday.com",
    description: "Boards, items, and updates.",
    url: "https://mcp.monday.com/mcp",
    auth: "browser",
    docsUrl: "https://developer.monday.com/api-reference/docs/integrate-with-monday-mcp",
    iconPath: "",
    category: "team",
  },
  {
    id: "neon",
    name: "Neon",
    description: "Postgres databases, branches, and SQL queries.",
    url: "https://mcp.neon.tech/mcp",
    auth: "browser",
    docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
    iconPath: "M24 0V24l-9.365-8.045V24H0V0ZM2.942 21.087h8.751V9.563l9.365 8.204V2.919L2.942 2.914Z",
    category: "developer",
  },
  {
    id: "netlify",
    name: "Netlify",
    description: "Sites, deploys, and logs.",
    url: "https://mcp.netlify.com/mcp",
    auth: "browser",
    docsUrl: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/",
    iconPath:
      "m9.793 12.405 10.299 3.13c.347.106.561.053.775-.161l2.943-2.916a.616.616 0 0 0 0-.91l-2.943-2.915c-.214-.214-.428-.268-.776-.161l-10.298 3.13c-.428.133-.428.668 0 .802m-1.846 1.391L7.92 19.36c0 .562.107.855.374 1.123l3.29 3.316c.268.268.589.268.83 0l2.835-2.835c.268-.267.268-.562 0-.83l-6.607-6.606c-.294-.295-.695-.134-.695.267m0-3.585c-.027.402.401.562.696.268l6.607-6.607c.267-.268.267-.589 0-.83L12.415.18c-.24-.24-.562-.24-.83 0l-3.29 3.317c-.267.267-.374.481-.374.83zm-4.092 5.03c-.268.268-.562.268-.83 0L.19 12.405c-.267-.24-.267-.562 0-.83L3.025 8.74c.268-.267.562-.267.83 0l2.835 2.835c.267.268.267.589 0 .83z",
    category: "developer",
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
    category: "team",
  },
  {
    id: "pagerduty",
    name: "PagerDuty",
    description: "Incidents, services, and on-call.",
    url: "https://mcp.pagerduty.com/mcp",
    auth: "app",
    docsUrl: "https://docs.pagerduty.com/ai-automation/advance/pagerduty-mcp-server",
    iconPath:
      "M16.965 1.18C15.085.164 13.769 0 10.683 0H3.73v14.55h6.926c2.743 0 4.8-.164 6.61-1.37 1.975-1.303 3.004-3.484 3.004-6.007 0-2.716-1.262-4.896-3.305-5.994zm-5.5 10.326h-4.21V3.113l3.977-.027c3.62-.028 5.43 1.234 5.43 4.128 0 3.113-2.248 4.292-5.197 4.292zM3.73 17.61h3.525V24H3.73Z",
    category: "observability",
    appUrl: "https://docs.pagerduty.com/ai-automation/advance/pagerduty-mcp-server",
    appSteps: "Register an OAuth app in PagerDuty (Integrations › App Registration) with the redirect URL below, then paste its Client ID and Client Secret.",
    regions: [
      {
        label: "US",
        url: "https://mcp.pagerduty.com/mcp",
      },
      {
        label: "EU",
        url: "https://mcp.eu.pagerduty.com/mcp",
      },
    ],
  },
  {
    id: "paypal",
    name: "PayPal",
    description: "Orders, invoices, and payments.",
    url: "https://mcp.paypal.com/mcp",
    auth: "browser",
    docsUrl: "https://developer.paypal.com/docsai/developer/tools/ai/mcp-quickstart",
    iconPath:
      "M15.607 4.653H8.941L6.645 19.251H1.82L4.862 0h7.995c3.754 0 6.375 2.294 6.473 5.513-.648-.478-2.105-.86-3.722-.86m6.57 5.546c0 3.41-3.01 6.853-6.958 6.853h-2.493L11.595 24H6.74l1.845-11.538h3.592c4.208 0 7.346-3.634 7.153-6.949a5.24 5.24 0 0 1 2.848 4.686M9.653 5.546h6.408c.907 0 1.942.222 2.363.541-.195 2.741-2.655 5.483-6.441 5.483H8.714Z",
    category: "business",
  },
  {
    id: "planetscale",
    name: "PlanetScale",
    description: "Databases, branches, and insights.",
    url: "https://mcp.pscale.dev/mcp/planetscale",
    auth: "browser",
    docsUrl: "https://planetscale.com/docs/connect/mcp",
    iconPath:
      "M0 12C0 5.373 5.373 0 12 0c4.873 0 9.067 2.904 10.947 7.077l-15.87 15.87a11.981 11.981 0 0 1-1.935-1.099L14.99 12H12l-8.485 8.485A11.962 11.962 0 0 1 0 12Zm12.004 12L24 12.004C23.998 18.628 18.628 23.998 12.004 24Z",
    category: "developer",
  },
  {
    id: "postman",
    name: "Postman",
    description: "Collections, APIs, and workspaces.",
    url: "https://mcp.postman.com/mcp",
    auth: "browser",
    docsUrl: "https://learning.postman.com/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server/",
    iconPath:
      "M13.527.099C6.955-.744.942 3.9.099 10.473c-.843 6.572 3.8 12.584 10.373 13.428 6.573.843 12.587-3.801 13.428-10.374C24.744 6.955 20.101.943 13.527.099zm2.471 7.485a.855.855 0 0 0-.593.25l-4.453 4.453-.307-.307-.643-.643c4.389-4.376 5.18-4.418 5.996-3.753zm-4.863 4.861l4.44-4.44a.62.62 0 1 1 .847.903l-4.699 4.125-.588-.588zm.33.694l-1.1.238a.06.06 0 0 1-.067-.032.06.06 0 0 1 .01-.073l.645-.645.512.512zm-2.803-.459l1.172-1.172.879.878-1.979.426a.074.074 0 0 1-.085-.039.072.072 0 0 1 .013-.093zm-3.646 6.058a.076.076 0 0 1-.069-.083.077.077 0 0 1 .022-.046h.002l.946-.946 1.222 1.222-2.123-.147zm2.425-1.256a.228.228 0 0 0-.117.256l.203.865a.125.125 0 0 1-.211.117h-.003l-.934-.934-.294-.295 3.762-3.758 1.82-.393.874.874c-1.255 1.102-2.971 2.201-5.1 3.268zm5.279-3.428h-.002l-.839-.839 4.699-4.125a.952.952 0 0 0 .119-.127c-.148 1.345-2.029 3.245-3.977 5.091zm3.657-6.46l-.003-.002a1.822 1.822 0 0 1 2.459-2.684l-1.61 1.613a.119.119 0 0 0 0 .169l1.247 1.247a1.817 1.817 0 0 1-2.093-.343zm2.578 0a1.714 1.714 0 0 1-.271.218h-.001l-1.207-1.207 1.533-1.533c.661.72.637 1.832-.054 2.522zM18.855 6.05a.143.143 0 0 0-.053.157.416.416 0 0 1-.053.45.14.14 0 0 0 .023.197.141.141 0 0 0 .084.03.14.14 0 0 0 .106-.05.691.691 0 0 0 .087-.751.138.138 0 0 0-.194-.033z",
    category: "developer",
  },
  {
    id: "prisma",
    name: "Prisma",
    description: "Prisma Postgres databases.",
    url: "https://mcp.prisma.io/mcp",
    auth: "browser",
    docsUrl: "https://www.prisma.io/docs/postgres/integrations/mcp-server",
    iconPath:
      "M21.8068 18.2848L13.5528.7565c-.207-.4382-.639-.7273-1.1286-.7541-.5023-.0293-.9523.213-1.2062.6253L2.266 15.1271c-.2773.4518-.2718 1.0091.0158 1.4555l4.3759 6.7786c.2608.4046.7127.6388 1.1823.6388.1332 0 .267-.0188.3987-.0577l12.7019-3.7568c.3891-.1151.7072-.3904.8737-.7553s.1633-.7828-.0075-1.1454zm-1.8481.7519L9.1814 22.2242c-.3292.0975-.6448-.1873-.5756-.5194l3.8501-18.4386c.072-.3448.5486-.3996.699-.0803l7.1288 15.138c.1344.2856-.019.6224-.325.7128z",
    category: "developer",
  },
  {
    id: "render",
    name: "Render",
    description: "Services, databases, and logs.",
    url: "https://mcp.render.com/mcp",
    auth: "token",
    docsUrl: "https://render.com/docs/mcp-server",
    iconPath:
      "M18.263.007c-3.121-.147-5.744 2.109-6.192 5.082-.018.138-.045.272-.067.405-.696 3.703-3.936 6.507-7.827 6.507-1.388 0-2.691-.356-3.825-.979a.2024.2024 0 0 0-.302.178V24H12v-8.999c0-1.656 1.338-3 2.987-3h2.988c3.382 0 6.103-2.817 5.97-6.244-.12-3.084-2.61-5.603-5.682-5.75",
    category: "developer",
    tokenUrl: "https://dashboard.render.com/u/settings#api-keys",
  },
  {
    id: "sanity",
    name: "Sanity",
    description: "Content, documents, and schemas.",
    url: "https://mcp.sanity.io",
    auth: "browser",
    docsUrl: "https://www.sanity.io/docs/ai/mcp-server",
    iconPath:
      "m23.327 15.205-.893-1.555-4.321 2.632 4.799-6.11.726-.426-.179-.27.33-.421-1.515-1.261-.693.883-13.992 8.186 5.173-6.221 9.636-5.282-.915-1.769-5.248 2.876 2.584-3.106-1.481-1.305-5.816 6.994-5.777 3.168 4.423-5.847 2.771-1.442-.88-1.789-8.075 4.203L6.186 4.43 4.648 3.198 0 9.349l.072.058.868 1.768 5.153-2.683-4.696 6.207.77.617.458.885 5.425-2.974-5.974 7.185 1.481 1.304.297-.358 14.411-8.459-4.785 6.094.078.065-.007.005.992 1.726 6.364-3.877-2.451 3.954 1.642 1.077L24 15.648z",
    category: "developer",
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
    category: "observability",
  },
  {
    id: "square",
    name: "Square",
    description: "Payments, orders, and catalog.",
    url: "https://mcp.squareup.com/mcp",
    auth: "browser",
    docsUrl: "https://developer.squareup.com/docs/mcp",
    iconPath:
      "M4.01 0A4.01 4.01 0 000 4.01v15.98c0 2.21 1.8 4 4.01 4.01h15.98C22.2 24 24 22.2 24 19.99V4A4.01 4.01 0 0019.99 0H4zm1.62 4.36h12.74c.7 0 1.26.57 1.26 1.27v12.74c0 .7-.56 1.27-1.26 1.27H5.63c-.7 0-1.26-.57-1.26-1.27V5.63a1.27 1.27 0 011.26-1.27zm3.83 4.35a.73.73 0 00-.73.73v5.09c0 .4.32.72.72.72h5.1a.73.73 0 00.73-.72V9.44a.73.73 0 00-.73-.73h-5.1Z",
    category: "business",
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
    category: "business",
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
    category: "developer",
  },
  {
    id: "tavily",
    name: "Tavily",
    description: "Web search and page extraction.",
    url: "https://mcp.tavily.com/mcp/",
    auth: "browser",
    docsUrl: "https://docs.tavily.com/documentation/mcp",
    iconPath: "",
    category: "search",
  },
  {
    id: "terraform",
    name: "Terraform",
    description: "Registry modules and HCP Terraform workspaces.",
    url: "https://mcp.terraform.io/mcp",
    auth: "token",
    docsUrl: "https://github.com/hashicorp/terraform-mcp-server",
    iconPath: "M1.44 0v7.575l6.561 3.79V3.787zm21.12 4.227l-6.561 3.791v7.574l6.56-3.787zM8.72 4.23v7.575l6.561 3.787V8.018zm0 8.405v7.575L15.28 24v-7.578z",
    category: "developer",
    tokenUrl: "https://app.terraform.io/app/settings/tokens",
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
    category: "team",
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
    category: "developer",
  },
  {
    id: "vercel",
    name: "Vercel",
    description: "Projects, deployments, and deployment logs.",
    url: "https://mcp.vercel.com",
    auth: "browser",
    docsUrl: "https://vercel.com/docs/agent-resources/vercel-mcp",
    iconPath: "m12 1.608 12 20.784H0Z",
    category: "developer",
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
    category: "developer",
  },
  {
    id: "wix",
    name: "Wix",
    description: "Sites and business data.",
    url: "https://mcp.wix.com/mcp",
    auth: "browser",
    docsUrl: "https://dev.wix.com/docs/sdk/articles/use-the-wix-mcp/about-the-wix-mcp",
    iconPath:
      "m0 7.354 2.113 9.292h.801a1.54 1.54 0 0 0 1.506-1.218l1.351-6.34a.171.171 0 0 1 .167-.137c.08 0 .15.058.167.137l1.352 6.34a1.54 1.54 0 0 0 1.506 1.218h.805l2.113-9.292h-.565c-.62 0-1.159.43-1.296 1.035l-1.26 5.545-1.106-5.176a1.76 1.76 0 0 0-2.19-1.324c-.639.176-1.113.716-1.251 1.365l-1.094 5.127-1.26-5.537A1.33 1.33 0 0 0 .563 7.354H0zm13.992 0a.951.951 0 0 0-.951.95v8.342h.635a.952.952 0 0 0 .951-.95V7.353h-.635zm1.778 0 3.158 4.66-3.14 4.632h1.325c.368 0 .712-.181.918-.486l1.756-2.59a.12.12 0 0 1 .197 0l1.754 2.59c.206.305.55.486.918.486h1.326l-3.14-4.632L24 7.354h-1.326c-.368 0-.712.181-.918.486l-1.772 2.617a.12.12 0 0 1-.197 0L18.014 7.84a1.108 1.108 0 0 0-.918-.486H15.77z",
    category: "business",
  },
  {
    id: "zapier",
    name: "Zapier",
    description: "Actions across 8,000 apps.",
    url: "https://mcp.zapier.com/api/v1/connect",
    auth: "browser",
    docsUrl: "https://docs.zapier.com/mcp/get-started/connect/other",
    iconPath:
      "M4.157 0A4.151 4.151 0 0 0 0 4.161v15.678A4.151 4.151 0 0 0 4.157 24h15.682A4.152 4.152 0 0 0 24 19.839V4.161A4.152 4.152 0 0 0 19.839 0H4.157Zm10.61 8.761h.03a.577.577 0 0 1 .23.038.585.585 0 0 1 .201.124.63.63 0 0 1 .162.431.612.612 0 0 1-.162.435.58.58 0 0 1-.201.128.58.58 0 0 1-.23.042.529.529 0 0 1-.235-.042.585.585 0 0 1-.332-.328.559.559 0 0 1-.038-.235.613.613 0 0 1 .17-.431.59.59 0 0 1 .405-.162Zm2.853 1.572c.03.004.061.004.095.004.325-.011.646.064.937.219.238.144.431.355.552.609.128.279.189.582.185.888v.193a2 2 0 0 1 0 .219h-2.498c.003.227.075.45.204.642a.78.78 0 0 0 .646.265.714.714 0 0 0 .484-.136.642.642 0 0 0 .23-.318l.915.257a1.398 1.398 0 0 1-.28.537c-.14.159-.321.284-.521.355a2.234 2.234 0 0 1-.836.136 1.923 1.923 0 0 1-1.001-.245 1.618 1.618 0 0 1-.665-.703 2.221 2.221 0 0 1-.227-1.036 1.95 1.95 0 0 1 .48-1.398 1.9 1.9 0 0 1 1.3-.488Zm-9.607.023c.162.004.325.026.48.079.207.065.4.174.563.314.26.302.393.692.366 1.088v2.276H8.53l-.109-.711h-.065c-.064.163-.155.31-.272.439a1.122 1.122 0 0 1-.374.264 1.023 1.023 0 0 1-.453.083 1.334 1.334 0 0 1-.866-.264.965.965 0 0 1-.329-.801.993.993 0 0 1 .076-.431 1.02 1.02 0 0 1 .242-.363 1.478 1.478 0 0 1 1.043-.303h.952v-.181a.696.696 0 0 0-.136-.454.553.553 0 0 0-.438-.154.695.695 0 0 0-.378.086.48.48 0 0 0-.193.254l-.99-.144a1.26 1.26 0 0 1 .257-.563c.14-.174.321-.302.533-.378.261-.091.54-.136.82-.129.053-.003.106-.007.163-.007Zm4.384.007c.174 0 .347.038.506.114.182.083.34.211.458.374.257.423.377.911.351 1.406a2.53 2.53 0 0 1-.355 1.448 1.148 1.148 0 0 1-1.009.517c-.204 0-.401-.045-.582-.136a1.052 1.052 0 0 1-.48-.457 1.298 1.298 0 0 1-.114-.234h-.045l.004 1.784h-1.059v-4.713h.904l.117.805h.057c.068-.208.177-.401.328-.56a1.129 1.129 0 0 1 .843-.344h.076v-.004Zm7.559.084h.903l.113.805h.053a1.37 1.37 0 0 1 .235-.484.813.813 0 0 1 .313-.242.82.82 0 0 1 .39-.076h.234v1.051h-.401a.662.662 0 0 0-.313.008.623.623 0 0 0-.272.155.663.663 0 0 0-.174.26.683.683 0 0 0-.027.314v1.875h-1.054v-3.666Zm-17.515.003h3.262v.896L3.73 13.104l.034.113h1.973l.042.9H2.4v-.9l1.931-1.754-.045-.117H2.441v-.896Zm11.815 0h1.055v3.659h-1.055V10.45Zm3.443.684.019.016a.69.69 0 0 0-.351.045.756.756 0 0 0-.287.204c-.11.155-.174.336-.189.522h1.545c-.034-.526-.257-.787-.74-.787h.003Zm-5.718.163c-.026 0-.057 0-.083.004a.78.78 0 0 0-.31.053.746.746 0 0 0-.257.189 1.016 1.016 0 0 0-.204.695v.064c-.015.257.057.507.204.711a.634.634 0 0 0 .253.196.638.638 0 0 0 .314.061.644.644 0 0 0 .578-.265c.14-.223.204-.48.189-.74a1.216 1.216 0 0 0-.181-.711.677.677 0 0 0-.503-.257Zm-4.509 1.266a.464.464 0 0 0-.268.102.373.373 0 0 0-.114.276c0 .053.008.106.027.155a.375.375 0 0 0 .087.132.576.576 0 0 0 .397.11v.004a.863.863 0 0 0 .563-.182.573.573 0 0 0 .211-.457v-.14h-.903Z",
    category: "business",
  },
];

export const CONNECTOR_PRESETS: readonly ConnectorPreset[] = [EMAIL_PRESET, SLACK_PRESET, ...MCP_PRESETS].sort((a, b) =>
  a.id === "email" ? -1 : b.id === "email" ? 1 : a.name.localeCompare(b.name),
);
