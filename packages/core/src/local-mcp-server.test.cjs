const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

test("HTTP MCP binds loopback, authenticates and rejects hostile origins, hosts and oversized bodies", async (t) => {
  const { createLocalMcpServer } = require("./local-mcp-server.cjs");
  const server = createLocalMcpServer({
    authenticate: (token) => {
      if (token !== "secret") throw Error("Unauthorized");
      return { id: "c" };
    },
    toolsFor: () => [],
  });
  t.after(() => server.close());
  const url = await server.listen();
  assert.equal(new URL(url).hostname, "127.0.0.1");
  const call = (headers = {}, body = { jsonrpc: "2.0", id: 1, method: "tools/list" }) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer secret", ...headers },
      body: JSON.stringify(body),
    });
  assert.deepEqual((await (await call()).json()).result.tools, []);
  assert.equal((await call({ authorization: "Bearer wrong" })).status, 401);
  assert.equal((await call({ origin: "https://evil.example" })).status, 403);
  assert.equal((await call({ origin: "null" })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    const req = http.request(url, { method: "POST", headers: { host: "evil.example", authorization: "Bearer secret" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end("{}");
  });
  assert.equal(badHost, 403);
  assert.equal((await call({}, { payload: "x".repeat(1024 * 1024 + 1) })).status, 413);
  assert.equal((await call({ "mcp-protocol-version": "invalid" })).status, 400);
  assert.equal((await fetch(url, { headers: { authorization: "Bearer secret" } })).status, 405);
  const initialized = await (await call({}, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } })).json();
  assert.equal(initialized.result.protocolVersion, "2025-06-18");
});

test("unknown management tools cannot run on a design-only connection", async (t) => {
  const { createLocalMcpServer } = require("./local-mcp-server.cjs");
  const server = createLocalMcpServer({
    authenticate: () => ({ id: "design" }),
    toolsFor: () => [{ name: "design_list", input: {}, readOnly: true, run: () => "[]" }],
  });
  t.after(() => server.close());
  const url = await server.listen();
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: "Bearer token", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "worktree_create", arguments: {} } }),
  });
  assert.equal((await response.json()).result.isError, true);
});

test("revocation after headers rejects a slow request before tool admission", async (t) => {
  const { createLocalMcpServer } = require("./local-mcp-server.cjs");
  const admitted = Promise.withResolvers();
  let revoked = false,
    listed = false;
  const server = createLocalMcpServer({
    authenticate: () => {
      if (revoked) throw Error("Unauthorized");
      admitted.resolve();
      return { id: "c", revision: 1 };
    },
    toolsFor: () => {
      listed = true;
      return [];
    },
  });
  t.after(() => server.close());
  const url = await server.listen();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(
      url,
      {
        method: "POST",
        headers: {
          authorization: "Bearer token",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(body),
        },
      },
      (reply) => {
        reply.resume();
        resolve(reply.statusCode);
      },
    );
    request.on("error", reject);
    request.write(body.slice(0, 1));
  });
  await admitted.promise;
  revoked = true;
  request.end(body.slice(1));
  assert.equal(await response, 401);
  assert.equal(listed, false);
});

test("the MCP SDK initializes, discovers and calls tools using a bearer header", async (t) => {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { createLocalMcpServer } = require("./local-mcp-server.cjs");
  const server = createLocalMcpServer({
    authenticate: (token) => {
      if (token !== "sdk-token") throw Error("Unauthorized");
      return { id: "connection" };
    },
    toolsFor: () => [{ name: "design_list", description: "List permitted designs", input: {}, readOnly: true, run: () => '[{"id":"allowed"}]' }],
  });
  t.after(() => server.close());
  const client = new Client({ name: "local-mcp-test", version: "1" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(await server.listen()), { requestInit: { headers: { Authorization: "Bearer sdk-token" } } }));
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["design_list"],
  );
  assert.equal((await client.callTool({ name: "design_list", arguments: {} })).content[0].text, '[{"id":"allowed"}]');
});

