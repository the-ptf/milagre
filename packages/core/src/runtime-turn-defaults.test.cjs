const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-runtime-turn-defaults-")));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const runtimes = [];
  const turns = [];
  let created = 0;
  let holdNext = false;
  let finishHeld;
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function make() {
    const runtime = createRuntime({
      dataDir: path.join(dir, "data"),
      chatsHome: path.join(dir, "chats"),
      cwd: project,
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: async () => ({ command: "fixture" }),
      createSession(_provider, options) {
        created++;
        return {
          turnActive: false,
          startTurn: async (request) => {
            turns.push({ replies: request.replies, tldrEnabled: options.tldrEnabled });
            options.emit({ type: "turn-started", turnId: `turn-${turns.length}` });
            if (holdNext) {
              holdNext = false;
              finishHeld = () => options.emit({ type: "turn-completed" });
            } else options.emit({ type: "turn-completed" });
            return { turnId: `turn-${turns.length}` };
          },
          close: async () => {},
        };
      },
    });
    runtimes.push(runtime);
    const opened = await runtime.openProject(project);
    const sessionId = Object.values(opened.state.sessions)[0].id;
    const worktreeId = opened.state.sessions[sessionId].worktree_id;
    const request = (extra = {}) =>
      runtime.invoke("chat:send", [
        {
          projectPath: project,
          sessionId,
          body: "hello",
          prompt: "hello",
          images: [],
          files: [],
          provider: "claude",
          model: "test",
          permissionMode: "full",
          ...extra,
        },
      ]);
    return {
      runtime,
      worktreeId,
      request,
      async send(extra = {}, waitForEnd = true) {
        const count = turns.length;
        await request(extra);
        await waitUntil(() => turns.length === count + 1);
        if (waitForEnd) await waitUntil(() => Object.keys(runtime.snapshot().runs.runs).length === 0);
        return turns.at(-1);
      },
    };
  }
  return {
    make,
    dir,
    turns,
    created: () => created,
    holdNextTurn: () => {
      holdNext = true;
    },
    finishHeld: () => finishHeld(),
  };
}

test("phone turns inherit desktop choices without reopening the session, including after a runtime restart", async (t) => {
  const f = await fixture(t);
  const { make } = f;
  const first = await make();
  assert.deepEqual(await first.send(), { replies: "concise", tldrEnabled: true });
  assert.deepEqual(await first.send({ replies: "normal", tldrEnabled: false }), { replies: "normal", tldrEnabled: false });
  const beforePhone = f.created();
  assert.deepEqual(await first.send({ sentFrom: "phone" }), { replies: "normal", tldrEnabled: false });
  assert.equal(f.created(), beforePhone, "switching to the phone keeps the provider session");
  await first.runtime.close();
  const restarted = await make();
  assert.deepEqual(await restarted.send({ sentFrom: "phone" }), { replies: "normal", tldrEnabled: false });
  assert.deepEqual(await restarted.send({ replies: "concise", tldrEnabled: true }), { replies: "concise", tldrEnabled: true });
  assert.deepEqual(await restarted.send({ sentFrom: "phone" }), { replies: "concise", tldrEnabled: true });
});

test("a queued release keeps its explicit turn options without overwriting the user's newer defaults", async (t) => {
  const f = await fixture(t);
  const chat = await f.make();
  f.holdNextTurn();
  await chat.send({ replies: "concise", tldrEnabled: true }, false);
  await chat.request({ delivery: "queue", replies: "concise", tldrEnabled: true });
  await chat.send({ sessionId: null, worktreeId: chat.worktreeId, replies: "normal", tldrEnabled: false }, false);
  const file = path.join(f.dir, "data", "turn-defaults.json");
  const saved = await fs.readFile(file, "utf8");
  assert.deepEqual(JSON.parse(saved), { replies: "normal", tldrEnabled: false }, "client send saves its explicit choices");
  f.finishHeld();
  await waitUntil(() => f.turns.length === 3);
  await waitUntil(() => Object.keys(chat.runtime.snapshot().runs.runs).length === 0);
  assert.deepEqual(f.turns[2], { replies: "concise", tldrEnabled: true });
  assert.equal(await fs.readFile(file, "utf8"), saved, "host replay leaves the saved choices unchanged");
  assert.deepEqual(await chat.send({ sentFrom: "phone" }), { replies: "normal", tldrEnabled: false });
});

test("a preference write failure never rejects a client send", async (t) => {
  const f = await fixture(t);
  const chat = await f.make();
  const file = path.join(f.dir, "data", "turn-defaults.json");
  await fs.mkdir(file);
  const warning = t.mock.method(console, "warn", () => {});
  assert.deepEqual(await chat.send({ replies: "normal", tldrEnabled: false }), { replies: "normal", tldrEnabled: false });
  assert.deepEqual(await chat.send({ sentFrom: "phone" }), { replies: "normal", tldrEnabled: false });
  assert.ok(warning.mock.calls.some((call) => call.arguments[0] === "Could not save turn defaults:"));
  assert.deepEqual(
    (await fs.readdir(path.dirname(file))).filter((name) => name.startsWith("turn-defaults.json.")),
    [],
  );
});
