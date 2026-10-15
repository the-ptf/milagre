const { CodexRpc } = require("../agents/codex-rpc.cjs");
const { runCli } = require("./claude.cjs");
const { toCodexConfig, fromCodexConfig } = require("./definitions.cjs");

// One Codex account's MCP servers: config/read says how each is configured, mcpServerStatus/list connects them
// without a thread and says whether that worked (the listCodexModels pattern in agents/models.cjs).

function codexServer(status, configured) {
  const tools = Object.keys(status.tools ?? {}).length;
  const signIn = status.authStatus === "notLoggedIn";
  const state = configured?.enabled === false ? "disabled" : status.toolsError ? (signIn ? "needs-sign-in" : "failed") : signIn ? "needs-sign-in" : "connected";
  return {
    name: status.name,
    transport: configured?.url || status.httpOrigin ? "url" : "command",
    scope: status.pluginId ? "plugin" : configured ? "user" : "built-in",
    state,
    tools,
    error: status.toolsError ?? null,
  };
}

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

function checkCodex({ command, env, cwd, clientVersion, signal, createRpc }) {
  return withAppServer({ command, env, cwd, clientVersion, signal, createRpc }, async (rpc) => {
    const configured = (await rpc.request("config/read", { cwd })).config?.mcp_servers ?? {};
    const servers = [];
    let cursor = null;
    do {
      const page = await rpc.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) });
      for (const status of page.data ?? []) servers.push(codexServer(status, configured[status.name]));
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return servers;
  });
}

async function addCodex({ def, ...options }) {
  await withAppServer(options, (rpc) =>
    rpc.request("config/value/write", { keyPath: `mcp_servers.${def.name}`, value: toCodexConfig(def), mergeStrategy: "replace" }),
  );
}

async function removeCodex({ command, env, name, run = runCli }) {
  await run(command, ["mcp", "remove", name], { env });
}

async function readCodexDefinition({ name, ...options }) {
  return withAppServer(options, async (rpc) => fromCodexConfig(name, (await rpc.request("config/read", { cwd: options.cwd })).config?.mcp_servers?.[name]));
}

module.exports = { checkCodex, codexServer, addCodex, removeCodex, readCodexDefinition, withAppServer };
