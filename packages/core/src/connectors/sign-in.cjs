const crypto = require("node:crypto");
const { auth } = require("@modelcontextprotocol/sdk/client/auth.js");
const { listenForCallback, ConnectorError } = require("./callback.cjs");

/** One browser sign-in: a loopback callback for this attempt, then the MCP SDK's discovery, registration and code exchange. */
async function runSignIn({ attempt, connector, port, timeoutMs, providerFor, openBrowser, fetchImpl }) {
  const state = crypto.randomBytes(16).toString("hex");
  const callback = await listenForCallback({ state, name: connector.name, port, timeoutMs });
  attempt.callback = callback;
  const cancelled = () => new ConnectorError("Replaced by a newer sign-in.", "cancelled");
  try {
    if (attempt.cancelled) throw cancelled();
    const provider = providerFor(connector, { redirectUrl: callback.redirectUri, state: () => state, redirect: (url) => openBrowser(String(url)) });
    const first = await auth(provider, { serverUrl: connector.url, fetchFn: fetchImpl });
    if (first === "AUTHORIZED") return;
    const code = await callback.code;
    if (attempt.cancelled) throw cancelled();
    await auth(provider, { serverUrl: connector.url, authorizationCode: code, fetchFn: fetchImpl });
  } finally {
    await callback.close();
  }
}

/** One sign-in at a time: the callback port is shared, so a new one replaces the one waiting. */
function createSignIns() {
  let pending = null;
  async function cancelPending() {
    const current = pending;
    current.cancel();
    await current.done.catch(() => {});
    if (pending === current) pending = null;
  }
  return {
    async run(start) {
      while (pending) await cancelPending();
      const attempt = { cancelled: false, callback: null };
      const done = start(attempt);
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
    async cancel() {
      while (pending) await cancelPending();
    },
  };
}

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

module.exports = { runSignIn, createSignIns, revokeTokens };
