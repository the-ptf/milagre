const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { createLocalMcpStore, configurationSchema, privateJson } = require("./local-mcp-store.cjs");
const { createLocalMcpRegistry } = require("./local-mcp-registry.cjs");
const { createLocalMcpOperations } = require("./local-mcp-operations.cjs");
const { createLocalMcpServer } = require("./local-mcp-server.cjs");
const { managementToolGroups } = require("./local-mcp-tools.cjs");

function createLocalMcp({ dataDir, host, designGroup, agentScope, clientOptions, environmentReady = Promise.resolve(), emit = () => {} }) {
  const directory = path.join(dataDir, "local-mcp");
  const store = createLocalMcpStore({ directory });
  const operations = createLocalMcpOperations({ directory });
  let stopped = false;
  const connection = (id) => {
    if (stopped) throw Error("Local MCP is closing");
    if (id.startsWith("agent:")) return { id, revision: 1, grants: agentScope(id.slice(6)) };
    return store.get(id);
  };
  const registry = createLocalMcpRegistry({ connection });
  for (const group of managementToolGroups({ host, operations })) registry.registerToolGroup(group);
  if (designGroup) registry.registerToolGroup(designGroup);
  const internal = new Map(),
    chatTokens = new Map();
  const server = createLocalMcpServer({
    authenticate: store.authenticate,
    toolsFor: registry.toolsFor,
    internalConnection: (token) => {
      const entry = internal.get(token);
      if (!entry) throw Error("Unauthorized");
      connection(`agent:${entry.chatId}`);
      return { id: `agent:${entry.chatId}`, revision: 1, tools: () => entry.toolsFor(entry.chatId) };
    },
  });
  const endpointFile = privateJson(directory, "endpoint.json", { port: 0 });
  const saved = endpointFile.read();
  let endpoint;
  let endpointUrl;
  let clients;
  const clientManager = () =>
    (clients ??= require("./local-mcp-clients.cjs").createLocalMcpClients({ directory, store, url: () => endpointUrl, ...clientOptions }));
  const listen = () => {
    if (stopped) throw Error("Local MCP is closing");
    endpoint ??= server
      .listen(saved.port)
      .then((url) => {
        endpointUrl = url;
        endpointFile.write({ port: Number(new URL(url).port) });
        return url;
      })
      .catch((error) => {
        endpoint = undefined;
        throw error;
      });
    return endpoint;
  };
  const changed = () => emit("local-mcp:changed", {});
  const validate = async (input) => {
    const config = configurationSchema.parse(input);
    for (const scope of Object.values(config.grants)) for (const projectPath of scope.projectPaths ?? []) await host.validateProject(projectPath);
    if (config.grants.designs) await host.validateChat(config.grants.designs.chatId);
    return config;
  };
  const credential = async (made) => ({ ...made, url: await listen() });
  return {
    agentTools(chatId) {
      return registry.toolsFor(`agent:${chatId}`);
    },
    async chatUrl(chatId, toolsFor) {
      connection(`agent:${chatId}`);
      const url = await listen();
      if (!chatTokens.has(chatId)) {
        const token = randomBytes(24).toString("hex");
        chatTokens.set(chatId, token);
        internal.set(token, { chatId, toolsFor });
      }
      return `${url}/${chatTokens.get(chatId)}`;
    },
    async status() {
      await environmentReady;
      return {
        url: await listen(),
        connections: store.list(),
        clients: clientManager().status(),
        groups: registry.groups(),
        projects: (await host.projects()).map(({ id, path, name }) => ({ id, path, name })),
      };
    },
    async create(input) {
      const config = await validate(input);
      await listen();
      const made = store.create(config);
      changed();
      return credential(made);
    },
    async update(id, input) {
      const config = await validate(input);
      const connection = store.update(id, config);
      changed();
      return connection;
    },
    async rotate(id) {
      if (store.get(id).clientId) throw Error("Use the client setup to replace this credential.");
      await listen();
      const made = store.rotate(id);
      changed();
      return credential(made);
    },
    async revoke(id) {
      await environmentReady;
      const clientId = clientManager().manages(id);
      if (clientId) clientManager().disable(clientId);
      else store.revoke(id);
      changed();
    },
    async enableClient(id, input) {
      await environmentReady;
      const config = await validate(input);
      await listen();
      const result = clientManager().enable(id, config);
      changed();
      return result;
    },
    async disableClient(id) {
      await environmentReady;
      const result = clientManager().disable(id);
      changed();
      return result;
    },
    async resume() {
      await environmentReady;
      if (stopped) return;
      if (store.list().some((item) => !item.revokedAt)) await listen();
      clientManager().resume();
    },
    async close() {
      stopped = true;
      await server.close();
      await operations.idle();
    },
  };
}
module.exports = { createLocalMcp };
