const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { ToolListChangedNotificationSchema } = require("@modelcontextprotocol/sdk/types.js");

const CALL_TIMEOUT_MS = 120_000;

function createConnectorSession({ url, headers, authProvider, fetchImpl, version, toolsChanged = () => {} }) {
  let client = null;
  let connecting = null;
  let tools = null;

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
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        authProvider,
        ...(headers && Object.keys(headers).length ? { requestInit: { headers } } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
      await next.connect(transport);
      client = next;
      return next;
    })().finally(() => (connecting = null));
    return connecting;
  }

  async function listTools() {
    if (tools) return tools;
    const active = await connect();
    const all = [];
    let cursor;
    do {
      const page = await active.listTools(cursor ? { cursor } : undefined);
      all.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    tools = all;
    return all;
  }

  async function callTool(name, args, { signal, timeoutMs = CALL_TIMEOUT_MS } = {}) {
    const active = await connect();
    return active.callTool({ name, arguments: args ?? {} }, undefined, { signal, timeout: timeoutMs, resetTimeoutOnProgress: true });
  }

  async function close() {
    const active = client;
    client = null;
    tools = null;
    await active?.close().catch(() => {});
  }

  return { listTools, callTool, close };
}

module.exports = { createConnectorSession };
