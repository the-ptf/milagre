const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatHost } = require("./chat-host.cjs");
const { SessionManager } = require("./session-manager.cjs");
const { ProjectStates } = require("../project-states.cjs");
const { AcpRpc } = require("./acp-rpc.cjs");
const { AcpSession } = require("./acp-session.cjs");
const { antigravityAcp } = require("./antigravity-acp.cjs");
const { waitUntil } = require("./test-helpers.cjs");

// The chat wiring with a real ACP session over the fake agent: in its "slow" scenario each prompt runs until Stop
// (session/cancel) or fake/finish ends it.
const FAKE = path.join(__dirname, "fixtures", "fake-acp-agent.cjs");

function wiring(t) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-queue-acp-")));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-queue-acp-run-"));
  const saved = new Map();
  const states = new ProjectStates({
    read: async () => ({
      next_id: 2,
      projects: { 1: { id: 1, name: "alpha" } },
      worktrees: { 1: { id: 1, name: "main", path: project } },
      sessions: {},
      messages: [],
    }),
    save: async (projectPath, state) => void saved.set(projectPath, state),
  });
  const sessions = [];
  const manager = new SessionManager({
    createSession: (provider, options) => {
      const session = new AcpSession({
        ...options,
        clientVersion: "test",
        config: { ...antigravityAcp, tempRoot },
        createRpc: (rpc) => new AcpRpc({ ...rpc, command: process.execPath, args: [FAKE], env: { ...rpc.env, FAKE_SCENARIO: "slow" } }),
      });
      sessions.push(session);
      return session;
    },
    send: (chatId, event) => void host.receive(chatId, event),
    batchMs: 5,
  });
  const host = new ChatHost({
    states,
    startTurn: (request) => manager.startTurn({ ...request, command: "/opt/antigravity/agy_acp_server.par" }),
    publish: () => {},
    broadcast: () => {},
  });
  t.after(async () => {
    await manager.closeAll();
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const send = (body, sessionId = null) =>
    host.send({
      projectPath: project,
      sessionId,
      worktreeId: 1,
      body,
      images: [],
      provider: "antigravity",
      model: "gemini-3.8-flash-high",
      permissionMode: "auto",
    });
  const prompts = async () =>
    (await sessions[0].rpc.request("fake/received")).received
      .filter((message) => message.method === "session/prompt")
      .map((message) => message.params.prompt.at(-1).text);
  const session = (sessionId) => saved.get(project)?.sessions[sessionId];
  return { project, host, manager, send, prompts, session, saved };
}

test("over ACP, Stop keeps the queued message; Send now starts it, and the agent gets each message once", async (t) => {
  const { project, host, manager, send, prompts, session } = wiring(t);
  const chat = await send("build it");
  const chatId = `${project}#${chat.sessionId}`;
  await waitUntil(() => host.runs[chatId]?.text === "Working", { timeoutMs: 10_000 });

  const queued = await send("then add tests", chat.sessionId);
  assert.equal(queued.queued, true);
  await waitUntil(() => session(chat.sessionId)?.queued?.length === 1);
  assert.deepEqual(await prompts(), ["build it"]);

  await manager.interrupt(chatId);
  await waitUntil(() => session(chat.sessionId)?.queueHeld === true, { timeoutMs: 10_000 });
  assert.equal(host.runs[chatId], undefined);
  assert.deepEqual(await prompts(), ["build it"]);

  await host.sendQueuedNow(chatId, session(chat.sessionId).queued[0].id);
  await waitUntil(() => host.runs[chatId]?.text === "Working", { timeoutMs: 10_000 });
  assert.deepEqual(await prompts(), ["build it", "then add tests"]);
  assert.equal(session(chat.sessionId).queued, undefined);
  assert.equal((await queued.started).steered, false);
});

test("over ACP, a queued message starts the next turn when the running one completes", async (t) => {
  const { project, host, manager, send, prompts, session, saved } = wiring(t);
  const chat = await send("build it");
  const chatId = `${project}#${chat.sessionId}`;
  await waitUntil(() => host.runs[chatId]?.text === "Working", { timeoutMs: 10_000 });
  await send("then add tests", chat.sessionId);
  await waitUntil(() => session(chat.sessionId)?.queued?.length === 1);

  await manager.sessions.get(chatId).session.rpc.request("fake/finish");
  for (let i = 0; i < 500 && (await prompts()).length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await prompts(), ["build it", "then add tests"]);
  await waitUntil(() => saved.get(project).messages.filter((item) => item.role === "user").length === 2);
  assert.deepEqual(
    saved
      .get(project)
      .messages.filter((item) => item.session_id === chat.sessionId)
      .map((item) => [item.role, item.body]),
    [
      ["user", "build it"],
      ["assistant", "Working"],
      ["user", "then add tests"],
    ],
  );
});
