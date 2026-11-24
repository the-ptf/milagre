const { UnauthorizedError } = require("@modelcontextprotocol/sdk/client/auth.js");
const { openInBrowser } = require("../antigravity-account.cjs");
const { createConnectorStore, isConnectorId } = require("./store.cjs");
const { ConnectorError, CALLBACK_PATH } = require("./callback.cjs");
const { createOAuthProvider } = require("./oauth.cjs");
const { createConnectorSession, httpTransport, commandTransport } = require("./session.cjs");
const { runSignIn, createSignIns, revokeTokens } = require("./sign-in.cjs");
const { connectorUrl, connectorName, connectorHeaders, connectorEnv, connectorCommand, idFor } = require("./input.cjs");

const CALLBACK_PORT = 47616;

const messageOf = (error) => (error instanceof Error ? error.message : String(error));
const needsSignIn = (error) => error instanceof UnauthorizedError || error?.code === "needs-sign-in";
const needsApp = (error) => /dynamic client registration/i.test(messageOf(error));
const failure = (error) =>
  needsApp(error) ? { state: "needs-app" } : needsSignIn(error) ? { state: "needs-sign-in" } : { state: "failed", problem: messageOf(error) };
const accessKey = (provider, accountId) => `${provider}:${accountId}`;
const isCommand = (connector) => typeof connector.command === "string";
const fromList = (tools) => ({ state: "connected", tools: tools.length, list: tools });

