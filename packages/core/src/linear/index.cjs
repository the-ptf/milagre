const crypto = require("node:crypto");
const { openInBrowser } = require("../antigravity-account.cjs");
const { CLIENT_ID, API_BASE, CALLBACK_PORT } = require("./config.cjs");
const { LinearError } = require("./errors.cjs");
const { createPkce, authorizeUrl, listenForCallback, exchangeCode, revokeToken } = require("./oauth.cjs");
const { createLinearStore } = require("./store.cjs");
const { postGraphql, createLinearClient } = require("./client.cjs");

const VIEWER = "query Viewer { viewer { name email } organization { name urlKey } }";

function createLinear({
  dataDir,
  clientId = CLIENT_ID,
  apiBase = API_BASE,
  port = CALLBACK_PORT,
  timeoutMs,
  fetchImpl = globalThis.fetch,
  openBrowser = openInBrowser,
  openWindow = null,
  now = Date.now,
  changed = () => {},
}) {
  const store = createLinearStore({ dataDir });
  const clients = new Map();
  function clientOf(id) {
    let client = clients.get(id);
    if (!client) {
      client = createLinearClient({ store: store.workspace(id), clientId, apiBase, fetchImpl, now, revoked: changed });
      clients.set(id, client);
    }
    return client;
  }
  let pending = null;

  async function cancelPending() {
    const current = pending;
    current.cancel();
    await current.done.catch(() => {});
    if (pending === current) pending = null;
  }

  function workspaces() {
    return store
      .listWorkspaces()
      .map(({ id, viewer, organization, scope }) => ({ id, viewer, organization, canWrite: Array.isArray(scope) && scope.includes("write") }));
  }
  function status() {
    const list = workspaces();
    if (!list.length) return { connected: false, workspaces: [] };
    return { connected: true, viewer: list[0].viewer, organization: list[0].organization, workspaces: list };
  }

  const revoke = (token, hint) => revokeToken({ fetchImpl, apiBase, token, hint });

  async function signIn(attempt, { window = false } = {}) {
    let previous = null;
    const pkce = createPkce();
    const state = crypto.randomBytes(16).toString("hex");
    const callback = await listenForCallback({ state, port, timeoutMs });
    attempt.callback = callback;
    try {
      if (attempt.cancelled) throw new LinearError("Replaced by a newer Linear sign-in.", "cancelled");
      const url = authorizeUrl({ clientId, redirectUri: callback.redirectUri, state, challenge: pkce.challenge });
      if (window && openWindow) openWindow(url);
      else openBrowser(url);
      const code = await callback.code;
      const replaced = () => new LinearError("Replaced by a newer Linear sign-in.", "cancelled");
      if (attempt.cancelled) throw replaced();
      const tokens = await exchangeCode({ fetchImpl, apiBase, clientId, code, redirectUri: callback.redirectUri, verifier: pkce.verifier, now: now() });
      try {
        if (attempt.cancelled) throw replaced();
        const { viewer, organization } = await postGraphql({ fetchImpl, apiBase, accessToken: tokens.accessToken, query: VIEWER });
        if (attempt.cancelled) throw replaced();
        const id = String(organization.urlKey).toLowerCase();
        const scoped = store.workspace(id);
        previous = scoped.readToken();
        scoped.saveToken({
          scope: ["read", "write"],
          ...tokens,
          connectedAt: previous?.connectedAt ?? now(),
          viewer: { name: viewer.name, email: viewer.email },
          organization: { name: organization.name, urlKey: organization.urlKey },
        });
      } catch (error) {
        await revoke(tokens.refreshToken, "refresh_token");
        throw error.code === "cancelled" ? error : new LinearError(`Linear sign-in failed: ${error.message}`, "failed");
      }
    } finally {
      await callback.close();
    }
    changed();
    if (previous) await endGrant(previous);
    return status();
  }

  async function endGrant(token) {
    if (!(await revoke(token.refreshToken, "refresh_token"))) await revoke(token.accessToken, "access_token");
  }

  return {
    status,
    workspaces,
    canWrite: (workspace) => workspaces().find((item) => item.id === workspace)?.canWrite === true,
    query: (workspace, document, variables) => clientOf(workspace).query(document, variables),
    download: (workspace, url, options) => clientOf(workspace).download(url, options),
    async connect({ window = false } = {}) {
      if (!clientId) throw new LinearError("Linear sign-in isn't set up in this build.", "not-configured");
      while (pending) await cancelPending();
      const attempt = { cancelled: false, callback: null };
      const done = signIn(attempt, { window });
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
    async disconnect(workspace) {
      const ids = typeof workspace === "string" ? [workspace.toLowerCase()] : workspaces().map((item) => item.id);
      const tokens = [];
      for (const id of ids) {
        const scoped = store.workspace(id);
        const token = scoped.readToken();
        scoped.clearToken();
        clients.delete(id);
        if (token) tokens.push(token);
      }
      if (!tokens.length) return status();
      changed();
      await Promise.all(tokens.map(endGrant));
      return status();
    },
    async cancel() {
      while (pending) await cancelPending();
    },
    async dispose() {
      while (pending) await cancelPending();
    },
    enabled: () => store.readEnabled(),
    setEnabled: (value) => store.saveEnabled(value),
    moveToStarted: () => store.readMoveToStarted(),
    setMoveToStarted: (value) => store.saveMoveToStarted(value),
  };
}

module.exports = { createLinear };
