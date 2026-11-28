const crypto = require("node:crypto");
const http = require("node:http");
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

async function startFakeMcp({ registration = true, clientId = "preset-client", clientSecret, requireAuth = true, apiKey, slackTokens = false } = {}) {
  const state = { codes: new Map(), tokens: new Set(), refreshes: new Map(), registered: [], tokenRequests: [], revoked: [], toolCalls: [] };
  let origin;
  const json = (response, status, value, headers = {}) =>
    response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
  function mcpServer() {
    const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: "echo",
          description: "Echo text back",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
          annotations: { readOnlyHint: true },
        },
        { name: "post", description: "Post a message", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      state.toolCalls.push(request.params);
      return { content: [{ type: "text", text: `echo: ${request.params.arguments?.text ?? ""}` }] };
    });
    return server;
  }
  function issue() {
    const access = crypto.randomBytes(12).toString("hex");
    const refresh = crypto.randomBytes(12).toString("hex");
    state.tokens.add(access);
    state.refreshes.set(refresh, access);
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 };
  }
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, origin);
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp")
      return json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read", "write"] });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        revocation_endpoint: `${origin}/revoke`,
        ...(registration ? { registration_endpoint: `${origin}/register` } : {}),
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: clientSecret ? ["client_secret_post"] : ["none"],
      });
    if (url.pathname === "/register" && request.method === "POST") {
      if (!registration) return json(response, 400, { error: "invalid_request", error_description: "Dynamic client registration not supported" });
      const metadata = JSON.parse(await readBody(request));
      const client = { ...metadata, client_id: `dcr-${state.registered.length + 1}` };
      state.registered.push(client);
      return json(response, 201, client);
    }
    if (url.pathname === "/authorize") {
      const params = url.searchParams;
      const code = crypto.randomBytes(8).toString("hex");
      state.codes.set(code, { challenge: params.get("code_challenge"), clientId: params.get("client_id"), scope: params.get("scope") });
      const target = new URL(params.get("redirect_uri"));
      target.searchParams.set("code", code);
      target.searchParams.set("state", params.get("state"));
      return response.writeHead(302, { location: target.href }).end();
    }
    if (url.pathname === "/token" && request.method === "POST") {
      const answer = (status, value) =>
        slackTokens
          ? json(response, 200, status === 200 ? { ok: true, authed_user: { ...value, token_type: "user" } } : { ok: false, error: value.error })
          : json(response, status, value);
      const params = new URLSearchParams(await readBody(request));
      state.tokenRequests.push(Object.fromEntries(params));
      if (clientSecret && params.get("client_secret") !== clientSecret) return answer(401, { error: slackTokens ? "bad_client_secret" : "invalid_client" });
      if (params.get("grant_type") === "authorization_code") {
        const entry = state.codes.get(params.get("code"));
        state.codes.delete(params.get("code"));
        const challenge = crypto
          .createHash("sha256")
          .update(params.get("code_verifier") ?? "")
          .digest("base64url");
        if (!entry || entry.challenge !== challenge || entry.clientId !== params.get("client_id")) return answer(400, { error: "invalid_grant" });
        return answer(200, issue());
      }
      if (params.get("grant_type") === "refresh_token") {
        const previous = state.refreshes.get(params.get("refresh_token"));
        if (!previous) return answer(400, { error: "invalid_grant" });
        state.refreshes.delete(params.get("refresh_token"));
        state.tokens.delete(previous);
        return answer(200, issue());
      }
      return answer(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/revoke" && request.method === "POST") {
      state.revoked.push(Object.fromEntries(new URLSearchParams(await readBody(request))));
      return response.writeHead(200).end();
    }
    if (url.pathname === "/mcp") {
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
      if (apiKey && request.headers["x-api-key"] !== apiKey) return json(response, 403, { error: "forbidden" });
      if (requireAuth && !state.tokens.has(bearer))
        return json(
          response,
          401,
          { error: "invalid_token" },
          { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` },
        );
      const body = request.method === "POST" ? JSON.parse(await readBody(request)) : undefined;
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = mcpServer();
      response.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      return transport.handleRequest(request, response, body);
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/mcp`,
    state,
    clientId,
    expire() {
      state.tokens.clear();
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const followInBrowser = (url) => {
  void fetch(url, { redirect: "follow" }).catch(() => {});
};

module.exports = { startFakeMcp, followInBrowser };