function createConnectors({
  dataDir,
  port = CALLBACK_PORT,
  openBrowser = openInBrowser,
  fetchImpl,
  now = Date.now,
  version = "0.0.0",
  timeoutMs,
  idleMs,
  reserved = ["linear"],
  changed = () => {},
}) {
  const store = createConnectorStore({ dataDir });
  const sessions = new Map();
  const health = new Map();
  const checking = new Map();
  const signIns = createSignIns();

  function find(id) {
    const connector = isConnectorId(id) ? store.get(id) : null;
    if (!connector) throw new ConnectorError(`There's no connector named ${JSON.stringify(String(id))}.`, "not-found");
    return connector;
  }
  function unique(label, id) {
    if (store.list().some((item) => item.id !== id && item.name.toLowerCase() === label.toLowerCase()))
      throw new ConnectorError(`There's already a connector named ${label}.`, "invalid");
    return label;
  }

  function providerFor(connector, { redirectUrl = `http://localhost:${port}${CALLBACK_PATH}`, state, redirect } = {}) {
    const background = () => {
      throw new ConnectorError(`Sign in to ${connector.name} from Milagre.`, "needs-sign-in");
    };
    return createOAuthProvider({ connector, secrets: store.secrets(connector.id), redirectUrl, state, now, redirect: redirect ?? background });
  }

  function sessionOf(connector) {
    let session = sessions.get(connector.id);
    if (!session) {
      const secrets = store.secrets(connector.id).read();
      const transport = isCommand(connector)
        ? commandTransport({ command: connector.command, args: connector.args ?? [], env: secrets.env })
        : httpTransport({ url: connector.url, headers: secrets.headers, authProvider: providerFor(connector), fetchImpl });
      session = createConnectorSession({ transport, version, idleMs, toolsChanged: () => void check(connector.id).catch(() => {}) });
      sessions.set(connector.id, session);
    }
    return session;
  }

  async function drop(id) {
    const session = sessions.get(id);
    sessions.delete(id);
    await session?.close();
  }

  function summary(connector) {
    const stored = store.secrets(connector.id).read();
    const known = health.get(connector.id);
    const fallback = isCommand(connector) ? "connected" : stored.tokens ? "signed-in" : "needs-sign-in";
    return {
      id: connector.id,
      name: connector.name,
      kind: isCommand(connector) ? "command" : "url",
      url: connector.url,
      ...(isCommand(connector) ? { command: connector.command, args: connector.args ?? [] } : {}),
      clientId: connector.clientId ?? null,
      hasClientSecret: typeof stored.clientSecret === "string",
      headers: Object.keys(stored.headers ?? {}),
      env: Object.keys(stored.env ?? {}),
      off: connector.off ?? [],
      state: known?.state ?? fallback,
      running: sessions.get(connector.id)?.running() === true,
      ...(known?.problem ? { problem: known.problem } : {}),
      ...(Number.isInteger(known?.tools) ? { tools: known.tools } : {}),
    };
  }

  function check(id) {
    const connector = find(id);
    const running = checking.get(id);
    if (running) return running;
    const done = (async () => {
      try {
        const tools = await sessionOf(connector).listTools();
        health.set(id, fromList(tools));
        store.saveTools(id, tools);
      } catch (error) {
        await drop(id);
        health.set(id, failure(error));
      }
      changed();
      return summary(store.get(id) ?? connector);
    })().finally(() => checking.delete(id));
    checking.set(id, done);
    return done;
  }

  /** What a connector is known to offer: a command connector answers from its saved tool list without starting; the rest are checked. */
  function known(connector) {
    if (health.has(connector.id) || checking.has(connector.id)) return health.get(connector.id);
    const cached = isCommand(connector) ? store.readTools(connector.id) : null;
    if (cached) health.set(connector.id, fromList(cached));
    else void check(connector.id).catch(() => {});
    return health.get(connector.id);
  }

  const revoke = (connector) => revokeTokens({ stored: store.secrets(connector.id).read(), client: providerFor(connector).clientInformation(), fetchImpl });

  async function reset(id, next) {
    store.save(next);
    await drop(id);
    health.delete(id);
    changed();
    return summary(next);
  }

  return {
    list() {
      const connectors = store.list();
      for (const connector of connectors) known(connector);
      return connectors.map(summary);
    },
    check,
    get: (id) => summary(find(id)),
    async add({ name, url, clientId, clientSecret, headers, command, args, env } = {}) {
      const label = unique(connectorName(name));
      const id = idFor(label, new Set([...reserved, ...store.list().map((item) => item.id)]));
      if (command !== undefined) {
        const program = connectorCommand(command, args);
        store.save({ id, name: label, url: "", ...program, off: [], createdAt: now() });
        const vars = connectorEnv(env);
        if (vars && Object.keys(vars).length) store.secrets(id).update({ env: vars });
      } else {
        const client = typeof clientId === "string" ? clientId.trim() : "";
        store.save({ id, name: label, url: connectorUrl(url), ...(client ? { clientId: client } : {}), off: [], createdAt: now() });
        const sent = connectorHeaders(headers);
        store.secrets(id).update({
          ...(typeof clientSecret === "string" && clientSecret ? { clientSecret } : {}),
          ...(sent && Object.keys(sent).length ? { headers: sent } : {}),
        });
      }
      changed();
      return check(id);
    },
    async update(id, { name, clientId, clientSecret, headers, command, args, env } = {}) {
      const connector = find(id);
      const next = { ...connector, ...(name !== undefined ? { name: unique(connectorName(name), id) } : {}) };
      const secrets = store.secrets(id);
      if (isCommand(connector) && (command !== undefined || args !== undefined))
        Object.assign(next, connectorCommand(command ?? connector.command, args ?? connector.args));
      const vars = connectorEnv(env, secrets.read().env);
      if (vars !== undefined) secrets.update({ env: Object.keys(vars).length ? vars : undefined });
      if (clientId !== undefined) {
        const client = String(clientId).trim();
        if (client) next.clientId = client;
        else delete next.clientId;
        if (client !== (connector.clientId ?? "")) secrets.update({ client: undefined, issuer: undefined, tokens: undefined, verifier: undefined });
      }
      if (clientSecret !== undefined) secrets.update({ clientSecret: clientSecret ? String(clientSecret) : undefined });
      const sent = connectorHeaders(headers, secrets.read().headers);
      if (sent !== undefined) secrets.update({ headers: Object.keys(sent).length ? sent : undefined });
      return reset(id, next);
    },
    async remove(id) {
      const connector = find(id);
      await drop(id);
      await revoke(connector);
      store.remove(id);
      health.delete(id);
      changed();
    },
    async signOut(id) {
      const connector = find(id);
      await drop(id);
      await revoke(connector);
      store.secrets(id).update({ tokens: undefined, verifier: undefined });
      health.set(id, { state: "needs-sign-in" });
      changed();
      return summary(connector);
    },
    async signIn(id) {
      const connector = find(id);
      if (isCommand(connector)) throw new ConnectorError(`${connector.name} runs on this computer and has no sign-in.`, "invalid");
      return signIns.run(async (attempt) => {
        try {
          await runSignIn({ attempt, connector, port, timeoutMs, providerFor, openBrowser, fetchImpl });
        } catch (error) {
          if (!needsApp(error)) throw error;
          health.set(connector.id, { state: "needs-app" });
          changed();
          return summary(connector);
        }
        await drop(connector.id);
        health.delete(connector.id);
        return check(connector.id);
      });
    },
    cancelSignIn: () => signIns.cancel(),
    moved: () => store.readMoved(),
    saveMoved: (names) => store.saveMoved(names),
    setAccess(id, provider, accountId, on) {
      const connector = find(id);
      const off = new Set(connector.off ?? []);
      if (on) off.delete(accessKey(provider, accountId));
      else off.add(accessKey(provider, accountId));
      store.save({ ...connector, off: [...off] });
      changed();
      return summary(store.get(id));
    },
    allows: (id, provider, accountId) => !(store.get(id)?.off ?? []).includes(accessKey(provider, accountId)),
    ready(provider, accountId) {
      return store
        .list()
        .filter((connector) => !(connector.off ?? []).includes(accessKey(provider, accountId)))
        .flatMap((connector) => {
          const state = known(connector);
          return state?.state === "connected" ? [{ connector: { id: connector.id, name: connector.name }, tools: state.list }] : [];
        });
    },
    async tools(id) {
      const tools = await sessionOf(find(id)).listTools();
      return tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
    },
    async call(id, name, args, options) {
      const connector = find(id);
      try {
        return await sessionOf(connector).callTool(String(name), args, options);
      } catch (error) {
        if (needsSignIn(error)) {
          await drop(id);
          health.set(id, { state: "needs-sign-in" });
          changed();
        }
        throw error;
      }
    },
    async dispose() {
      await signIns.cancel();
      await Promise.all([...sessions.keys()].map(drop));
    },
  };
}

module.exports = { createConnectors, connectorUrl, idFor, CALLBACK_PORT };
