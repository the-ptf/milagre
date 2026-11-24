const crypto = require("node:crypto");
const { auth, UnauthorizedError } = require("@modelcontextprotocol/sdk/client/auth.js");
const { openInBrowser } = require("../antigravity-account.cjs");
const { createConnectorStore, isConnectorId } = require("./store.cjs");
const { listenForCallback, ConnectorError, CALLBACK_PATH } = require("./callback.cjs");
const { createOAuthProvider } = require("./oauth.cjs");
const { createConnectorSession } = require("./session.cjs");

const CALLBACK_PORT = 47616;
const MAX_NAME = 60;
const ID_LENGTH = 16;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function connectorUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new ConnectorError("Enter the server's https address.", "invalid");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))
    throw new ConnectorError("Use an https address. Plain http only works for a server on this computer.", "invalid");
  if (url.username || url.password) throw new ConnectorError("Take the user name and password out of the address.", "invalid");
  url.hash = "";
  return url.href;
}

function connectorName(value) {
  const name = String(value ?? "").trim();
  if (!name || name.length > MAX_NAME) throw new ConnectorError(`Name the connector in up to ${MAX_NAME} characters.`, "invalid");
  return name;
}

function idFor(name, taken) {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "");
  const trim = (value, length) => value.slice(0, length).replace(/_+$/, "");
  const base = trim(slug, ID_LENGTH) || "connector";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${trim(base, ID_LENGTH - String(n).length - 1)}_${n}`;
    if (!taken.has(id)) return id;
  }
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const HEADER_MASK = "••••••";

function connectorHeaders(value, stored = {}) {
  if (value === undefined) return undefined;
  const entries = Object.entries(value && typeof value === "object" ? value : {}).filter(([name, item]) => name && item !== "");
  for (const [name] of entries) if (!HEADER_NAME.test(name)) throw new ConnectorError(`${JSON.stringify(name)} isn't a header name.`, "invalid");
  return Object.fromEntries(entries.map(([name, item]) => [name, item === HEADER_MASK && Object.hasOwn(stored, name) ? stored[name] : String(item)]));
}

const messageOf = (error) => (error instanceof Error ? error.message : String(error));
const needsSignIn = (error) => error instanceof UnauthorizedError || error?.code === "needs-sign-in";
const accessKey = (provider, accountId) => `${provider}:${accountId}`;