for (const transport of ["external", "internal"]) {
  test(`${transport} MCP accepts one maximum-size design call and bounds all other bodies`, async (t) => {
    const { z } = require("zod");
    const { createLocalMcpServer } = require("./local-mcp-server.cjs");
    const ordinaryLimit = 1024 * 1024;
    const designLimit = 6 * 1000000 + 64 * 1024;
    let calls = 0;
    let enabled = true;
    const prefix = "https://example.invalid/";
    const document = {
      schemaVersion: 1,
      width: 390,
      height: 844,
      nodes: [
        { id: "first", type: "image", width: 10, height: 10, src: prefix + "界".repeat(500000 - prefix.length) },
        { id: "second", type: "image", width: 10, height: 10, src: prefix },
      ],
    };
    document.nodes[1].src += "界".repeat(1000000 - JSON.stringify(document).length);
    assert.equal(JSON.stringify(document).length, 1000000);
    // The Designs schema/store lives on the linked branch. This transport fixture verifies
    // exact decoding without duplicating that schema or granting access based on body size.
    const definitions = ["design_show", "design_apply"].map((name) => ({
      name,
      input: { document: z.unknown() },
      run: (args) => {
        assert.deepEqual(args.document, document);
        calls++;
        return "accepted";
      },
    }));
    const toolsFor = () => (enabled ? definitions : []);
    const server = createLocalMcpServer({
      authenticate: (token) => (token === "secret" ? { id: "external", revision: 1 } : null),
      toolsFor,
      internalConnection: (token) => (token === "a".repeat(48) ? { id: "internal", revision: 1, tools: toolsFor } : null),
    });
    t.after(() => server.close());
    const base = await server.listen();
    const url = transport === "internal" ? `${base}/${"a".repeat(48)}` : base;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(transport === "external" ? { authorization: "Bearer secret" } : {}),
    };
    const send = (body) => fetch(url, { method: "POST", headers, body });
    const message = (name) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { document } } });
    for (const encoding of ["utf8", "escaped"]) {
      for (const name of ["design_show", "design_apply"]) {
        let body = JSON.stringify(message(name));
        if (encoding === "escaped") body = body.replaceAll("界", "\\u754c");
        assert.ok(Buffer.byteLength(body) > ordinaryLimit && Buffer.byteLength(body) < designLimit);
        const response = await send(body);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).result.isError, false);
      }
    }
    assert.equal(calls, 4);
    const tooLarge = async (response, limit) => {
      assert.equal(response.status, 413);
      const text = await response.text();
      assert.ok(Buffer.byteLength(text) < 256);
      assert.deepEqual(JSON.parse(text), { jsonrpc: "2.0", id: null, error: { code: -32000, message: `Request exceeds the ${limit}-byte MCP limit.` } });
    };
    for (const body of [
      "x".repeat(ordinaryLimit + 1),
      JSON.stringify(message("chat_start")),
      JSON.stringify([message("design_show")]),
      JSON.stringify([message("design_show"), { jsonrpc: "2.0", id: 2, method: "ping" }]),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", padding: "x".repeat(ordinaryLimit) }),
    ])
      await tooLarge(await send(body), ordinaryLimit);
    const oversized = JSON.stringify({ ...message("design_show"), padding: "界".repeat(Math.ceil(designLimit / 3)) });
    await tooLarge(await send(oversized), designLimit);
    // Explicit chunked transfer exercises byte counting independently of Content-Length.
    const streamed = await new Promise((resolve, reject) => {
      const request = http.request(url, { method: "POST", headers: { ...headers, "transfer-encoding": "chunked" } }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, text: async () => Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject);
      request.end(oversized);
    });
    await tooLarge(streamed, designLimit);
    assert.equal(calls, 4);
    enabled = false;
    const unavailable = await send(JSON.stringify(message("design_show")));
    assert.equal((await unavailable.json()).result.isError, true);
    assert.equal(calls, 4);
    assert.deepEqual((await (await send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }))).json()).result, {});
  });
}
