const { createConnectors } = require("../connectors/index.cjs");
const { createConnectorStore } = require("../connectors/store.cjs");
const { createLinearConnector, LINEAR_ID } = require("../connectors/linear.cjs");
const { connectorToolDefinitions, connectorToolGroup, grantedConnectorToolDefinitions } = require("../connectors/tools.cjs");

const text = (value) => (typeof value === "string" ? value : undefined);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const record = (value) => (isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string")) : undefined);
const movable = (def) =>
  isObject(def) &&
  typeof def.name === "string" &&
  ((def.type === "http" && typeof def.url === "string") || (def.type === "stdio" && typeof def.command === "string"));
const target = (def) =>
  def.type === "stdio"
    ? { command: def.command, args: Array.isArray(def.args) ? def.args.map(String) : [], env: record(def.env) }
    : { url: def.url, headers: record(def.headers) };
const sameTarget = (connector, def) => (def.type === "stdio" ? connector.command === def.command : connector.url === def.url);

function createConnectorsWiring({ options, dataDir, emit, commands, version, mcp, mcpStore, linear, linearIssues, linearTools }) {
  const builtIn = linear ? createLinearConnector({ linear, linearIssues, linearTools, store: createConnectorStore({ dataDir }) }) : null;
  const listAll = () => [...(builtIn?.summary() ? [builtIn.summary()] : []), ...connectors.list()];
  const changed = () => emit("connectors:changed", { connectors: listAll() });
  const connectors = createConnectors({ dataDir, version, ...options.connectors, changed });
  const isLinear = (id) => builtIn && String(id) === LINEAR_ID;
  const input = (value) => (isObject(value) ? value : {});
  commands.handle("connectors:list", () => listAll());
  commands.handle("connectors:check", (_event, id) => (isLinear(id) ? builtIn.summary() : connectors.check(String(id))));
  const fields = (value) => {
    const { name, url, clientId, clientSecret, headers, command, args, env } = input(value);
    return {
      name: text(name),
      url: text(url),
      clientId: text(clientId),
      clientSecret: text(clientSecret),
      headers: record(headers),
      command: text(command),
      args: Array.isArray(args) ? args.filter((item) => typeof item === "string") : undefined,
      env: record(env),
    };
  };
  commands.handle("connectors:add", (_event, value) => connectors.add(fields(value)));
  commands.handle("connectors:update", (_event, id, value) => {
    const { url: _url, ...patch } = fields(value);
    return connectors.update(String(id), patch);
  });
  commands.handle("connectors:remove", (_event, id) => (isLinear(id) ? builtIn.signOut() : connectors.remove(String(id))));
  commands.handle("connectors:sign-in", (_event, id) => (isLinear(id) ? builtIn.signIn() : connectors.signIn(String(id))));
  commands.handle("connectors:cancel-sign-in", () => connectors.cancelSignIn());
  commands.handle("connectors:sign-out", (_event, id) => (isLinear(id) ? builtIn.signOut() : connectors.signOut(String(id))));
  commands.handle("connectors:access", (_event, id, provider, accountId, on, workspace) => {
    if (!isLinear(id)) {
      if (workspace !== undefined) throw new Error("Only the built-in Linear connector has workspace access settings.");
      return connectors.setAccess(String(id), String(provider), String(accountId), on === true);
    }
    const next = builtIn.setAccess(String(provider), String(accountId), on === true, workspace);
    changed();
    return next;
  });
  commands.handle("connectors:tools", (_event, id) => (isLinear(id) ? builtIn.describe() : connectors.tools(String(id))));
  commands.handle("connectors:call", (_event, id, name, args) => connectors.call(String(id), String(name), isObject(args) ? args : {}));
  /** An Everywhere server becomes a Connector with its headers or environment, and the Accounts it was off for stay off. */
  async function move(def) {
    const existing = connectors.list().find((item) => item.name.toLowerCase() === def.name.toLowerCase());
    const added = existing && sameTarget(existing, def) ? existing : await connectors.add({ name: existing ? `${def.name} 2` : def.name, ...target(def) });
    for (const [key, names] of Object.entries(mcpStore.read().off ?? {})) {
      const split = key.indexOf(":");
      if (Array.isArray(names) && names.includes(def.name) && split > 0) connectors.setAccess(added.id, key.slice(0, split), key.slice(split + 1), false);
    }
    await mcp.remove(def.name, "everywhere");
    return added;
  }
  async function moveAll() {
    const moved = [];
    for (const def of mcpStore.read().everywhere.filter(movable)) {
      try {
        moved.push((await move(def)).name);
      } catch (error) {
        console.warn(`Milagre couldn't move ${def.name} to Connectors:`, error.message);
      }
    }
    if (!moved.length) return;
    connectors.saveMoved([...new Set([...connectors.moved(), ...moved])]);
    changed();
  }
  commands.handle("connectors:moved", () => connectors.moved());
  commands.handle("connectors:dismiss-moved", () => connectors.saveMoved([]));
  commands.handle("connectors:movable", () =>
    mcpStore
      .read()
      .everywhere.filter(movable)
      .map((def) => ({ name: def.name, url: def.type === "stdio" ? "" : def.url })),
  );
  commands.handle("connectors:move", async (_event, name) => {
    const def = mcpStore.read().everywhere.find((item) => movable(item) && item.name === String(name));
    if (!def) throw new Error(`${String(name)} isn't an Everywhere server Milagre can move.`);
    return move(def);
  });
  if (options.connectors?.moveEverywhere !== false) void moveAll();
  connectors.list();
  return {
    connectors,
    /** Linear's tools and the Connectors this provider Account may use, for a Chat's `milagre` tools. */
    tools: (context) => [...(builtIn?.tools(context) ?? []), ...connectorToolDefinitions(connectors, context)],
    /** The local MCP `connectors` group: outside clients get the Connectors, and Linear, their grant names. */
    toolGroup: connectorToolGroup((ids) => [
      ...(builtIn && (ids === "*" || ids.includes(LINEAR_ID)) ? builtIn.allTools() : []),
      ...grantedConnectorToolDefinitions(connectors, ids),
    ]),
    linearChanged: changed,
    dispose: () => connectors.dispose(),
  };
}

module.exports = { createConnectorsWiring };
