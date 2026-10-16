const crypto = require("node:crypto");
const http = require("node:http");
const { LinearError } = require("./errors.cjs");

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const CALLBACK_PATH = "/linear/callback";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

function createPkce(random = crypto.randomBytes) {
  const verifier = random(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeUrl({ clientId, redirectUri, state, challenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    // write: moving an issue to its team's started status when a Chat starts from it (Settings › Connections › Linear).
    scope: "read,write",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params}`;
}

// The Milagre mark, inline: the callback page is served from the loopback server and loads nothing else.
const MARK = `<svg width="40" height="40" viewBox="0 0 146 145" fill="currentColor" aria-hidden="true"><path d="M69.528 1.96636C71.0759 -0.655453 74.869 -0.655453 76.4169 1.96636L91.0103 26.6837C91.3538 27.2656 91.8392 27.751 92.4211 28.0945L117.138 42.6879C119.76 44.2358 119.76 48.0289 117.138 49.5768L92.4211 64.1702C91.8392 64.5137 91.3538 64.9991 91.0103 65.581L76.4169 90.2983C74.869 92.9201 71.0759 92.9201 69.528 90.2983L54.9347 65.581C54.5911 64.9991 54.1057 64.5137 53.5238 64.1702L28.8065 49.5768C26.1847 48.0289 26.1847 44.2358 28.8065 42.6879L53.5238 28.0945C54.1057 27.751 54.5911 27.2656 54.9347 26.6837L69.528 1.96636Z"/><path d="M49.6983 66.5562L21.6836 116.174C19.802 119.507 22.2098 123.632 26.0372 123.632H39.9727L54.9727 100.132L66.9727 119.632L51.9727 144.132H26.0372C6.24066 144.132 -6.29344 122.89 3.27837 105.561L30.9405 55.4819L49.6983 66.5562Z"/><path d="M142.666 105.561C152.238 122.89 139.704 144.132 119.907 144.132H93.9728L78.9728 119.632L90.9728 100.132L105.973 123.632H119.907C123.735 123.632 126.143 119.507 124.261 116.174L96.2462 66.5562L115.004 55.4819L142.666 105.561Z"/></svg>`;

// A browser won't let this tab close itself (Linear opened it, not a script), so the page only says where to go next.
const page = (title, text) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Milagre</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--ink:#14161b;--ink-3:#6b7280}
@media (prefers-color-scheme:dark){:root{--bg:#0f1117;--ink:#eef0f4;--ink-3:#8b919d}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{display:flex;flex-direction:column;align-items:center;gap:6px;padding:24px;text-align:center}
svg{margin-bottom:18px}
h1{margin:0;font-size:17px;font-weight:600}
p{margin:0;color:var(--ink-3)}
</style>
<main>${MARK}<h1>${title}</h1><p>${text}</p></main></html>`;

// One sign-in's callback: a loopback server that answers requests carrying the right state until the caller closes it.
async function listenForCallback({ state, port = 47615, timeoutMs = 300_000 }) {
  let settle;
  const code = new Promise((resolve, reject) => (settle = { resolve, reject }));
  code.catch(() => {});
  const server = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const answer = (status, title, text) => response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page(title, text));
    const params = url.searchParams;
    // A stale tab from an earlier attempt: refuse it, keep waiting for this one.
    if (params.get("state") !== state) return answer(400, "This link is out of date", "Start again from Milagre.");
    if (params.get("error")) {
      answer(200, "Sign-in cancelled", "You can close this tab.");
      settle.reject(new LinearError(`Linear sign-in failed: ${params.get("error_description") || params.get("error")}`, "failed"));
      return;
    }
    const value = params.get("code");
    if (!value) return answer(400, "Linear didn't send a sign-in code", "Start again from Milagre.");
    answer(200, "Signed in to Linear", "You can close this tab and go back to Milagre.");
    settle.resolve(value);
  });
  await new Promise((resolve, reject) => {
    server.once("error", (error) =>
      reject(error.code === "EADDRINUSE" ? new LinearError(`Port ${port} is in use. Close the app using it and try again.`, "failed") : error),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  const timer = setTimeout(() => settle.reject(new LinearError("Linear sign-in timed out. Try again.", "failed")), timeoutMs);
  timer.unref();
  let closed = null;
  const close = () =>
    (closed ??= new Promise((resolve) => {
      clearTimeout(timer);
      server.close(() => resolve());
      server.closeAllConnections();
    }));
  return {
    redirectUri: `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`,
    code,
    close,
    cancel() {
      settle.reject(new LinearError("Replaced by a newer Linear sign-in.", "cancelled"));
      return close();
    },
  };
}

async function tokenRequest({ fetchImpl, apiBase, params, now }) {
  let response;
  try {
    response = await fetchImpl(`${apiBase}/oauth/token`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new LinearError(`Couldn't reach Linear: ${error.message}`, "offline");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.access_token !== "string") {
    if (response.status === 429) throw new LinearError("Linear is limiting requests. Try again in a minute.", "rate-limited");
    if (response.status >= 500) throw new LinearError("Linear is having trouble. Try again in a minute.", "offline");
    const message = body.error_description || body.error || `Linear answered ${response.status}.`;
    // Only a refresh that Linear refuses means the grant is gone and only signing in again helps.
    // A failed code exchange is a failed sign-in, whatever the error says.
    const refused = body.error === "invalid_grant" || response.status === 401;
    const revoked = params.grant_type === "refresh_token" && refused;
    throw new LinearError(`Linear sign-in failed: ${message}`, revoked ? "revoked" : "failed");
  }
  // A refresh answer without a new refresh token leaves the old one in place.
  const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : params.refresh_token;
  const scope = grantedScopes(body.scope);
  return { accessToken: body.access_token, refreshToken, expiresAt: now + Number(body.expires_in ?? 86_400) * 1000, ...(scope ? { scope } : {}) };
}

// Linear sends the granted scopes as a list or a comma or space separated string; null when it sends none.
function grantedScopes(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : null;
  return list ? list.filter((item) => typeof item === "string" && item) : null;
}

function exchangeCode({ fetchImpl, apiBase, clientId, code, redirectUri, verifier, now }) {
  const params = { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier };
  return tokenRequest({ fetchImpl, apiBase, params, now });
}

function refreshTokens({ fetchImpl, apiBase, clientId, refreshToken, now }) {
  return tokenRequest({ fetchImpl, apiBase, params: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }, now });
}

// Ends one token's grant and says whether Linear accepted it. Linear takes only `token` and `token_type_hint`:
// with a client_id or a Bearer header the access token kept working. Revoking the refresh token ends the whole grant.
async function revokeToken({ fetchImpl, apiBase, token, hint }) {
  try {
    const response = await fetchImpl(`${apiBase}/oauth/revoke`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ token, token_type_hint: hint }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok === true;
  } catch {
    return false;
  }
}

module.exports = { createPkce, authorizeUrl, listenForCallback, exchangeCode, refreshTokens, revokeToken };
