const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

const url = "https://github.com/the-ptf/milagre-ade/pull/77";

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-pr-action-")));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const turns = [];
  const runtime = createRuntime({
    dataDir: path.join(dir, "data"),
    chatsHome: path.join(dir, "chats"),
    cwd: project,
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    createSession(_provider, options) {
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
        body: "typed",
        prompt: "typed",
        images: [],
        files: [],
        provider: "codex",
        model: "test",
        permissionMode: "full",
        ...extra,
      },
    ]);
  const messages = async () => (await runtime.invoke("project:snapshot", [project])).state.messages.filter((m) => m.role === "user");
  return { send, turns, messages };
}

test("a PR action is stored as a card and the agent gets the bundled skill", async (t) => {
  const f = await fixture(t);
  await f.send({ prAction: { action: "checks-failed", pr: 77, url } });
  await waitUntil(() => f.turns.length === 1);
  const [message] = await f.messages();
  assert.equal(message.body, "Fix CI on pull request #77");
  assert.deepEqual(message.context, { kind: "pr-action", action: "checks-failed", pr: 77, url });
  assert.ok(f.turns[0].prompt.startsWith(`Fix CI on pull request #77 (${url}). /milagre-fix-ci`));
  assert.match(f.turns[0].prompt, /Skill \/milagre-fix-ci/);
  assert.match(f.turns[0].prompt, /gh run view <run-id> --log-failed/);
  assert.doesNotMatch(f.turns[0].prompt, /^typed/);
});

test("an invalid PR action is refused and nothing is stored", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.send({ prAction: { action: "checks-failed", pr: 78, url } }), /pull request action isn't valid/);
  await assert.rejects(f.send({ prAction: { action: "deploy", pr: 77, url } }), /pull request action isn't valid/);
  assert.deepEqual(await f.messages(), []);
  assert.equal(f.turns.length, 0);
});

test("a renderer can't set a pr-action context directly", async (t) => {
  const f = await fixture(t);
  await f.send({ context: { kind: "pr-action", action: "behind", pr: 77, url } });
  await waitUntil(() => f.turns.length === 1);
  const [message] = await f.messages();
  assert.equal(message.context, null);
  assert.equal(message.body, "typed");
});
