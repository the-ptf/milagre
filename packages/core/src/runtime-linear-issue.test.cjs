const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

const node = {
  identifier: "ENG-12",
  title: "Fix the login redirect",
  url: "https://linear.app/acme/issue/ENG-12/fix-the-login-redirect",
  branchName: "eng-12-fix-login",
  description: "Users bounce to /home.",
  state: { name: "In Progress", type: "started", color: "#f2c94c" },
};

async function fixture(t, { reachable = true } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-linear-issue-")));
  const project = path.join(dir, "project");
  const dataDir = path.join(dir, "data");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  // A signed-in Mac with the Experimental switch on, without running the OAuth flow.
  await fs.mkdir(path.join(dataDir, "linear", "workspaces"), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "linear", "workspaces", "acme.json"),
    JSON.stringify({
      connectedAt: 1,
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 86_400_000,
      viewer: { name: "Victor", email: "v@example.test" },
      organization: { name: "Acme", urlKey: "acme" },
    }),
  );
  await fs.writeFile(path.join(dataDir, "linear", "settings.json"), JSON.stringify({ enabled: true }));
  const turns = [];
  const sessions = [];
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  const runtime = createRuntime({
    dataDir,
    chatsHome: path.join(dir, "chats"),
    cwd: project,
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    linear: {
      clientId: "cid",
      apiBase: "https://api.test",
      port: 0,
      openBrowser: () => {},
      fetchImpl: async (_url, init) => {
        if (!reachable) throw new Error("offline");
        const { query } = JSON.parse(init.body);
        if (query.includes("teams(")) return json({ data: { teams: { nodes: [{ key: "ENG" }] } } });
        return json({ data: { i0: node } });
      },
    },
    createSession(_provider, options) {
      sessions.push(options);
      return {
        turnActive: false,
        startTurn: async (request) => {
          turns.push(request);
          options.emit({ type: "turn-started", turnId: "turn" });
          return { turnId: "turn" };
        },
        interrupt: async () => options.emit({ type: "turn-cancelled" }),
        close: async () => {},
      };
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const opened = await runtime.openProject(project);
  const sessionId = Object.values(opened.state.sessions)[0].id;
  const send = (extra) =>
    runtime.invoke("chat:send", [
      {
        projectPath: project,
        sessionId,
        body: "Work on Linear issue ENG-12: stale title",
        prompt: "Work on Linear issue ENG-12: stale title",
        images: [],
        files: [],
        provider: "codex",
        model: "test",
        permissionMode: "full",
        ...extra,
      },
    ]);
  const messages = async () => (await runtime.invoke("project:snapshot", [project])).state.messages.filter((m) => m.role === "user");
  return { send, turns, sessions, messages };
}

test("a Chat started from an issue stores Linear's copy as a card and points the agent at Milagre's Linear tools", async (t) => {
  const f = await fixture(t);
  await f.send({ linearIssue: { key: "eng-12", workspace: "acme", note: "check Safari too" } });
  await waitUntil(() => f.turns.length === 1);
  const [message] = await f.messages();
  assert.equal(message.body, `Work on Linear issue ENG-12: Fix the login redirect\n\nUsers bounce to /home.\n\n${node.url}\n\ncheck Safari too`);
  assert.deepEqual(message.context, {
    kind: "linear-issue",
    key: "ENG-12",
    title: node.title,
    url: node.url,
    state: node.state,
    workspace: "acme",
    note: "check Safari too",
  });
  // The Chat shows the issue as its first message; the agent gets the user's note first and the issue as data.
  assert.ok(f.turns[0].prompt.startsWith('The user asks: check Safari too\n\n<linear_issue key="ENG-12">'), f.turns[0].prompt);
  assert.match(f.turns[0].prompt, /Title: Fix the login redirect\nURL: .*\n\nUsers bounce to \/home\.\n<\/linear_issue>/);
  assert.match(f.turns[0].prompt, /linear_issue tool/);
  assert.match(f.turns[0].prompt, /not a Linear MCP or connector/);
});

test("the agent gets the Linear tools while Linear is on", async (t) => {
  const f = await fixture(t);
  await f.send({ linearIssue: { key: "ENG-12" } });
  await waitUntil(() => f.turns.length === 1);
  const names = f.sessions[0].linked?.tools?.map((tool) => tool.name);
  assert.ok(names, `session options carry the tools: ${Object.keys(f.sessions[0]).join(", ")}`);
  for (const name of ["linear_issue", "linear_search", "linear_file"]) assert.ok(names.includes(name), name);
});

test("when Linear can't answer, the Chat still starts with the text that was sent", async (t) => {
  const f = await fixture(t, { reachable: false });
  await f.send({ linearIssue: { key: "ENG-12" } });
  await waitUntil(() => f.turns.length === 1);
  const [message] = await f.messages();
  assert.equal(message.context, null);
  assert.equal(message.body, "Work on Linear issue ENG-12: stale title");
});

test("a malformed issue request is refused and a renderer can't set the context directly", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.send({ linearIssue: { key: "not a key" } }), /Linear issue isn't valid/);
  assert.deepEqual(await f.messages(), []);
  await f.send({ context: { kind: "linear-issue", key: "ENG-12", title: "x", url: node.url, state: node.state } });
  await waitUntil(() => f.turns.length === 1);
  assert.equal((await f.messages())[0].context, null);
});
