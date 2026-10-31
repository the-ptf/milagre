const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-sent-from-")));
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
          options.emit({ type: "turn-started", turnId: `turn-${turns.length}` });
          options.emit({ type: "turn-completed" });
          return { turnId: `turn-${turns.length}` };
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
  const send = async (extra) => {
    const count = turns.length;
    await runtime.invoke("chat:send", [
      {
        projectPath: project,
        sessionId,
        body: "check the build",
        prompt: "check the build",
        images: [],
        files: [],
        provider: "codex",
        model: "test",
        permissionMode: "full",
        ...extra,
      },
    ]);
    await waitUntil(() => turns.length === count + 1);
    // What follows the typed message (a turn after the first may open with a handoff brief).
    const prompt = turns.at(-1).prompt;
    return prompt.slice(prompt.lastIndexOf("check the build"));
  };
  const messages = async () => (await runtime.invoke("project:snapshot", [project])).state.messages.filter((m) => m.role === "user");
  return { send, messages };
}

test("the agent hears where each message was typed, and when the user is back at this computer", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.send({}), "check the build");
  const phone = await f.send({ sentFrom: "phone" });
  assert.ok(phone.startsWith("check the build\n\n<milagre_note>The user sent this from their phone, not from this computer."));
  assert.match(phone, /don't ask them to/);
  assert.match(await f.send({ sentFrom: "tablet" }), /sent this from their iPad/);
  assert.match(await f.send({ sentFrom: "computer" }), /sent this from another computer, through Milagre/);
  assert.equal(await f.send({}), "check the build\n\n<milagre_note>The user is back at this computer.</milagre_note>");
  assert.equal(await f.send({}), "check the build");
  // The Chat shows what the user typed; only the agent gets the note.
  assert.ok((await f.messages()).every((message) => message.body === "check the build"));
});

test("an unknown device counts as this computer", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.send({ sentFrom: "watch" }), "check the build");
});
