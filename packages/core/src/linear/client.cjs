const { LinearError } = require("./errors.cjs");
const { refreshTokens } = require("./oauth.cjs");

const REFRESH_MARGIN_MS = 5 * 60_000;
const notConnected = () => new LinearError("Linear isn't connected.", "not-connected");

async function postGraphql({ fetchImpl, apiBase, accessToken, query, variables = {} }) {
  let response;
  try {
    response = await fetchImpl(`${apiBase}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new LinearError(`Couldn't reach Linear: ${error.message}`, "offline");
  }
  if (response.status === 401) throw new LinearError("Linear isn't connected.", "revoked");
  const parsed = await response.json().catch(() => ({}));
  const body = parsed && typeof parsed === "object" ? parsed : {};
  const errors = Array.isArray(body.errors) ? body.errors : [];
  if (response.status === 429 || errors.some((error) => error?.extensions?.code === "RATELIMITED"))
    throw new LinearError("Linear is limiting requests. Try again in a minute.", "rate-limited");
  if (response.status >= 500) throw new LinearError("Linear is having trouble. Try again in a minute.", "offline");
  if (!response.ok || errors.length) {
    const error = new LinearError(errors[0]?.message || `Linear answered ${response.status}.`, "failed");
    error.extensions = errors[0]?.extensions;
    throw error;
  }
  return body.data;
}

function createLinearClient({ store, clientId, apiBase, fetchImpl = globalThis.fetch, now = Date.now, revoked = () => {} }) {
  let refreshing = null;
  let clearedToken = null;
  function signOut(accessToken) {
    if (store.readToken()?.accessToken === accessToken) {
      store.clearToken();
      if (clearedToken !== accessToken) {
        clearedToken = accessToken;
        revoked();
      }
    }
    return notConnected();
  }
  async function refresh(saved) {
    let next;
    try {
      next = { ...saved, ...(await refreshTokens({ fetchImpl, apiBase, clientId, refreshToken: saved.refreshToken, now: now() })) };
    } catch (error) {
      if (error.code === "revoked") throw signOut(saved.accessToken);
      throw error;
    }
    try {
      store.saveToken(next);
    } catch (error) {
      throw new LinearError(`Couldn't save the Linear sign-in: ${error.message}`, "failed");
    }
    return next;
  }
  function refreshShared(saved) {
    refreshing ??= refresh(saved).finally(() => (refreshing = null));
    return refreshing;
  }
  async function current() {
    const saved = store.readToken();
    if (!saved) throw notConnected();
    if (saved.expiresAt - now() > REFRESH_MARGIN_MS) return saved;
    return refreshShared(saved);
  }
  async function attempt(saved, run) {
    try {
      return await run(saved.accessToken);
    } catch (error) {
      if (error.code !== "revoked") throw error;
      const stored = store.readToken();
      if (!stored) throw notConnected();
      if (stored.accessToken !== saved.accessToken) return retryOnce(stored, run);
      const next = await refreshShared(stored);
      return retryOnce(next, run);
    }
  }
  async function retryOnce(saved, run) {
    try {
      return await run(saved.accessToken);
    } catch (error) {
      if (error.code === "revoked") throw signOut(saved.accessToken);
      throw error;
    }
  }
  return {
    async query(document, variables) {
      const saved = await current();
      return attempt(saved, (accessToken) => postGraphql({ fetchImpl, apiBase, accessToken, query: document, variables }));
    },
    async download(url, { maxBytes }) {
      const saved = await current();
      return attempt(saved, (accessToken) => getUpload({ fetchImpl, url, accessToken, maxBytes }));
    },
  };
}

async function getUpload({ fetchImpl, url, accessToken, maxBytes }) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new LinearError(`Couldn't reach Linear: ${error.message}`, "offline");
  }
  if (response.status === 401) throw new LinearError("Linear isn't connected.", "revoked");
  if (response.status === 403 || response.status === 404) throw new LinearError("This workspace has no such file.", "not-found");
  if (!response.ok) throw new LinearError(`Linear answered ${response.status}.`, "failed");
  if (Number(response.headers.get("content-length")) > maxBytes) throw new LinearError("That file is too big to download.", "failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new LinearError("That file is too big to download.", "failed");
  return { type: response.headers.get("content-type") ?? "", bytes };
}

module.exports = { postGraphql, createLinearClient };
