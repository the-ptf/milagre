const { createConnectors } = require("../connectors/index.cjs");

const text = (value) => (typeof value === "string" ? value : undefined);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const record = (value) => (isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string")) : undefined);
const movable = (def) => isObject(def) && def.type === "http" && typeof def.url === "string" && typeof def.name === "string";

function createConnectorsWiring({ options, dataDir, emit, commands, version, mcp, mcpStore }) {
  const connectors = createConnectors({
    dataDir,
    version,
    ...options.connectors,
    changed: () => emit("connectors:changed", { connectors: connectors.list() }),
  });
  const input = (value) => (isObject(value) ? value : {});
  commands.handle("connectors:list", () => connectors.list());
  commands.handle("connectors:check", (_event, id) => connectors.check(String(id)));
  commands.handle("connectors:add", (_event, value) => {
    const { name, url, clientId, clientSecret, headers } = input(value);
    return connectors.add({ name: text(name), url: text(url), clientId: text(clientId), clientSecret: text(clientSecret), headers: record(headers) });
  });
  commands.handle("connectors:update", (_event, id, value) => {
    const { name, clientId, clientSecret, headers } = input(value);
    return connectors.update(String(id), { name: text(name), clientId: text(clientId), clientSecret: text(clientSecret), headers: record(headers) });
  });
  commands.handle("connectors:remove", (_event, id) => connectors.remove(String(id)));
  commands.handle("connectors:sign-in", (_event, id) => connectors.signIn(String(id)));
  commands.handle("connectors:cancel-sign-in", () => connectors.cancelSignIn());
  commands.handle("connectors:sign-out", (_event, id) => connectors.signOut(String(id)));
  commands.handle("connectors:access", (_event, id, provider, accountId, on) =>
    connectors.setAccess(String(id), String(provider), String(accountId), on === true),
  );
  commands.handle("connectors:tools", (_event, id) => connectors.tools(String(id)));
  commands.handle("connectors:call", (_event, id, name, args) => connectors.call(String(id), String(name), isObject(args) ? args : {}));
  commands.handle("connectors:movable", () =>
    mcpStore
      .read()
      .everywhere.filter(movable)
      .map((def) => ({ name: def.name, url: def.url })),
  );
  commands.handle("connectors:move", async (_event, name) => {
    const def = mcpStore.read().everywhere.find((item) => movable(item) && item.name === String(name));
    if (!def) throw new Error(`${String(name)} isn't an Everywhere server with an address.`);
    const added = await connectors.add({ name: def.name, url: def.url, headers: record(def.headers) });
    await mcp.remove(def.name, "everywhere");
    return added;
  });
  connectors.list();
  return connectors;
}

module.exports = { createConnectorsWiring };
