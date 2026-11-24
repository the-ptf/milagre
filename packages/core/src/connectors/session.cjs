const os = require("node:os");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { ToolListChangedNotificationSchema } = require("@modelcontextprotocol/sdk/types.js");

const CALL_TIMEOUT_MS = 120_000;
const IDLE_MS = 10 * 60_000;

const httpTransport =
  ({ url, headers, authProvider, fetchImpl }) =>
  () =>
    new StreamableHTTPClientTransport(new URL(url), {
      authProvider,
      ...(headers && Object.keys(headers).length ? { requestInit: { headers } } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });

/** One process for every Chat that uses the connector, started on first use in the home folder with the host's environment. */
function commandTransport({ command, args, env, cwd = os.homedir() }) {
  return () => {
    const transport = new StdioClientTransport({ command, args, env: { ...process.env, ...env }, cwd, stderr: "pipe" });
    let output = "";
    transport.stderr?.on("data", (chunk) => (output = (output + chunk).slice(-2000)));
    transport.lastError = () => output.trim().split("\n").at(-1) ?? "";
    return transport;
  };
}

function createConnectorSession({ transport, version, toolsChanged = () => {}, idleMs = IDLE_MS }) {
  let client = null;
  let connecting = null;
  let tools = null;
  let idle = null;
  let busy = 0;

  function rest() {
    clearTimeout(idle);
    if (busy || !idleMs) return;
    idle = setTimeout(() => void close(), idleMs);
    idle.unref?.();
  }

  function connect() {
    if (client) return Promise.resolve(client);
    connecting ??= (async () => {
      const next = new Client({ name: "Milagre", version }, { capabilities: {} });
      next.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        tools = null;
        toolsChanged();
      });
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- the MCP SDK Client only exposes an onclose property
      next.onclose = () => {
        if (client !== next) return;
        client = null;
        tools = null;
      };
      const opened = transport();
      try {
        await next.connect(opened);
      } catch (error) {
        const said = opened.lastError?.();
        throw said ? Object.assign(new Error(`${error.message}: ${said}`), { code: error.code }) : error;
      }
      client = next;
      return next;
    })().finally(() => (connecting = null));
    return connecting;
  }

  async function using(work) {
    busy += 1;
    clearTimeout(idle);
    try {
      return await work(await connect());
    } finally {
      busy -= 1;
      rest();
    }
  }

  function listTools() {
    if (tools) return Promise.resolve(tools);
    return using(async (active) => {
      const all = [];
      let cursor;
      do {
        const page = await active.listTools(cursor ? { cursor } : undefined);
        all.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      tools = all;
      return all;
    });
  }

  const callTool = (name, args, { signal, timeoutMs = CALL_TIMEOUT_MS } = {}) =>
    using((active) => active.callTool({ name, arguments: args ?? {} }, undefined, { signal, timeout: timeoutMs, resetTimeoutOnProgress: true }));

  async function close() {
    clearTimeout(idle);
    const active = client;
    client = null;
    tools = null;
    await active?.close().catch(() => {});
  }

  return { listTools, callTool, close, running: () => client !== null };
}

module.exports = { createConnectorSession, httpTransport, commandTransport };