async function revokeTokens({ stored, client, fetchImpl }) {
  const endpoint = stored.discovery?.authorizationServerMetadata?.revocation_endpoint;
  const token = stored.tokens?.refresh_token ?? stored.tokens?.access_token;
  if (typeof endpoint !== "string" || !token || !client?.client_id) return;
  const body = new URLSearchParams({ token, client_id: client.client_id, ...(client.client_secret ? { client_secret: client.client_secret } : {}) });
  await (fetchImpl ?? globalThis.fetch)(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

function createConnectors({
  dataDir,
  port = CALLBACK_PORT,
  openBrowser = openInBrowser,
  fetchImpl,
  now = Date.now,
  version = "0.0.0",
  timeoutMs,
  changed = () => {},
}) {
  const store = createConnectorStore({ dataDir });
  const sessions = new Map();
  const health = new Map();
  const checking = new Map();
  let pending = null;

  function find(id) {
    const connector = isConnectorId(id) ? store.get(id) : null;
    if (!connector) throw new ConnectorError(`There's no connector named ${JSON.stringify(String(id))}.`, "not-found");
    return connector;
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
      session = createConnectorSession({
        url: connector.url,
        headers: store.secrets(connector.id).read().headers,
        authProvider: providerFor(connector),
        fetchImpl,
        version,
        toolsChanged: () => void check(connector.id).catch(() => {}),
      });
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
    return {
      id: connector.id,
      name: connector.name,
      url: connector.url,
      clientId: connector.clientId ?? null,
      hasClientSecret: typeof stored.clientSecret === "string",
      headers: Object.keys(stored.headers ?? {}),
      off: connector.off ?? [],
      state: known?.state ?? (stored.tokens ? "signed-in" : "needs-sign-in"),
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
        health.set(id, { state: "connected", tools: tools.length, list: tools });
      } catch (error) {
        await drop(id);
        health.set(id, needsSignIn(error) ? { state: "needs-sign-in" } : { state: "failed", problem: messageOf(error) });
      }
      changed();
      return summary(store.get(id) ?? connector);
    })().finally(() => checking.delete(id));
    checking.set(id, done);
    return done;
  }

  function list() {
    const connectors = store.list();
    for (const connector of connectors) if (!health.has(connector.id) && !checking.has(connector.id)) void check(connector.id).catch(() => {});
    return connectors.map(summary);
  }

  async function signIn(attempt, connector) {
    const state = crypto.randomBytes(16).toString("hex");
    const callback = await listenForCallback({ state, name: connector.name, port, timeoutMs });
    attempt.callback = callback;
    const cancelled = () => new ConnectorError("Replaced by a newer sign-in.", "cancelled");
    try {
      if (attempt.cancelled) throw cancelled();
      const provider = providerFor(connector, { redirectUrl: callback.redirectUri, state: () => state, redirect: (url) => openBrowser(String(url)) });
      const first = await auth(provider, { serverUrl: connector.url, fetchFn: fetchImpl });
      if (first !== "AUTHORIZED") {
        const code = await callback.code;
        if (attempt.cancelled) throw cancelled();
        await auth(provider, { serverUrl: connector.url, authorizationCode: code, fetchFn: fetchImpl });
      }
    } finally {
      await callback.close();
    }
    await drop(connector.id);
    health.delete(connector.id);
    return check(connector.id);
  }

  async function cancelPending() {
    const current = pending;
    current.cancel();
    await current.done.catch(() => {});
    if (pending === current) pending = null;
  }

  const revoke = (connector) => revokeTokens({ stored: store.secrets(connector.id).read(), client: providerFor(connector).clientInformation(), fetchImpl });

  return {
    list,
    check,
    get: (id) => summary(find(id)),
    async add({ name, url, clientId, clientSecret, headers } = {}) {
      const label = connectorName(name);
      const href = connectorUrl(url);
      const connectors = store.list();
      if (connectors.some((item) => item.name.toLowerCase() === label.toLowerCase()))
        throw new ConnectorError(`There's already a connector named ${label}.`, "invalid");
      const id = idFor(label, new Set(connectors.map((item) => item.id)));
      const client = typeof clientId === "string" ? clientId.trim() : "";
      store.save({ id, name: label, url: href, ...(client ? { clientId: client } : {}), off: [], createdAt: now() });
      const sent = connectorHeaders(headers);
      store.secrets(id).update({
        ...(typeof clientSecret === "string" && clientSecret ? { clientSecret } : {}),
        ...(sent && Object.keys(sent).length ? { headers: sent } : {}),
      });
      changed();
      return check(id);
    },
    async update(id, { name, clientId, clientSecret, headers } = {}) {
      const connector = find(id);
      const next = { ...connector };
      if (name !== undefined) {
        const label = connectorName(name);
        if (store.list().some((item) => item.id !== id && item.name.toLowerCase() === label.toLowerCase()))
          throw new ConnectorError(`There's already a connector named ${label}.`, "invalid");
        next.name = label;
      }
      const secrets = store.secrets(id);
      if (clientId !== undefined) {
        const client = String(clientId).trim();
        if (client) next.clientId = client;
        else delete next.clientId;
        if (client !== (connector.clientId ?? "")) secrets.update({ client: undefined, issuer: undefined, tokens: undefined, verifier: undefined });
      }
      if (clientSecret !== undefined) secrets.update({ clientSecret: clientSecret ? String(clientSecret) : undefined });
      const sent = connectorHeaders(headers, secrets.read().headers);
      if (sent !== undefined) secrets.update({ headers: Object.keys(sent).length ? sent : undefined });
      store.save(next);
      await drop(id);
      health.delete(id);
      changed();
      return summary(next);
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
      while (pending) await cancelPending();
      const attempt = { cancelled: false, callback: null };
      const done = signIn(attempt, connector);
      pending = {
        done,
        cancel() {
          attempt.cancelled = true;
          void attempt.callback?.cancel();
        },
      };
      try {
        return await done;
      } finally {
        if (pending?.done === done) pending = null;
      }
    },
    async cancelSignIn() {
      while (pending) await cancelPending();
    },
    setAccess(id, provider, accountId, on) {
      const connector = find(id);
      const key = accessKey(provider, accountId);
      const off = new Set(connector.off ?? []);
      if (on) off.delete(key);
      else off.add(key);
      store.save({ ...connector, off: [...off] });
      changed();
      return summary(store.get(id));
    },
    allows: (id, provider, accountId) => !(store.get(id)?.off ?? []).includes(accessKey(provider, accountId)),
    ready(provider, accountId) {
      const key = accessKey(provider, accountId);
      return store
        .list()
        .filter((connector) => !(connector.off ?? []).includes(key))
        .flatMap((connector) => {
          const known = health.get(connector.id);
          if (!known && !checking.has(connector.id)) void check(connector.id).catch(() => {});
          return known?.state === "connected" ? [{ connector: { id: connector.id, name: connector.name }, tools: known.list }] : [];
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
      while (pending) await cancelPending();
      await Promise.all([...sessions.keys()].map(drop));
    },
  };
}

module.exports = { createConnectors, connectorUrl, idFor, CALLBACK_PORT };
