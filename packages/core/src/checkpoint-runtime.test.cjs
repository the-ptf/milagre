const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");
test("tasks capture once before execution; steering reuses the checkpoint; restore validates Chat and active Worktrees", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-runtime-")));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-q", project]);
  await fs.writeFile(path.join(project, "work.txt"), "manual");
  let emit;
  let session;
  let started = 0;
  const prompts = [];
  const runtime = createRuntime({
    dataDir: path.join(dir, "data"),
    chatsHome: path.join(dir, "chats"),
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    createSession(_provider, options) {
      emit = options.emit;
      session = {
        turnActive: false,
        async startTurn(request) {
          prompts.push(request.prompt);
          started++;
          session.turnActive = true;
          options.emit({ type: "turn-started", turnId: "turn" });
          return { turnId: "turn" };
        },
        async close() {},
        async interrupt() {},
      };
      return session;
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const opened = await runtime.openProject(project);
  const id = Object.values(opened.state.sessions)[0].id,
    chatId = `${project}#${id}`;
  const send = () =>
    runtime.invoke("chat:send", [{ projectPath: project, sessionId: id, body: "edit", provider: "codex", model: "test", permissionMode: "ask" }]);
  await send();
  await waitUntil(() => started === 1);
  let items = await runtime.invoke("checkpoint:list", [{ chatId }]);
  assert.equal(items.length, 1);
  await fs.writeFile(path.join(project, "work.txt"), "agent");
  await send();
  await waitUntil(() => started === 2);
  assert.equal((await runtime.invoke("checkpoint:list", [{ chatId }])).length, 1);
  await assert.rejects(runtime.invoke("checkpoint:preview", [{ chatId, id: items[0].id }]), /running|finish/i);
  session.turnActive = false;
  emit({ type: "turn-completed" });
  await waitUntil(async () => (await runtime.invoke("checkpoint:list", [{ chatId }]))[0].completedAt);
  const preview = await runtime.invoke("checkpoint:preview", [{ chatId, id: items[0].id }]);
  assert.equal(preview.files[0].path, "work.txt");
  await assert.rejects(runtime.invoke("checkpoint:preview", [{ chatId: `${project}#999`, id: items[0].id }]), /Chat/i);
  await assert.rejects(runtime.invoke("checkpoint:restore", [{ chatId, token: preview.token, decisions: { [preview.files[0].key]: "restore" } }]), /confirm/i);
  assert.equal(items[0].prompt, "edit");
  const messages = () => runtime.snapshot().projects.find((entry) => entry.path === project).state.messages;
  assert.equal(items[0].messageId, messages().find((message) => message.role === "user" && message.body === "edit").id);
  const restored = await runtime.invoke("checkpoint:restore", [
    { chatId, token: preview.token, decisions: { [preview.files[0].key]: "restore" }, approved: true },
  ]);
  assert.equal(restored.restored, 1);
  assert.equal(await fs.readFile(path.join(project, "work.txt"), "utf8"), "manual");
  // The Chat records the undo, with the recovery checkpoint its Redo previews.
  await waitUntil(() => messages().some((message) => message.context?.kind === "checkpoint-restore"));
  const note = messages().find((message) => message.context?.kind === "checkpoint-restore");
  assert.equal(note.body, "Undid 1 file");
  assert.deepEqual(note.context, { kind: "checkpoint-restore", checkpointId: items[0].id, recoveryId: restored.recoveryId, restored: 1, kept: 0, redo: false });

  // The line is for the user; the agent hears about the undo with its next turn, once, and the user's bubble stays as typed.
  assert.deepEqual(prompts, ["edit", "edit"]);
  await runtime.invoke("chat:send", [{ projectPath: project, sessionId: id, body: "carry on", provider: "codex", model: "test", permissionMode: "ask" }]);
  await waitUntil(() => started === 3);
  // (The fixture's Chat hands off between providers here, so a brief may lead the prompt.)
  assert.ok(
    prompts[2].endsWith(
      "carry on\n\n<milagre_note>The user undid this Chat's changes to 1 file with Undo changes. Re-read files before editing.</milagre_note>",
    ),
    prompts[2],
  );
  assert.ok(
    messages().some((message) => message.role === "user" && message.body === "carry on"),
    "the bubble shows only what the user typed",
  );
  session.turnActive = false;
  emit({ type: "turn-completed" });
  await waitUntil(() => !runtime.snapshot().projects.find((entry) => entry.path === project).state.sessions[id].running);
  await runtime.invoke("chat:send", [{ projectPath: project, sessionId: id, body: "and then", provider: "codex", model: "test", permissionMode: "ask" }]);
  await waitUntil(() => started === 4);
  assert.ok(prompts[3].endsWith("and then"), prompts[3]);
  assert.doesNotMatch(prompts[3], /milagre_note/, "each undo is told once");
});

test("a checkpoint that can't be captured never blocks the message: the task runs without one", async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-runtime-")));
  const project = path.join(dir, "project");
  await fs.mkdir(path.join(project, ".milagre", "checkpoint-ignore"), { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  const prompts = [];
  const runtime = createRuntime({
    dataDir: path.join(dir, "data"),
    chatsHome: path.join(dir, "chats"),
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    createSession: (_provider, options) => ({
      turnActive: false,
      async startTurn(request) {
        prompts.push(request.prompt);
        options.emit({ type: "turn-started", turnId: "turn" });
        return { turnId: "turn" };
      },
      async close() {},
      async interrupt() {},
    }),
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const warn = t.mock.method(console, "warn", () => {});
  const opened = await runtime.openProject(project);
  const id = Object.values(opened.state.sessions)[0].id;
  // A directory where the ignore file belongs fails the capture.
  await runtime.invoke("chat:send", [{ projectPath: project, sessionId: id, body: "edit", provider: "codex", model: "test", permissionMode: "ask" }]);
  await waitUntil(() => prompts.length === 1);
  assert.deepEqual(await runtime.invoke("checkpoint:list", [{ chatId: `${project}#${id}` }]), []);
  assert.ok(warn.mock.calls.some((call) => /Checkpoint ignore file must be a regular file/.test(call.arguments.join(" "))));
});

test("the agent's note names the files undone, and says so for a Redo", () => {
  const { agentRestoreNote } = require("./checkpoint-runtime.cjs");
  assert.equal(
    agentRestoreNote({ restored: 3, redo: false }),
    "<milagre_note>The user undid this Chat's changes to 3 files with Undo changes. Re-read files before editing.</milagre_note>",
  );
  assert.match(agentRestoreNote({ restored: 1, redo: true }), /redid this Chat's changes to 1 file with Redo/);
});
