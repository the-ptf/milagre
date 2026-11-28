const isTokenRequest = (init) => init?.body instanceof URLSearchParams && init.body.has("grant_type");

const json = (value, status) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/** Slack's token endpoint answers HTTP 200 with `{ok: false, error}` on failure and nests a user token under `authed_user`; the MCP SDK reads only standard OAuth. */
function standardTokenResponse(body, host, status) {
  if (body?.ok === false && typeof body.error === "string") {
    return json({ error: body.error, error_description: `${host} refused the sign-in: ${body.error}.` }, status >= 400 ? status : 400);
  }
  const user = body?.authed_user;
  if (status < 300 && typeof body?.access_token !== "string" && typeof user?.access_token === "string") {
    return json({ ...user, token_type: typeof user.token_type === "string" ? user.token_type : "Bearer" }, 200);
  }
  return null;
}

function tokenFetch(fetchImpl) {
  const base = fetchImpl ?? ((...args) => globalThis.fetch(...args));
  return async (url, init) => {
    const response = await base(url, init);
    if (!isTokenRequest(init) || !response.headers.get("content-type")?.includes("json")) return response;
    const body = await response
      .clone()
      .json()
      .catch(() => null);
    return standardTokenResponse(body, new URL(String(url)).host, response.status) ?? response;
  };
}

module.exports = { tokenFetch };
