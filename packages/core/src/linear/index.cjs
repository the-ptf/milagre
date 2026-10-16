const crypto = require("node:crypto");
const { openInBrowser } = require("../antigravity-account.cjs");
const { CLIENT_ID, API_BASE, CALLBACK_PORT } = require("./config.cjs");
const { LinearError } = require("./errors.cjs");
const { createPkce, authorizeUrl, listenForCallback, exchangeCode, revokeToken } = require("./oauth.cjs");
const { createLinearStore } = require("./store.cjs");
const { postGraphql, createLinearClient } = require("./client.cjs");

const VIEWER = "query Viewer { viewer { name email } organization { name urlKey } }";

// The Mac's Linear connections, one per workspace (see docs/superpowers/specs/2026-10-08-linear-integration-design.md).
// A workspace is named by its URL key (`acme`), lower case.
function createLinear({
  dataDir,
  clientId = CLIENT_ID,
  apiBase = API_BASE,
  port = CALLBACK_PORT,
  timeoutMs,
  fetchImpl = globalThis.fetch,
  openBrowser = openInBrowser,
  // Opens the sign-in in the Mac app's own window with an empty session, so another account can sign in. Without it,
  // a window sign-in falls back to the browser.
  openWindow = null,
  now = Date.now,
  changed = () => {},
}) {
  const store = createLinearStore({ dataDir });
  const clients = new Map(); // workspace id -> its client, which shares one token refresh between callers
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

  // `canWrite`: the sign-in may change issues. One saved before Milagre asked for write access can only read them.
  function workspaces() {
    return store
      .listWorkspaces()
      .map(({ id, viewer, organization, scope }) => ({ id, viewer, organization, canWrite: Array.isArray(scope) && scope.includes("write") }));
  }
  // `viewer` and `organization` repeat the first workspace for a phone that predates workspaces.
  function status() {
    const list = workspaces();
    if (!list.length) return { connected: false, workspaces: [] };
    return { connected: true, viewer: list[0].viewer, organization: list[0].organization, workspaces: list };
  }

  // Best effort: a token Linear can't be told about is gone from this Mac either way.
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
        // The exchange and the Viewer query are awaits too: a sign-in cancelled during them must not save a token.
        if (attempt.cancelled) throw replaced();
        const { viewer, organization } = await postGraphql({ fetchImpl, apiBase, accessToken: tokens.accessToken, query: VIEWER });
        if (attempt.cancelled) throw replaced();
        // Signing in to a workspace that is already connected replaces its token; the old grant is ended below.
        const id = String(organization.urlKey).toLowerCase();
        const scoped = store.workspace(id);
        previous = scoped.readToken();
        scoped.saveToken({
          // Linear may not echo the scopes: then the grant is what was asked for.
          scope: ["read", "write"],
          ...tokens,
          connectedAt: previous?.connectedAt ?? now(),
          viewer: { name: viewer.name, email: viewer.email },
          organization: { name: organization.name, urlKey: organization.urlKey },
        });
      } catch (error) {
        // Linear already issued a grant; without a saved token nothing here could ever end it.
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

  // Revoking the refresh token ends the whole grant; the access token is only a fallback if Linear refused that.
  async function endGrant(token) {
    if (!(await revoke(token.refreshToken, "refresh_token"))) await revoke(token.accessToken, "access_token");
  }

  return {
    status,
    workspaces,
    /** Whether one workspace's sign-in may change issues. */
    canWrite: (workspace) => workspaces().find((item) => item.id === workspace)?.canWrite === true,
    /** Queries one workspace as its connected user. */
    query: (workspace, document, variables) => clientOf(workspace).query(document, variables),
    /** Downloads a Linear upload as one workspace's connected user. */
    download: (workspace, url, options) => clientOf(workspace).download(url, options),
    /** `window`: sign in from the Mac app's own window with an empty session (Add workspace), not the browser. */
    async connect({ window = false } = {}) {
      if (!clientId) throw new LinearError("Linear sign-in isn't set up in this build.", "not-configured");
      // A second Connect replaces the first: the user may have closed the browser tab, and the callback port is fixed.
      // Newest call wins: with several in a row, each one cancels whichever registered last, until none is left.
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
    /** Ends one workspace's sign-in, or every one when no workspace is named (a window that predates workspaces). */
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
    /** Ends a waiting sign-in, e.g. when its window was closed. */
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
