const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { validateDesignDocument } = require("@milagre/shared/design");
const { createChatArtifacts, artifactToolDefinitions } = require("./chat-artifacts.cjs");
const { createLinkedMcpServer, MAX_BODY, MAX_DESIGN_BODY } = require("./linked-mcp-server.cjs");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "design-mcp-"));
  const api = createChatArtifacts({ directory, validateChat: async () => {} });
  const server = createLinkedMcpServer({ toolsFor: (chatId) => artifactToolDefinitions(chatId, api) });
  t.after(async () => {
    await server.close();
    await api.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = await server.url("/fixture#1");
  return { api, url };
}

test("the live MCP endpoint removes Designs tools while off and never exposes retired HTML tools", async (t) => {
  const { api, url } = await fixture(t);
  let id = 0;
  const request = async (method, params = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.error, undefined);
    return payload.result;
  };
  const list = () => request("tools/list");
  const call = (name, args) => request("tools/call", { name, arguments: args });
  const names = (result) => result.tools.map((tool) => tool.name);
  assert.deepEqual(names(await list()), [
    "design_show",
    "design_read",
    "design_apply",
    "design_export",
    "design_delete",
    "artifact_comments",
    "artifact_resolve_comment",
  ]);
  const document = {
    schemaVersion: 1,
    width: 390,
    height: 844,
    nodes: [{ id: "heading", type: "text", width: 340, height: 48, text: "Welcome" }],
  };
  const shown = await call("design_show", { id: "welcome", title: "Welcome", document });
  assert.equal(shown.isError, false);
  assert.equal(JSON.parse(shown.content[0].text.split("\n", 1)[0]).format, "design");
  await api.setEnabled(false);
  assert.deepEqual(names(await list()), []);
  for (const name of ["design_show", "design_read", "design_apply", "artifact_show", "artifact_read"]) {
    const rejected = await call(name, { id: "welcome", expectedVersion: 1, operations: [{ op: "delete", id: "heading" }] });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /Unknown tool/);
  }
  await api.setEnabled(true);
  assert.equal(names(await list()).length, 7);
  const read = await call("design_read", { id: "welcome" });
  assert.equal(read.isError, false);
  const source = JSON.parse(read.content[0].text);
  assert.equal(source.version, 1);
  assert.deepEqual(
    source.document.nodes.map((node) => node.id),
    ["heading"],
  );
  assert.equal(source.html, undefined);
  for (const name of ["artifact_show", "artifact_read"]) assert.equal((await call(name, {})).isError, true);
});

test("MCP accepts maximum-sized design documents encoded as UTF-8 and escaped JSON", async (t) => {
  const { api, url } = await fixture(t);
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
  assert.equal(JSON.stringify(validateDesignDocument(document)).length, 1000000);
  for (const encoding of ["utf8", "escaped"]) {
    let body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "design_show", arguments: { id: encoding, title: encoding, document } },
    });
    if (encoding === "escaped") body = body.replaceAll("界", "\\u754c");
    assert.ok(Buffer.byteLength(body) > MAX_BODY);
    assert.ok(Buffer.byteLength(body) <= MAX_DESIGN_BODY);
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    assert.equal(result.isError, false, result.content[0].text);
    assert.equal((await api.get({ chatId: "/fixture#1", id: encoding })).document.nodes[1].src, document.nodes[1].src);
    let editBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "design_show", arguments: { id: encoding, title: encoding, expectedVersion: 1, document } },
    });
    if (encoding === "escaped") editBody = editBody.replaceAll("界", "\\u754c");
    const editResponse = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: editBody });
    assert.equal(editResponse.status, 200);
    const editResult = (await editResponse.json()).result;
    assert.equal(editResult.isError, false, editResult.content[0].text);
    assert.equal(JSON.parse(editResult.content[0].text.split("\n", 1)[0]).version, 2);
  }
});

test("oversized MCP requests return bounded JSON-RPC errors and other tools keep the smaller cap", async (t) => {
  const { api, url } = await fixture(t);
  const assertTooLarge = (status, text, limit) => {
    assert.equal(status, 413);
    assert.ok(Buffer.byteLength(text) < 256);
    assert.deepEqual(JSON.parse(text), {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Request exceeds the " + limit + "-byte MCP limit." },
    });
  };
  const ordinary = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", padding: "x".repeat(MAX_BODY) });
  const ordinaryResponse = await fetch(url, { method: "POST", body: ordinary });
  assertTooLarge(ordinaryResponse.status, await ordinaryResponse.text(), MAX_BODY);

  const oversized = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "design_show", arguments: { padding: "界".repeat(Math.ceil(MAX_DESIGN_BODY / 3)) } },
  });
  const response = await fetch(url, { method: "POST", body: oversized });
  assertTooLarge(response.status, await response.text(), MAX_DESIGN_BODY);
  // No Content-Length header: the streaming byte counter must reject before retaining the whole body.
  const streamed = await new Promise((resolve, reject) => {
    const request = http.request(url, { method: "POST", headers: { "transfer-encoding": "chunked" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end(oversized);
  });
  assertTooLarge(streamed.status, streamed.text, MAX_DESIGN_BODY);
  assert.deepEqual(await api.list({ chatId: "/fixture#1" }), []);
  const healthy = await fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }) });
  assert.deepEqual(await healthy.json(), { jsonrpc: "2.0", id: 3, result: {} });
});
