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
  const chatGrantsFile = privateJson(directory, "chat-grants.json", {});
  let chatGrants = chatGrantsFile.read();
  if (!chatGrants || typeof chatGrants !== "object" || Array.isArray(chatGrants)) chatGrants = {};
  const grantedProjects = (chatId) => [...(Array.isArray(chatGrants[chatId]) ? chatGrants[chatId] : [])];
  const grantChatProject = (chatId, projectPath) => {
    if (!chatId || typeof projectPath !== "string" || !path.isAbsolute(projectPath)) return;
    const current = grantedProjects(chatId);
    if (current.includes(projectPath)) return;
    const next = { ...chatGrants, [chatId]: [...current, projectPath] };
    chatGrantsFile.write(next);
    chatGrants = next;
  };
  const forgetProjectGrants = (projectPath) => {
    if (typeof projectPath !== "string" || !projectPath) return;
    const prefix = `${projectPath}#`;
    let dirty = false;
    const next = {};
    for (const [chatId, list] of Object.entries(chatGrants)) {
      if (chatId.startsWith(prefix)) {
        dirty = true;
        continue;
      }
      const kept = Array.isArray(list) ? list.filter((item) => item !== projectPath) : [];
      if (Array.isArray(list) && kept.length !== list.length) dirty = true;
      if (kept.length) next[chatId] = kept;
      else if (chatId in chatGrants) dirty = true;
    }
    if (!dirty) return;
    chatGrantsFile.write(next);
    chatGrants = next;
  };
  const withChatGrants = (chatId, grants) => {
    const extra = grantedProjects(chatId);
    if (!extra.length || !(grants.projects?.capabilities?.includes("create") || grants.worktrees?.capabilities?.includes("create"))) return grants;
    const merge = (scope) => (scope && Array.isArray(scope.projectPaths) ? { ...scope, projectPaths: [...new Set([...scope.projectPaths, ...extra])] } : scope);
    return {
      ...grants,
      ...(grants.projects ? { projects: merge(grants.projects) } : {}),
      ...(grants.worktrees ? { worktrees: merge(grants.worktrees) } : {}),
      ...(grants.chats ? { chats: merge(grants.chats) } : {}),
    };
  };
  let stopped = false;
  const connection = (id) => {
    if (stopped) throw Error("Local MCP is closing");
    if (id.startsWith("agent:")) {
      const chatId = id.slice(6);
      return { id, revision: 1, grants: withChatGrants(chatId, agentScope(chatId)) };
    }
    return store.get(id);
  };
  const registry = createLocalMcpRegistry({ connection });
  for (const group of managementToolGroups({ host, operations, grantChatProject })) registry.registerToolGroup(group);
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
    for (const scope of Object.values(config.grants))
      if (Array.isArray(scope.projectPaths)) for (const projectPath of scope.projectPaths) await host.validateProject(projectPath);
    if (config.grants.designs) await host.validateChat(config.grants.designs.chatId);
    return config;
  };
  const credential = async (made) => ({ ...made, url: await listen() });
  return {
    grantedProjects,
    grantChatProject,
    forgetProjectGrants,
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
        projects: (await host.projects()).filter((project) => !project.kind).map(({ id, path, name }) => ({ id, path, name })),
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
