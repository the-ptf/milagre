const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

test("phone turns inherit desktop choices without reopening the session, including after a runtime restart", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-runtime-turn-defaults-")));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const runtimes = [];
  const turns = [];
  let created = 0;
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
            options.emit({ type: "turn-completed" });
            return { turnId: `turn-${turns.length}` };
          },
          close: async () => {},
        };
      },
    });
    runtimes.push(runtime);
    const opened = await runtime.openProject(project);
    const sessionId = Object.values(opened.state.sessions)[0].id;
    return {
      runtime,
      async send(extra = {}) {
        const count = turns.length;
        await runtime.invoke("chat:send", [
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
        await waitUntil(() => turns.length === count + 1);
        await waitUntil(() => Object.keys(runtime.snapshot().runs.runs).length === 0);
        return turns.at(-1);
      },
    };
  }
  const first = await make();
  assert.deepEqual(await first.send(), { replies: "concise", tldrEnabled: true });
  assert.deepEqual(await first.send({ replies: "normal", tldrEnabled: false }), { replies: "normal", tldrEnabled: false });
  const beforePhone = created;
  assert.deepEqual(await first.send({ sentFrom: "phone" }), { replies: "normal", tldrEnabled: false });
  assert.equal(created, beforePhone, "switching to the phone keeps the provider session");
  await first.runtime.close();
  const restarted = await make();
  assert.deepEqual(await restarted.send({ sentFrom: "phone" }), { replies: "normal", tldrEnabled: false });
  assert.deepEqual(await restarted.send({ replies: "concise", tldrEnabled: true }), { replies: "concise", tldrEnabled: true });
  assert.deepEqual(await restarted.send({ sentFrom: "phone" }), { replies: "concise", tldrEnabled: true });
});
