const { CodexRpc } = require("../agents/codex-rpc.cjs");
const { runCli } = require("./claude.cjs");
const { toCodexConfig, fromCodexConfig, safeDetail } = require("./definitions.cjs");

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
    detail: safeDetail(configured),
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

function checkCodex({ command, env, cwd, clientVersion, signal, createRpc, everywhere = [] }) {
  return withAppServer({ command, env, cwd, clientVersion, signal, createRpc }, async (rpc) => {
    const configured = (await rpc.request("config/read", { cwd })).config?.mcp_servers ?? {};
    const servers = [];
    let cursor = null;
    do {
      const page = await rpc.request("mcpServerStatus/list", { detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) });
      for (const status of page.data ?? []) servers.push(codexServer(status, configured[status.name]));
      cursor = page.nextCursor ?? null;
    } while (cursor);
    // Everywhere servers aren't in Codex's config; an ephemeral thread that carries them reports their status (probed 2026-10-15).
    // A failure here must not lose the user's own servers, so each unreported Everywhere server reads as failed.
    if (everywhere.length) {
      const byName = new Map(everywhere.map((def) => [def.name, toCodexConfig(def)]));
      try {
        const { thread } = await rpc.request("thread/start", { cwd, config: { mcp_servers: Object.fromEntries(byName) }, ephemeral: true });
        let next = null;
        do {
          const page = await rpc.request("mcpServerStatus/list", { threadId: thread?.id, detail: "toolsAndAuthOnly", ...(next ? { cursor: next } : {}) });
          for (const status of page.data ?? [])
            if (byName.has(status.name) && !servers.some((server) => server.name === status.name))
              servers.push({ ...codexServer(status, byName.get(status.name)), scope: "everywhere" });
          next = page.nextCursor ?? null;
        } while (next);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const def of everywhere)
          if (!servers.some((server) => server.name === def.name))
            servers.push({
              name: def.name,
              transport: def.type === "stdio" ? "command" : "url",
              scope: "everywhere",
              state: "failed",
              tools: 0,
              error: message,
              detail: safeDetail(def),
            });
      }
    }
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

const SIGN_IN_TIMEOUT = "Sign-in timed out after 5 minutes. Try again.";

// One account's OAuth sign-in through the app-server: it returns the URL, runs the callback and token
// exchange, and announces the end with mcpServer/oauthLogin/completed.
async function signInCodex({ name, openUrl, signal, timeoutMs = 300_000, everywhere = [], ...options }) {
  // Never rejects: an abort before or during initialize rejects out of withAppServer, and that is a cancel.
  return withAppServer({ ...options, signal }, async (rpc) => {
    // An Everywhere server isn't in Codex's config; login finds it only inside a thread that carries it (probed 2026-10-15).
    const def = everywhere.find((item) => item.name === name);
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
      const threadId = def
        ? (await rpc.request("thread/start", { cwd: options.cwd, config: { mcp_servers: { [name]: toCodexConfig(def) } }, ephemeral: true })).thread?.id
        : undefined;
      const { authorizationUrl } = await rpc.request("mcpServer/oauth/login", {
        name,
        ...(threadId ? { threadId } : {}),
        timeoutSecs: Math.round(timeoutMs / 1000),
      });
      if (authorizationUrl) openUrl(authorizationUrl);
      return await done;
    } catch (error) {
      return signal?.aborted ? { cancelled: true } : { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rpc.off?.("notification", onNotification);
    }
  }).catch((error) => (signal?.aborted ? { cancelled: true } : { ok: false, error: error instanceof Error ? error.message : String(error) }));
}

module.exports = { checkCodex, codexServer, addCodex, removeCodex, readCodexDefinition, withAppServer, signInCodex };
