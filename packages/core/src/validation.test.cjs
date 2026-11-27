const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { createGit } = require("./git/client.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");
const { changedFiles, codeState } = require("./validation-state.cjs");
const { createValidations } = require("./validation.cjs");

async function repository(prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-q", project]);
  await fs.writeFile(path.join(project, "work.txt"), "start");
  execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", "add", "."]);
  execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "start"]);
  return { dir, project };
}

test("the code state follows every file Git doesn't ignore and names what changed, leaving out .milagre", async (t) => {
  const { dir, project } = await repository("validation-state-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = createGit().read;
  const clean = await codeState(git, project);
  await fs.mkdir(path.join(project, ".milagre"));
  await fs.writeFile(path.join(project, ".milagre", "chats.db"), "rows");
  assert.equal((await codeState(git, project)).digest, clean.digest, "Milagre's own files never make a result out of date");
  await fs.writeFile(path.join(project, "work.txt"), "edited");
  await fs.writeFile(path.join(project, "new.txt"), "new");
  const edited = await codeState(git, project);
  assert.notEqual(edited.digest, clean.digest);
  assert.deepEqual(await changedFiles(git, project, clean, edited), ["new.txt", "work.txt"]);
  await fs.writeFile(path.join(project, "new.txt"), "newer");
  assert.deepEqual(await changedFiles(git, project, edited, await codeState(git, project)), ["new.txt"]);
});

function fakeChats() {
  const notes = [];
  return {
    notes,
    chats: {
      notes: new Map(),
      async addNote(chatId, note) {
        notes.push({ chatId, ...note });
      },
    },
    update: (chatId, match, change) => {
      const note = notes.findLast((item) => item.chatId === chatId && match(item));
      if (!note) return false;
      Object.assign(note, change(note));
      return true;
    },
  };
}

test("Stop interrupts the running command and leaves the rest not run; a host that stopped mid-run records it interrupted", async (t) => {
  const { dir, project } = await repository("validation-stop-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const chatId = `${project}#1`;
  const { notes, chats, update } = fakeChats();
  chats.states = {
    async update(_scope, change) {
      const state = { messages: notes.map((note, index) => ({ ...note, id: index, session_id: 1 })) };
      const next = change(state);
      if (next === state) return { state, changed: false };
      const changed = next.messages.find((message, index) => message !== state.messages[index]);
      update(
        chatId,
        (item) => item.context.runId === changed.context.runId,
        () => ({ body: changed.body, context: changed.context }),
      );
      return { state: next, changed: true };
    },
  };
  chats.broadcast = () => {};
  const settings = {
    getValidation: async () => ({
      afterTask: true,
      commands: [
        { name: "Slow", command: "sleep 30", cwd: "" },
        { name: "Never", command: "true", cwd: "" },
      ],
    }),
  };
  const states = { executionContext: async () => ({ cwd: project }), chatMessages: async () => notes };
  const told = [];
  const validations = createValidations({
    directory: path.join(dir, "data"),
    settings: () => settings,
    states,
    chats,
    git: createGit().read,
    tell: (id, text) => told.push(text),
  });
  const { runId, done } = await validations.start(chatId, { trigger: "user" });
  await waitUntil(() => notes[0]?.context.results[0]?.status === "running");
  assert.equal(await validations.stop(chatId, runId), true);
  const final = await done;
  assert.equal(final.status, "interrupted");
  assert.deepEqual(
    final.results.map((result) => [result.name, result.status, result.reason]),
    [
      ["Slow", "interrupted", "stopped"],
      ["Never", "not-run", undefined],
    ],
  );
  assert.equal(notes.length, 1, "one note follows the whole run");
  assert.equal(notes[0].body, "Validation interrupted: Stopped · run by you · " + notes[0].body.split(" · ").at(-1));
  assert.match(told[0], /<milagre_note>Milagre ran the Project's validation commands \(run by you\): Validation interrupted/);

  // A run a stopped host left running is settled at the next start, never left looking like it could still pass.
  notes.push({
    chatId,
    body: "Running validation",
    context: {
      kind: "validation",
      runId: "00000000-0000-4000-8000-000000000000",
      status: "running",
      results: [
        { name: "A", status: "running" },
        { name: "B", status: "queued" },
      ],
    },
  });
  await fs.mkdir(path.join(dir, "data", "runs", "00000000-0000-4000-8000-000000000000"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "data", "runs", "00000000-0000-4000-8000-000000000000", "run.json"),
    JSON.stringify({ chatId, status: "running", startedAt: 1 }),
  );
  await validations.recover();
  assert.equal(notes[1].context.status, "interrupted");
  assert.deepEqual(
    notes[1].context.results.map((result) => result.status),
    ["interrupted", "not-run"],
  );
});

function runtimeFor(t, dir) {
  const state = { emit: null, session: null, started: 0, prompts: [] };
  const runtime = createRuntime({
    dataDir: path.join(dir, "data"),
    chatsHome: path.join(dir, "chats"),
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    createSession(_provider, options) {
      state.emit = options.emit;
      state.session = {
        turnActive: false,
        async startTurn(request) {
          state.prompts.push(request.prompt);
          state.started++;
          state.session.turnActive = true;
          options.emit({ type: "turn-started", turnId: "turn" });
          return { turnId: "turn" };
        },
        async close() {},
        async interrupt() {},
      };
      return state.session;
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { runtime, state };
}

test("a finished task that changed files is validated in its Worktree, by exit codes alone, and goes out of date when files change", async (t) => {
  const { dir, project } = await repository("validation-runtime-");
  const { runtime, state } = runtimeFor(t, dir);
  const opened = await runtime.openProject(project);
  const id = Object.values(opened.state.sessions)[0].id;
  const chatId = `${project}#${id}`;
  const saved = await runtime.invoke("project-validation:save", [
    project,
    {
      afterTask: true,
      commands: [
        { name: "Check", command: 'test "$(cat work.txt)" = agent' },
        { name: "Fail", command: "echo broken >&2; exit 3" },
      ],
    },
  ]);
  assert.deepEqual(saved.commands[0], { name: "Check", command: 'test "$(cat work.txt)" = agent', cwd: "" });
  const messages = () => runtime.snapshot().projects.find((entry) => entry.path === project).state.messages;
  const validation = () => messages().findLast((message) => message.context?.kind === "validation")?.context;
  const turn = async (body, mode, work) => {
    const before = state.started;
    await runtime.invoke("chat:send", [{ projectPath: project, sessionId: id, body, provider: "codex", model: "test", permissionMode: mode }]);
    await waitUntil(() => state.started === before + 1);
    await work?.();
    state.session.turnActive = false;
    state.emit({ type: "turn-completed" });
  };

  // The agent says everything passes; Milagre records what the commands returned.
  await turn("make it pass", "full", () => fs.writeFile(path.join(project, "work.txt"), "agent"));
  await waitUntil(() => ["passed", "failed"].includes(validation()?.status), { timeoutMs: 20000 });
  const run = validation();
  assert.equal(run.trigger, "task");
  assert.equal(run.status, "failed");
  assert.equal(run.worktreePath, project);
  assert.equal(run.code.dirty, 1);
  assert.deepEqual(
    run.results.map((result) => [result.name, result.status, result.exitCode]),
    [
      ["Check", "passed", 0],
      ["Fail", "failed", 3],
    ],
  );
  assert.equal(run.results[1].tail, "broken");
  assert.equal((await runtime.invoke("validation:log", [{ chatId, runId: run.runId, index: 1 }])).text, "broken\n");
  await assert.rejects(runtime.invoke("validation:log", [{ chatId: `${project}#999`, runId: run.runId, index: 1 }]), /gone/);

  // The next turn changes a file: the result goes out of date, and the agent hears the real result once.
  await turn("tweak", "full", () => fs.writeFile(path.join(project, "other.txt"), "x"));
  await waitUntil(() => messages().find((message) => message.context?.runId === run.runId)?.context.stale);
  assert.deepEqual(messages().find((message) => message.context?.runId === run.runId).context.stale.files, ["other.txt"]);
  assert.match(state.prompts[1], /<milagre_note>Milagre ran the Project's validation commands \(after this task\): Validation failed: 1 of 2 failed/);
  assert.match(state.prompts[1], /Last output of Fail:\nbroken/);

  // In Ask mode a finished task records the run as not run, waiting for the user's Run.
  await waitUntil(() => validation()?.runId !== run.runId && validation()?.status !== "running", { timeoutMs: 20000 });
  await turn("again", "ask", () => fs.writeFile(path.join(project, "other.txt"), "y"));
  await waitUntil(() => validation()?.status === "not-run");
  assert.equal(validation().reason, "Ask mode: runs only when you press Run");
  const { runId } = await runtime.invoke("validation:run", [{ chatId }]);
  await waitUntil(() => messages().find((message) => message.context?.runId === runId)?.context.status === "failed", { timeoutMs: 20000 });
  assert.equal(messages().find((message) => message.context?.runId === runId).context.trigger, "user");
});
