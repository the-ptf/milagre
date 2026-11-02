const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createRuntime } = require("./runtime.cjs");
const { readProjectState } = require("./project-store.cjs");
const { savedRows } = require("./message-store.cjs");

// Lazy message memory (#321) through the whole runtime: a Chat that left memory takes turns, handoffs, subagent
// updates, archive and restarts as if it never had.

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-lazy-runtime-")));
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const dataDir = path.join(dir, "profile");
  const sessions = [];
  const runtimes = [];
  t.after(async () => {
    try {
      for (const runtime of runtimes) await runtime.close();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  const make = () => {
    const runtime = createRuntime({
      dataDir,
      chatsHome: path.join(dir, "chats"),
      cwd: project,
      version: "9.8.7",
      environmentReady: Promise.resolve(),
      titleModels: {},
      lazyMessages: { idleMs: 0, sweepMs: 0 },
      // No CLI runs: a handoff's brief fails, after its transcript is written.
      agentCli: async () => ({ command: "/milagre-test/missing-cli" }),
      createSession(provider, options) {
        let turn = 0;
        const session = {
          provider,
          options,
          turnActive: false,
          closed: false,
          requests: [],
          startTurn: async (request) => {
            session.requests.push(request);
            turn++;
            options.emit({ type: "turn-started", turnId: `t${turn}` });
            options.emit({ type: "session-started", nativeId: `${provider}-native` });
            options.emit({ type: "text-delta", messageId: `m${turn}`, text: `Reply ${turn} from ${provider}` });
            options.emit({ type: "turn-completed" });
            return { turnId: `t${turn}` };
          },
          interrupt: async () => {},
          close: async () => {},
        };
        sessions.push(session);
        return session;
      },
    });
    runtimes.push(runtime);
    return runtime;
  };
  return { project, dataDir, sessions, make };
}

const until = async (check) => {
  for (let i = 0; i < 300; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out");
};

async function openChat(t) {
  const context = await fixture(t);
  const runtime = context.make();
  const opened = await runtime.openProject(context.project);
  const chat = Object.values(opened.state.sessions)[0];
  const chatMessages = async () => (await runtime.invoke("chat:all-messages", [context.project])).filter((message) => message.session_id === chat.id);
  const send = async (body, provider = "claude") => {
    const before = (await chatMessages()).filter((message) => message.outcome).length;
    await runtime.invoke("chat:send", [{ projectPath: context.project, sessionId: chat.id, body, provider, model: `${provider}-model` }]);
    await until(async () => (await chatMessages()).filter((message) => message.outcome).length > before);
  };
  const inMemory = () => [...(savedRows(context.project)?.values() ?? [])].some((row) => row.chat === chat.id);
  const unload = async () => {
    await runtime.flush();
    await runtime.unloadIdle();
    assert.equal(inMemory(), false, "the Chat left memory");
  };
  return { ...context, runtime, chat, chatMessages, send, inMemory, unload };
}

const shape = (messages) => messages.map((message) => [message.role, message.body]);

test("deleting an unloaded Chat removes its saved conversation and survives restart while its files stay", async (t) => {
  const { project, chat, send, unload, runtime, make } = await openChat(t);
  await send("delete only this conversation");
  await runtime.invoke("chat:patch", [project, chat.id, { title: "Delete me" }]);
  const keptFile = path.join(project, "keep.txt");
  await fs.writeFile(keptFile, "keep my work");
  await unload();
  await runtime.invoke("chat:delete", [project, chat.id]);
  const saved = await readProjectState(project);
  assert.equal(saved.sessions[chat.id], undefined);
  assert.ok(!saved.messages.some((message) => message.session_id === chat.id));
  assert.equal(await fs.readFile(keptFile, "utf8"), "keep my work");
  assert.ok(Object.values(saved.worktrees).some((worktree) => worktree.path === project));
  await runtime.close();
  const restarted = make();
  const opened = await restarted.openProject(project);
  assert.equal(opened.state.sessions[chat.id], undefined);
  assert.ok(!(await restarted.invoke("chat:all-messages", [project])).some((message) => message.session_id === chat.id));
});

test("inbox outcome previews survive idle unloading without reloading transcripts", async (t) => {
  const { project, chat, send, unload, inMemory, runtime } = await openChat(t);
  await send("first");
  await runtime.invoke("chat:patch", [project, chat.id, { unread: true }]);
  const before = await runtime.invoke("chat:inbox", []);
  assert.equal(before.items[0].preview, "Reply 1 from claude");
  await unload();
  const after = await runtime.invoke("chat:inbox", []);
  assert.equal(after.items[0].preview, before.items[0].preview);
  assert.equal(inMemory(), false, "reading the inbox leaves the transcript unloaded");
  await send("second");
  await runtime.invoke("chat:patch", [project, chat.id, { unread: true }]);
  assert.equal((await runtime.invoke("chat:inbox", [])).items[0].preview, "Reply 2 from claude");
});

test("a turn in a Chat that left memory goes into the whole Chat, in order, and is saved whole", async (t) => {
  const { project, chat, chatMessages, send, unload, inMemory, runtime } = await openChat(t);
  await send("first");
  await unload();
  await send("second");
  assert.equal(inMemory(), true, "the send loaded it");
  const expected = [
    ["user", "first"],
    ["assistant", "Reply 1 from claude"],
    ["user", "second"],
    ["assistant", "Reply 2 from claude"],
  ];
  assert.deepEqual(shape(await chatMessages()), expected);
  const state = (await runtime.invoke("project:snapshot", [project])).state;
  assert.equal(state.sessions[chat.id].summary.count, 4);
  await runtime.flush();
  assert.deepEqual(shape((await readProjectState(project)).messages), expected);
});

test("a handoff in a Chat that left memory writes its transcript and brief from the whole Chat, then continues", async (t) => {
  const { chat, chatMessages, send, unload, runtime, project } = await openChat(t);
  await send("Earlier question");
  await unload();
  await runtime.invoke("chat:send", [{ projectPath: project, sessionId: chat.id, body: "switch", provider: "codex", model: "codex-model" }]);
  // No CLI writes a summary here, so the brief is the fallback one, made from the Chat's own messages.
  await until(async () => (await chatMessages()).some((message) => message.body === "Reply 1 from codex"));
  const messages = await chatMessages();
  const divider = messages.find((message) => message.context?.kind === "handoff");
  assert.equal(divider.context.status, "done");
  assert.match(divider.context.brief, /Last request:\nEarlier question/);
  const transcript = await fs.readFile(divider.context.transcriptPath, "utf8");
  assert.ok(transcript.includes("Earlier question") && transcript.includes("Reply 1 from claude"), "the transcript holds the turns from before");
  assert.deepEqual(shape(messages), [
    ["user", "Earlier question"],
    ["assistant", "Reply 1 from claude"],
    ["assistant", ""],
    ["user", "switch"],
    ["assistant", "Reply 1 from codex"],
  ]);
});

test("a subagent update for a Chat that left memory lands in it, and its messages stay", async (t) => {
  const { project, chat, chatMessages, send, unload, inMemory, sessions, runtime } = await openChat(t);
  await send("Start a helper");
  await unload();
  const agent = { id: "helper-1", title: "Helper", status: "running", startedAt: 1, updatedAt: 2, transcript: [{ id: "x", kind: "message", text: "Working" }] };
  sessions[0].options.emit({ type: "subagent-update", agent });
  const state = await until(async () => {
    const latest = (await runtime.invoke("project:snapshot", [project])).state;
    return latest.sessions[chat.id].subagents?.some((item) => item.id === "helper-1") && latest;
  });
  assert.equal(state.sessions[chat.id].summary.count, 2);
  assert.equal(inMemory(), true);
  assert.deepEqual(shape(await chatMessages()), [
    ["user", "Start a helper"],
    ["assistant", "Reply 1 from claude"],
  ]);
});

test("archiving and restoring a Chat that left memory keeps every message, and a restart reads them all", async (t) => {
  const { project, chat, chatMessages, send, unload, runtime, make } = await openChat(t);
  await send("Keep me");
  await unload();
  await runtime.invoke("chat:patch", [project, chat.id, { archived: true }]);
  await runtime.flush();
  assert.deepEqual(shape(await chatMessages()), [
    ["user", "Keep me"],
    ["assistant", "Reply 1 from claude"],
  ]);
  // Archived Chats are left out of a search, as before.
  assert.deepEqual(await runtime.invoke("chat:search", [project, "keep"]), []);
  await runtime.invoke("chat:patch", [project, chat.id, { archived: false }]);
  assert.equal((await runtime.invoke("chat:search", [project, "keep"]))[0].message.session_id, chat.id);
  const page = await runtime.invoke("chat:messages", [project, chat.id, { turns: 5 }]);
  assert.deepEqual(shape(page.messages), [
    ["user", "Keep me"],
    ["assistant", "Reply 1 from claude"],
  ]);
  await runtime.unloadIdle();
  await runtime.close();
  const again = make();
  const reopened = await again.openProject(project);
  assert.deepEqual(shape(reopened.state.messages.filter((message) => message.session_id === chat.id)), [
    ["user", "Keep me"],
    ["assistant", "Reply 1 from claude"],
  ]);
});

test("a reference resolves an unloaded Chat without loading its messages", async (t) => {
  const { runtime, project, chat, send, unload, inMemory, sessions } = await openChat(t);
  await send("The decision was to use SQLite.");
  await runtime.invoke("chat:patch", [project, chat.id, { title: "Storage decision" }]);
  await unload();
  const result = await runtime.invoke("chat:send", [
    { projectPath: project, worktreeId: chat.worktree_id, body: `Read @chat:${chat.id} and explain the decision`, provider: "claude", model: "claude-model" },
  ]);
  assert.notEqual(result.sessionId, chat.id);
  await until(() => sessions.some((s) => s.requests.some((r) => r.prompt.includes("<chat_mentions>"))));
  const request = sessions.flatMap((s) => s.requests).find((r) => r.prompt.includes("<chat_mentions>"));
  assert.ok(request.prompt.includes(`chatId: "${project}#${chat.id}"`));
  assert.ok(request.prompt.includes('"Storage decision"'));
  assert.equal(inMemory(), false, "resolving a reference reads only the unloaded Chat's summary");
});

test("a known Project's Chat reads from its chats.db before the Project opens, and the read doesn't open it", async (t) => {
  const { runtime, project, chat, send, make } = await openChat(t);
  await send("Read me early");
  await runtime.flush();
  await runtime.close();
  const again = make();
  const page = await again.invoke("chat:messages", [project, chat.id, { turns: 5 }]);
  assert.deepEqual(shape(page.messages), [
    ["user", "Read me early"],
    ["assistant", "Reply 1 from claude"],
  ]);
  await assert.rejects(again.invoke("project:snapshot", [project]), /Open the project before reading its snapshot/, "the Project stays closed");
  const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-unknown-")));
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }));
  await fs.mkdir(path.join(elsewhere, ".milagre"));
  await fs.copyFile(path.join(project, ".milagre", "chats.db"), path.join(elsewhere, ".milagre", "chats.db"));
  await assert.rejects(
    again.invoke("chat:messages", [elsewhere, chat.id, {}]),
    /Open the Project before reading its messages/,
    "an unknown folder is never read",
  );
});
