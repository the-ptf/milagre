const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createLinkedReads, inputSchema, linkedToolDefinitions, runTool } = require("./linked-tools.cjs");
const { createLinkedMcpServer } = require("./linked-mcp-server.cjs");
const { configuredHelper } = require("./git/test-helpers.cjs");

async function linkedRepo(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-linked-tools-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const web = path.join(dir, "web");
  const hidden = path.join(dir, "hidden");
  for (const folder of [web, hidden]) {
    await fs.mkdir(folder);
    execFileSync("git", ["init", "-b", "main", folder], { stdio: "ignore" });
  }
  await fs.writeFile(path.join(web, "client.ts"), "export const health = () => fetch('/health');\nexport const other = 1;\n");
  await fs.writeFile(path.join(hidden, "secret.txt"), "do not read");
  await fs.symlink(path.join(hidden, "secret.txt"), path.join(web, "escape.txt"));
  execFileSync("git", ["-C", web, "add", "client.ts"], { stdio: "ignore" });
  execFileSync("git", ["-C", web, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Add client"], { stdio: "ignore" });
  await fs.appendFile(path.join(web, "client.ts"), "export const added = 2;\n");
  const state = {
    next_id: 4,
    worktrees: { 1: { id: 1, path: web, name: "main" } },
    sessions: {
      2: { id: 2, worktree_id: 1, agent_name: "main", status: "Created", provider: "codex" },
      3: { id: 3, worktree_id: 1, agent_name: "main", status: "Created", provider: "claude", archived: true },
    },
    messages: [
      { id: 4, session_id: 2, role: "user", body: "Add the health check", context: null },
      { id: 5, session_id: 2, role: "assistant", body: "Added it.", context: null },
      { id: 6, session_id: 3, role: "user", body: "Archived work", context: null },
    ],
  };
  const reads = createLinkedReads({
    sides: async (chatId) =>
      chatId === "api#1" ? [{ project_id: "web-id", worktree_path: web, link_id: "link", projectPath: web, projectName: "web", sourceWorktree: "/api" }] : [],
    state: async () => state,
    runs: () => ({ [`${web}#2`]: { approvals: [{}], questions: [] } }),
    receiveOnly: (key) => key === `${web}#2`,
    open: () => [],
  });
  return { web, hidden, reads };
}

for (const kind of ["external diff", "textconv", "fsmonitor", "clean", "process"]) {
  test(`linked Git never executes a configured ${kind} helper`, async (t) => {
    const { web, reads } = await linkedRepo(t);
    const { marker } = await configuredHelper(web, kind, "client.ts");
    let output, error;
    try {
      output = await reads.git("api#1", web, kind === "fsmonitor" ? "status" : "diff");
    } catch (caught) {
      error = caught;
    }
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
    assert.equal(error, undefined);
    assert.match(output, kind === "fsmonitor" ? /client\.ts/ : /\+export const added/);
  });
}

test("the read tools serve the linked Worktree: overview, Chats (archived too), git, files and search", async (t) => {
  const { web, reads } = await linkedRepo(t);
  const overview = await reads.overview("api#1");
  assert.match(overview, new RegExp(`Chat ${web}#2 "Add the health check" · Codex · waiting on the user · receive-only · last reply: "Added it."`));
  assert.doesNotMatch(overview, /Archived work/, "the summary leaves archived Chats out");
  assert.match(await reads.readChat("api#1", `${web}#3`), /archived[\s\S]*Archived work/, "an archived Chat stays readable");
  assert.match(await reads.readChat("api#1", `${web}#2`, { start: 2 }), /## 2 · Assistant\n\nAdded it\./);
  assert.match(await reads.git("api#1", web, "status"), /M client\.ts/);
  assert.match(await reads.git("api#1", web, "diff"), /\+export const added = 2;/);
  assert.match(await reads.git("api#1", web, "log", { limit: 1 }), /Add client/);
  assert.equal(await reads.readFile("api#1", web, "client.ts", { start: 2, end: 2 }), "2\texport const other = 1;");
  assert.match(await reads.search("api#1", web, "fetch('/health')"), /client\.ts:1:/);
  assert.equal(await reads.search("api#1", web, "nowhere-to-be-found"), "No matches.");
});

test("every read is refused outside the Worktrees the Chat can see", async (t) => {
  const { web, hidden, reads } = await linkedRepo(t);
  for (const read of [
    () => reads.git("other#1", web, "status"),
    () => reads.readFile("other#1", web, "client.ts"),
    () => reads.search("other#1", web, "health"),
    () => reads.readChat("other#1", `${web}#2`),
    () => reads.git("api#1", hidden, "status"),
  ]) {
    await assert.rejects(read, /isn't linked to this Chat|isn't in a linked Worktree/);
  }
  assert.equal(await reads.overview("other#1"), "No Worktrees are linked to this Chat.");
  await assert.rejects(reads.readFile("api#1", web, "../hidden/secret.txt"), /outside the linked Worktree/);
  await assert.rejects(reads.readFile("api#1", web, "escape.txt"), /outside the linked Worktree/, "a symlink can't lead out");
  await assert.rejects(reads.readFile("api#1", web, path.join(hidden, "secret.txt")), /relative to the linked Worktree/);
  await assert.rejects(reads.git("api#1", web, "diff", { path: "--output=/tmp/x" }), /relative to the linked Worktree/);
  await assert.rejects(reads.git("api#1", web, "push"), /Choose status, diff or log/);
  await assert.rejects(reads.search("api#1", web, "health", "--open-files-in-pager=sh"), /Give a glob/);
});

test("the tool definitions are read-only except delegate and conclude_negotiation, and check their input", async () => {
  const calls = [];
  const definitions = linkedToolDefinitions("api#1", {
    reads: {
      git: async (...args) => {
        calls.push(args);
        return "ok";
      },
    },
    delegations: {},
  });
  assert.deepEqual(
    definitions.filter((tool) => !tool.readOnly).map((tool) => tool.name),
    ["delegate", "conclude_negotiation"],
  );
  assert.deepEqual(
    definitions.filter((tool) => tool.readOnly).map((tool) => tool.name),
    ["linked_overview", "read_linked_chat", "linked_git", "read_linked_file", "search_linked_files"],
  );
  const linkedGit = definitions.find((tool) => tool.name === "linked_git");
  assert.deepEqual(inputSchema(linkedGit).properties.operation.enum, ["status", "diff", "log"]);
  const refused = await runTool(linkedGit, { worktree: "/web", operation: "reset" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /^Invalid arguments: operation/);
  assert.deepEqual(await runTool(linkedGit, { worktree: "/web", operation: "status" }), { text: "ok", images: [], isError: false });
  assert.deepEqual(calls, [["api#1", "/web", "status", {}]]);
});

test("Codex reaches the tools over loopback MCP, one unguessable path per Chat", async (t) => {
  const tools = { "api#1": [{ name: "linked_overview", description: "Summary", input: {}, readOnly: true, run: async () => "summary of web" }] };
  const server = createLinkedMcpServer({ toolsFor: (chatId) => tools[chatId] ?? [] });
  t.after(() => server.close());
  const url = await server.url("api#1");
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-f0-9]{48}$/);
  assert.equal(await server.url("api#1"), url);
  const call = (target, body) => fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const initialize = await (await call(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
  assert.equal(initialize.result.protocolVersion, "2025-06-18");
  assert.equal((await call(url, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const listed = await (await call(url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
  assert.deepEqual(listed.result.tools, [
    {
      name: "linked_overview",
      description: "Summary",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
  ]);
  const called = await (await call(url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "linked_overview", arguments: {} } })).json();
  assert.deepEqual(called.result, { content: [{ type: "text", text: "summary of web" }], isError: false });
  assert.equal((await call(url.replace(/[a-f0-9]{48}$/, "0".repeat(48)), { jsonrpc: "2.0", id: 4, method: "tools/list" })).status, 404);
});
test("a canvas endpoint exposes one canonical shared transcript and rejects unlinked Link refs", async () => {
  const { randomUUID } = require("node:crypto");
  const { scopeKey } = require("@milagre/shared/chat-scopes");
  const id = randomUUID(),
    owner = scopeKey({ kind: "link", linkId: id });
  const shared = {
    sessions: {
      7: { id: 7, title: "Across both", agent_name: "Link", provider: "codex", worktrees: [{ worktreePath: "/owned/api" }], workspacePath: "/workspace" },
    },
    messages: [{ id: 1, session_id: 7, role: "assistant", body: "Canonical reply", context: null }],
  };
  const project = { worktrees: { 1: { id: 1, path: "/owned/api", name: "feature", sharedChat: { linkId: id, sessionId: 7 } } }, sessions: {}, messages: [] };
  const reads = createLinkedReads({
    sides: async () => [{ projectPath: "/api", projectName: "API", worktree_path: "/owned/api" }],
    state: async (key) => (key === owner ? shared : project),
    runs: () => ({}),
    open: () => [],
    receiveOnly: () => false,
  });
  assert.match(await reads.overview("/external#2"), new RegExp(owner + "#7"));
  assert.match(await reads.readChat("/external#2", owner + "#7"), /Canonical reply/);
  await assert.rejects(reads.readChat("/external#2", scopeKey({ kind: "link", linkId: randomUUID() }) + "#7"), /isn't in a linked Worktree/);
});

test("runTool passes images through and mcpContent orders text before images", async () => {
  const { runTool, mcpContent } = require("./linked-tools.cjs");
  const definition = { name: "t", input: {}, run: async () => ({ text: '{"id":"a"}', images: [{ mime: "image/png", base64: "AAAA" }] }) };
  const result = await runTool(definition, {});
  assert.deepEqual(result, { text: '{"id":"a"}', images: [{ mime: "image/png", base64: "AAAA" }], isError: false });
  assert.deepEqual(mcpContent(result), [
    { type: "text", text: '{"id":"a"}' },
    { type: "image", data: "AAAA", mimeType: "image/png" },
  ]);
  assert.deepEqual((await runTool({ name: "s", input: {}, run: async () => "plain" }, {})).images, []);
  assert.deepEqual(
    await runTool(
      {
        name: "e",
        input: {},
        run: async () => {
          throw Error("boom");
        },
      },
      {},
    ),
    { text: "boom", images: [], isError: true },
  );
});

test("runTool reads text and images only from a plain object with a text key", async () => {
  const run = async (value) => (await runTool({ name: "v", input: {}, run: async () => value }, {})).text;
  assert.equal(await run(["a", "b"]), "a,b");
  assert.equal(await run({ id: "x" }), "[object Object]");
  assert.equal(await run(42), "42");
  assert.equal(await run(null), "null");
  assert.deepEqual(await runTool({ name: "t", input: {}, run: async () => ({ text: "only text" }) }, {}), { text: "only text", images: [], isError: false });
});

test("a Delegation report is how the reply ended, not the narration between its tool calls", () => {
  const { delegationReply } = require("./linked-tools.cjs");
  const narration = "Primeiro confiro a aprovação.\n\nDisparando o db-push na main.\n\n";
  const answer = "Tudo publicado e ligado na FLIM.";
  const body = `${narration}${answer}`;
  const messages = [
    { id: 1, session_id: 3, role: "user", body: "Do it", context: { kind: "delegation", delegationId: "d1" } },
    { id: 2, session_id: 3, role: "assistant", body: "Note", context: { kind: "linked-notice" } },
    {
      id: 3,
      session_id: 3,
      role: "assistant",
      body,
      context: null,
      steps: [
        { kind: "thinking", offset: body.length },
        { kind: "tool", offset: "Primeiro confiro a aprovação.\n\n".length },
        { kind: "tool", offset: narration.length },
      ],
    },
  ];
  assert.equal(delegationReply({ messages }, 3, "d1"), answer);
  // A reply that ended on a tool call reports its last stretch of text.
  const ended = { ...messages[2], body: narration, steps: [{ kind: "tool", offset: narration.length }] };
  assert.equal(delegationReply({ messages: [messages[0], ended] }, 3, "d1"), "Primeiro confiro a aprovação.\n\nDisparando o db-push na main.");
  assert.equal(delegationReply({ messages: [messages[0]] }, 3, "d1"), undefined);
});
