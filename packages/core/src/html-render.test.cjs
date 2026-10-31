const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createChatArtifacts } = require("./chat-artifacts.cjs");
const { htmlRenderToolDefinitions } = require("./html-render.cjs");
const { claudeStep, claudeStepResult, codexStep, codexStepResult } = require("./agents/steps.cjs");

test("HTML replies survive restart and live-page edits without entering the Artifact catalog", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "html-reply-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const create = () =>
    createChatArtifacts({
      directory,
      validateChat: async (id) => {
        if (id !== "chat") throw Error("Unknown chat");
      },
    });
  let api = create();
  const tools = Object.fromEntries(htmlRenderToolDefinitions("chat", api).map((t) => [t.name, t]));
  const first = JSON.parse(await tools.html_render.run({ title: "First", html: "<h1>First</h1>", height: 300 }));
  const second = JSON.parse(await tools.html_render.run({ title: "Second", html: "<h1>Second</h1>" }));
  assert.notEqual(first.id, second.id);
  assert.equal(first.inline, true);
  await assert.rejects(api.show({ chatId: "chat", id: first.id, title: "Overwrite", html: "changed" }), /immutable/);
  assert.deepEqual(await api.list({ chatId: "chat" }), []);
  await api.show({ chatId: "chat", title: "Report", html: "<p>Live</p>" });
  await api.show({ chatId: "chat", title: "Updated", html: "<p>Changed</p>" });
  await api.close();
  api = create();
  assert.equal((await api.get({ chatId: "chat", id: first.id })).html, "<h1>First</h1>");
  assert.equal((await api.get({ chatId: "chat", id: second.id })).html, "<h1>Second</h1>");
  assert.equal((await api.list({ chatId: "chat" })).length, 1);
  await assert.rejects(api.get({ chatId: "other", id: first.id }), /Unknown chat/);
  await assert.rejects(api.render({ chatId: "chat", title: "bad", html: "x", height: 9999 }), /Height/);
  await api.removeChat("chat");
  await assert.rejects(api.get({ chatId: "chat", id: first.id }), /no longer/);
  await api.close();
});

test("both provider transcripts preserve immutable HTML metadata and keep the document out of activity", () => {
  const args = { title: "Chart", html: "<p>Secret markup</p>", height: 320 };
  const ref = { id: "one", version: 1, title: "Chart", inline: true, height: 320, format: "html" };
  const name = "mcp__milagre__html_render";
  assert.equal(claudeStep("a", name, args).kind, "artifact");
  assert.equal(claudeStep("a", name, args).detail, undefined);
  assert.deepEqual(claudeStepResult({ id: "a", name, input: args }, { content: JSON.stringify(ref) }).artifact, ref);
  const call = {
    id: "b",
    type: "mcpToolCall",
    server: "milagre",
    tool: "html_render",
    arguments: args,
    status: "completed",
    result: { content: [{ type: "text", text: JSON.stringify(ref) }] },
  };
  assert.equal(codexStep(call).kind, "artifact");
  assert.deepEqual(codexStepResult(call).artifact, ref);
});

test("preview returns an image and diagnostics without storing a reply", async () => {
  const tools = htmlRenderToolDefinitions(
    "chat",
    {
      render() {
        throw Error("Preview must not publish");
      },
    },
    { preview: async () => ({ png: "aGVsbG8=", width: 390, contentHeight: 240, consoleMessages: [] }) },
  );
  const result = await tools[0].run({ html: "<p>x</p>", width: 390 });
  assert.equal(result.images[0].mime, "image/png");
  assert.equal(JSON.parse(result.text).contentHeight, 240);
});

test("HTML tools accept multibyte documents over MCP and deliver preview images to the provider", async (t) => {
  const { createLocalMcpServer } = require("./local-mcp-server.cjs");
  const html = `<p>${"é".repeat(600_000)}</p>`;
  const tools = htmlRenderToolDefinitions(
    "chat",
    { render: async (request) => ({ id: "one", inline: true, version: 1, title: request.title, characters: request.html.length }) },
    {
      preview: async (request) => {
        assert.equal(request.html, html);
        return { png: "aGVsbG8=", contentHeight: 240, width: 720, consoleMessages: [] };
      },
    },
  );
  const server = createLocalMcpServer({ authenticate: () => ({ id: "chat" }), toolsFor: () => tools });
  t.after(() => server.close());
  const url = await server.listen();
  const call = async (name) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: { html, ...(name === "html_render" ? { title: "Page" } : {}) } },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(!body.result.isError, JSON.stringify(body.result));
    return body.result.content;
  };
  assert.deepEqual((await call("html_preview"))[1], { type: "image", data: "aGVsbG8=", mimeType: "image/png" });
  assert.equal(JSON.parse((await call("html_render"))[0].text).characters, html.length);
});
