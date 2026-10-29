const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AcpRpc } = require("./acp-rpc.cjs");
const { AcpSession, pickOption } = require("./acp-session.cjs");
const { acpDiff, acpStepResult } = require("./acp-events.cjs");
const { ANTIGRAVITY_MODES, antigravityAcp, antigravityEnv, crashDetail } = require("./antigravity-acp.cjs");
const { MILAGRE_INSTRUCTIONS, RESUME_FAILED_MESSAGE, crashMessage, failedWith, isTerminal, loginMessage, missingCliMessage } = require("./events.cjs");
const { waitUntil } = require("./test-helpers.cjs");

const FAKE = path.join(__dirname, "fixtures", "fake-acp-agent.cjs");
const AGENT = "/opt/antigravity/agy_acp_server.par";
const TURN = { prompt: "Hi", images: [], model: "gemini-3.8-flash-high", permissionMode: "ask" };

function antigravity(t, { scenario = "reply", resumeId, linked, mcpExtras, command = AGENT, interruptGraceMs, workspaceRoots, env, permissionPolicy } = {}) {
  const events = [];
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-acp-test-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-acp-cwd-"));
  const spawned = [];
  const session = new AcpSession({
    cwd,
    resumeId,
    linked,
    mcpExtras,
    command,
    env,
    workspaceRoots,
    clientVersion: "test",
    interruptGraceMs,
    permissionPolicy,
    config: { ...antigravityAcp, tempRoot },
    emit: (event) => events.push(event),
    createRpc: (options) => {
      spawned.push(options);
      return new AcpRpc({ ...options, command: process.execPath, args: [FAKE], env: { ...options.env, FAKE_SCENARIO: scenario } });
    },
  });
  t.after(async () => {
    await session.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { session, events, spawned, tempRoot, cwd };
}
const ended = (events, count = 1) => waitUntil(() => events.filter(isTerminal).length >= count);

test("a continuation cancelled during ACP initialization submits no prompt", async (t) => {
  const { session, events } = antigravity(t);
  let allowed = true;
  const turn = session.startTurn({ ...TURN, canStart: () => allowed });
  allowed = false;
  assert.equal((await turn).cancelled, true);
  assert.equal(
    events.some((event) => event.type === "turn-cancelled"),
    false,
  );
  assert.equal((await sent(session, "session/prompt")).length, 0);
});
const fake = (session) => session.rpc.request("fake/received");
const sent = async (session, method) => (await fake(session)).received.filter((message) => message.method === method).map((message) => message.params);
const of = (events, type) => events.filter((event) => event.type === type);
const replyText = (events) =>
  of(events, "text-delta")
    .map((event) => event.text)
    .join("");

test("starts a session, streams the reply and keeps the session across turns", async (t) => {
  const { session, events } = antigravity(t);
  const { turnId } = await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(events, [
    { type: "session-started", nativeId: "sess-1" },
    { type: "turn-started", turnId },
    { type: "text-delta", messageId: turnId, text: "Hel" },
    { type: "text-delta", messageId: turnId, text: "lo" },
    { type: "turn-completed" },
  ]);
  await session.startTurn(TURN);
  await ended(events, 2);
  assert.equal((await fake(session)).sessions, 1);
  assert.equal(session.nativeId, "sess-1");
  assert.deepEqual(
    session.models.map((model) => model.value),
    ["gemini-3.8-flash-high", "flash-lite-agent", "gemini-pro-agent"],
  );
});

test("introduces Milagre and its instructions on the first prompt of each process only", async (t) => {
  const { session, events, cwd } = antigravity(t);
  await session.startTurn(TURN);
  await ended(events);
  await session.startTurn({ ...TURN, prompt: "Again" });
  await ended(events, 2);
  const init = (await sent(session, "initialize"))[0];
  assert.deepEqual(init.clientInfo, { name: "milagre", title: "Milagre", version: "test" });
  assert.deepEqual(init.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  const prompts = await sent(session, "session/prompt");
  assert.deepEqual(prompts[0].prompt, [
    {
      type: "text",
      text: `<milagre_instructions>\n${MILAGRE_INSTRUCTIONS}\n\nYour working directory is ${cwd}. Run commands there unless the user names another folder.\n</milagre_instructions>`,
    },
    { type: "text", text: "Hi" },
  ]);
  assert.deepEqual(prompts[1].prompt, [{ type: "text", text: "Again" }]);
});

test("sends images as image blocks and interleaves [Image #N] tokens in reading order", async (t) => {
  const { session, events } = antigravity(t);
  await session.startTurn({
    ...TURN,
    prompt: "First [Image #2] then [Image #1]",
    images: [
      { mime: "image/png", bytes: Buffer.from("one"), base64: Buffer.from("one").toString("base64") },
      { mime: "image/jpeg", bytes: Buffer.from("two"), base64: Buffer.from("two").toString("base64") },
    ],
  });
  await ended(events);
  const [prompt] = await sent(session, "session/prompt");
  assert.deepEqual(prompt.prompt.slice(-4), [
    { type: "text", text: "First " },
    { type: "image", mimeType: "image/jpeg", data: Buffer.from("two").toString("base64") },
    { type: "text", text: " then " },
    { type: "image", mimeType: "image/png", data: Buffer.from("one").toString("base64") },
  ]);
});

test("runs the agent with its profile, a private temporary directory and no ambient Google credentials", async (t) => {
  const env = { PATH: process.env.PATH, HOME: os.homedir(), GEMINI_HOME: "/profiles/work", GEMINI_API_KEY: "k", GOOGLE_CLOUD_PROJECT: "p", BROWSER: "x" };
  const { session, events, spawned, tempRoot } = antigravity(t, { env });
  await session.startTurn(TURN);
  await ended(events);
  const childEnv = spawned[0].env;
  assert.equal(childEnv.GEMINI_HOME, "/profiles/work");
  assert.equal(childEnv.AGY_ACP_FORCE_FILE_STORAGE, "1");
  assert.equal(childEnv.PYTHONUNBUFFERED, "1");
  assert.equal(childEnv.ANTIGRAVITY_HARNESS_PATH, "/opt/antigravity/localharness_external");
  for (const name of ["GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT", "BROWSER"]) assert.equal(childEnv[name], undefined);
  assert.equal(path.dirname(childEnv.TMPDIR), tempRoot);
  assert.equal(fs.existsSync(childEnv.TMPDIR), true);
  await session.close();
  assert.equal(fs.existsSync(childEnv.TMPDIR), false);
});

test("antigravityEnv leaves GEMINI_HOME unset when the account has none", () => {
  const env = antigravityEnv({ env: { GEMINI_API_KEY: "k", PATH: "/bin" }, command: "/a/agy", tmpdir: "/t" });
  assert.deepEqual(env, {
    PATH: "/bin",
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    PYTHONUNBUFFERED: "1",
    TMPDIR: "/t",
    ANTIGRAVITY_HARNESS_PATH: "/a/localharness_external",
  });
});

test("resumes a saved session without announcing it again", async (t) => {
  const { session, events } = antigravity(t, { resumeId: "sess-9" });
  await session.startTurn(TURN);
  await ended(events);
  const [resume] = await sent(session, "session/resume");
  assert.equal(resume.sessionId, "sess-9");
  assert.equal(of(events, "session-started").length, 0);
  assert.equal(session.nativeId, "sess-9");
  assert.equal(replyText(events), "Hello");
  // Resumed in a new process: the instructions go with its first prompt.
  assert.match((await sent(session, "session/prompt"))[0].prompt[0].text, /^<milagre_instructions>/);
});

test("loads a session without replaying its history when the agent can't resume", async (t) => {
  const { session, events } = antigravity(t, { scenario: "no-resume", resumeId: "sess-9" });
  await session.startTurn(TURN);
  await ended(events);
  assert.equal((await sent(session, "session/load")).length, 1);
  assert.equal(replyText(events), "Hello");
});

test("forgets a session that can't be resumed", async (t) => {
  const { session, events } = antigravity(t, { resumeId: "missing" });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(events, [{ type: "session-reset" }, failedWith(RESUME_FAILED_MESSAGE)]);
  assert.equal(session.closed, true);
});

test("shows a command as a step with its output and exit code", async (t) => {
  const { session, events } = antigravity(t, { scenario: "command" });
  await session.startTurn(TURN);
  await ended(events);
  const steps = events.filter((event) => event.type.startsWith("step-") || event.type === "context-usage");
  assert.deepEqual(steps, [
    { type: "step-started", step: { id: "cmd-1", kind: "shell", title: "Ran `ls`", detail: "$ ls\n" } },
    { type: "context-usage", used: 1200, size: 1048576 },
    { type: "step-completed", id: "cmd-1", status: "done", detail: "$ ls\na.txt\nb.txt\n" },
  ]);
  assert.equal(replyText(events), "Two files.");
});

test("a command that exits non-zero is a failed step", async (t) => {
  const { session, events } = antigravity(t, { scenario: "failing-command" });
  await session.startTurn(TURN);
  await ended(events);
  assert.equal(of(events, "step-completed")[0].status, "failed");
});

test("in bot mode the policy answers a permission request without a card", async (t) => {
  const { session, events } = antigravity(t, {
    scenario: "permission",
    permissionPolicy: (request) => (request.command === "rm -rf build" ? "deny" : "allow"),
  });
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await ended(events);
  assert.equal(replyText(events), "picked:deny");
  assert.equal(of(events, "permission-request").length, 0);
});

test("asks before a command and answers with the option picked", async (t) => {
  for (const [decision, option] of [
    ["allow", "allow"],
    ["allow-for-chat", "allow_always"],
    ["deny", "deny"],
  ]) {
    const { session, events } = antigravity(t, { scenario: "permission" });
    await session.startTurn(TURN);
    await waitUntil(() => of(events, "permission-request").length === 1);
    const [request] = of(events, "permission-request");
    assert.deepEqual(request, {
      type: "permission-request",
      requestId: request.requestId,
      kind: "command",
      tool: "Shell",
      title: "Run this command?",
      command: "rm -rf build",
      cwd: "/w",
      allowForChat: true,
      stepId: "cmd-1",
    });
    assert.equal(session.respondToPermission(request.requestId, decision), true);
    await ended(events);
    assert.equal(replyText(events), `picked:${option}`);
    assert.deepEqual(of(events, "permission-resolved"), [{ type: "permission-resolved", requestId: request.requestId, decision }]);
  }
});

test("Milagre's plan tools are allowed once without a card in every mode", async (t) => {
  for (const permissionMode of ["ask", "auto"]) {
    const { session, events } = antigravity(t, { scenario: "mcp-plan-tool" });
    await session.startTurn({ ...TURN, permissionMode });
    await ended(events);
    assert.equal(of(events, "permission-request").length, 0);
    assert.equal(replyText(events), "picked:allow");
  }
});

test("Milagre's other tools still ask", async (t) => {
  const { session, events } = antigravity(t, { scenario: "mcp-design-tool" });
  await session.startTurn({ ...TURN, permissionMode: "auto" });
  await waitUntil(() => of(events, "permission-request").length === 1);
  const [request] = of(events, "permission-request");
  assert.equal(request.tool, "milagre_design_delete");
  session.respondToPermission(request.requestId, "deny");
  await ended(events);
  assert.equal(replyText(events), "picked:deny");
});

test("Full answers permission requests without a card", async (t) => {
  const { session, events } = antigravity(t, { scenario: "permission" });
  await session.startTurn({ ...TURN, permissionMode: "full" });
  await ended(events);
  assert.equal(of(events, "permission-request").length, 0);
  assert.equal(replyText(events), "picked:allow");
});

test("guarded turn denies push", async (t) => {
  const reason = "Babysit level Fix, don't push doesn't allow pushing to GitHub. Change it in Settings › Experimental › Babysit PRs.";
  // In Ask the rest still waits for the user.
  const ask = antigravity(t, { scenario: "guarded" });
  await ask.session.startTurn({ ...TURN, permissionMode: "ask", guard: { level: 2, resolveThreads: false } });
  await waitUntil(() => of(ask.events, "permission-request").length === 1);
  const [request] = of(ask.events, "permission-request");
  assert.equal(request.command, "ls build");
  ask.session.respondToPermission(request.requestId, "allow");
  await ended(ask.events);
  assert.equal(replyText(ask.events), "picked:deny picked:allow");
  // The step says why.
  const step = of(ask.events, "step-completed").find((event) => event.id === "cmd-1");
  assert.equal(step.detail, `$ git push origin HEAD\n${reason}`);

  // Full runs the guarded turn in Auto's mode, so commands still ask, and Milagre allows the rest itself.
  const full = antigravity(t, { scenario: "guarded" });
  await full.session.startTurn({ ...TURN, permissionMode: "full", guard: { level: 2, resolveThreads: false } });
  await ended(full.events);
  assert.equal(replyText(full.events), "picked:deny picked:allow");
  assert.equal(of(full.events, "permission-request").length, 0);
  // The Chat's next turn is the user's own: Full's own mode again.
  await full.session.startTurn({ ...TURN, permissionMode: "full" });
  await ended(full.events, 2);
  const modes = (await sent(full.session, "session/set_config_option")).filter((params) => params.configId === "mode").map((params) => params.value);
  assert.deepEqual(modes, ["auto_edit", "yolo"]);
});

test("a command that writes to GitHub is allowed once, never always", async (t) => {
  const { session, events } = antigravity(t, { scenario: "guarded" });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await waitUntil(() => of(events, "permission-request").length === 1);
  const [push] = of(events, "permission-request");
  assert.equal(push.command, "git push origin HEAD");
  assert.equal(push.allowForChat, false);
  session.respondToPermission(push.requestId, "allow-for-chat");
  await waitUntil(() => of(events, "permission-request").length === 2);
  const list = of(events, "permission-request")[1];
  assert.equal(list.allowForChat, true);
  session.respondToPermission(list.requestId, "allow-for-chat");
  await ended(events);
  assert.equal(replyText(events), "picked:allow picked:allow_always");
  // An agent that offers no one-time allow gets no "always" for it either.
  const always = [{ optionId: "allow_always", kind: "allow_always" }];
  assert.equal(pickOption(always, "allow", { once: true }), null);
  assert.equal(pickOption(always, "allow").optionId, "allow_always");
});

test("an edit shows its diff on the card and on the step that ran it", async (t) => {
  const { session, events, cwd } = antigravity(t, { scenario: "edit" });
  await session.startTurn(TURN);
  await waitUntil(() => of(events, "permission-request").length === 1);
  const [request] = of(events, "permission-request");
  const file = path.join(fs.realpathSync(cwd), "notes.txt");
  const diff = `--- ${file}\n+++ ${file}\n@@ -2,1 +2,1 @@\n-b\n+c`;
  assert.equal(request.kind, "edit");
  assert.equal(request.title, "Edit notes.txt?");
  assert.deepEqual(request.files, [file]);
  assert.equal(request.diff, diff);
  session.respondToPermission(request.requestId, "allow");
  await ended(events);
  const steps = events.filter((event) => event.type.startsWith("step-"));
  // The asking call never ran, so it is no step; the call that ran carries the diff.
  assert.deepEqual(steps, [
    { type: "step-started", step: { id: "run-1", kind: "edit", title: "Edited `notes.txt`", file } },
    { type: "step-completed", id: "run-1", status: "done", title: "Edited `notes.txt`", detail: diff },
  ]);
});

test("Auto answers a waiting edit inside the workspace when the mode switches", async (t) => {
  const { session, events } = antigravity(t, { scenario: "edit" });
  await session.startTurn(TURN);
  await waitUntil(() => of(events, "permission-request").length === 1);
  await session.setPermissionMode("auto");
  await ended(events);
  assert.equal(replyText(events), "picked:allow");
  const modes = (await sent(session, "session/set_config_option")).filter((params) => params.configId === "mode").map((params) => params.value);
  assert.deepEqual(modes, ["auto_edit"]);
});

test("bot mode maps to Antigravity's default mode", () => {
  assert.equal(ANTIGRAVITY_MODES.bot, "default");
});

test("acpDiff marks a new file as added lines", () => {
  assert.equal(acpDiff({ path: "/a.txt", newText: "hi\n" }), "--- /a.txt\n+++ /a.txt\n@@ -0,0 +1,1 @@\n+hi");
});

test("an interaction_ request is a single-choice question", async (t) => {
  const { session, events } = antigravity(t, { scenario: "question" });
  await session.startTurn(TURN);
  await waitUntil(() => of(events, "question-request").length === 1);
  const [question] = of(events, "question-request");
  assert.deepEqual(question.questions, [
    { id: "0", header: "", question: "Which color?", options: [{ label: "Red" }, { label: "Green" }], multiSelect: false, allowOther: false, secret: false },
  ]);
  assert.equal(of(events, "permission-request").length, 0);
  assert.equal(session.answerQuestion(question.requestId, { 0: ["Green"] }), true);
  await ended(events);
  assert.equal(replyText(events), "picked:green");
});

test("a dismissed question is answered as cancelled", async (t) => {
  const { session, events } = antigravity(t, { scenario: "question" });
  await session.startTurn(TURN);
  await waitUntil(() => of(events, "question-request").length === 1);
  session.answerQuestion(of(events, "question-request")[0].requestId, null);
  await ended(events);
  assert.equal(replyText(events), "picked:cancelled");
});

test("a plan becomes the task list", async (t) => {
  const { session, events } = antigravity(t, { scenario: "plan" });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(of(events, "tasks-updated"), [
    {
      type: "tasks-updated",
      tasks: [
        { id: "0", content: "Read", status: "completed" },
        { id: "1", content: "Write", status: "in_progress" },
        { id: "2", content: "Test", status: "pending" },
      ],
    },
  ]);
});

test("thought chunks stream into a thinking step that ends when the reply starts", async (t) => {
  const { session, events } = antigravity(t, { scenario: "thinking" });
  await session.startTurn(TURN);
  await ended(events);
  const types = events.map((event) => event.type);
  assert.deepEqual(types.slice(2), ["step-started", "step-output", "step-output", "step-completed", "text-delta", "turn-completed"]);
  const done = of(events, "step-completed")[0];
  assert.equal(done.id, "thinking-1");
  assert.equal(done.detail, "Pondering more");
  assert.match(done.title, /^Thought for/);
});

test("switches the model and the mode only when they change", async (t) => {
  const { session, events } = antigravity(t);
  await session.startTurn({ ...TURN, model: "gemini-pro-agent", permissionMode: "full" });
  await ended(events);
  await session.startTurn({ ...TURN, model: "gemini-pro-agent", permissionMode: "full" });
  await ended(events, 2);
  await session.startTurn({ ...TURN, model: "gemini-3.8-flash-high", permissionMode: "ask" });
  await ended(events, 3);
  const changes = (await sent(session, "session/set_config_option")).map((params) => [params.configId, params.value]);
  assert.deepEqual(changes, [
    ["model", "gemini-pro-agent"],
    ["mode", "yolo"],
    ["model", "gemini-3.8-flash-high"],
    ["mode", "default"],
  ]);
});

test("a family and effort resolve to the agent's id from the session's own options; a raw agent id is used as it is", async (t) => {
  const { session, events } = antigravity(t);
  await session.startTurn({ ...TURN, model: "gemini-3.8-flash", effort: "low" });
  await ended(events);
  await session.startTurn({ ...TURN, model: "gemini-3.1-pro", effort: "high" });
  await ended(events, 2);
  // This session offers no Flash at Medium, so Flash's default effort (High) is used.
  await session.startTurn({ ...TURN, model: "gemini-3.8-flash", effort: "medium" });
  await ended(events, 3);
  // A chat saved with an agent id from before families keeps it.
  await session.startTurn({ ...TURN, model: "flash-lite-agent" });
  await ended(events, 4);
  const models = (await sent(session, "session/set_config_option")).filter((params) => params.configId === "model").map((params) => params.value);
  assert.deepEqual(models, ["flash-lite-agent", "gemini-pro-agent", "gemini-3.8-flash-high", "flash-lite-agent"]);
});

test("a family the session doesn't offer resolves through the catalog", () => {
  assert.equal(antigravityAcp.resolveModel({ model: "gemini-4-argon", effort: "low", offered: null }), "gemini-4-argon-low");
  assert.equal(
    antigravityAcp.resolveModel({ model: "gemini-4-argon", effort: "medium", offered: [{ value: "x", name: "Other (High)" }] }),
    "gemini-4-argon-medium",
  );
  assert.equal(antigravityAcp.resolveModel({ model: "nope", effort: "high", offered: null }), "nope");
});

test("a model the agent refuses fails the turn", async (t) => {
  const { session, events } = antigravity(t);
  await session.startTurn({ ...TURN, model: "nope" });
  await ended(events);
  assert.match(events.at(-1).message, /Antigravity couldn't switch to nope: Unknown model/);
});

test("Stop cancels the prompt and keeps the process when the agent honours it", async (t) => {
  const { session, events } = antigravity(t, { scenario: "slow" });
  await session.startTurn(TURN);
  await waitUntil(() => replyText(events) === "Working");
  await session.interrupt();
  await ended(events);
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
  assert.equal(session.closed, false);
  assert.equal((await sent(session, "session/cancel")).length, 1);
});

test("Stop kills an agent that doesn't honour the cancel", async (t) => {
  const { session, events } = antigravity(t, { scenario: "stubborn", interruptGraceMs: 100 });
  await session.startTurn(TURN);
  await waitUntil(() => replyText(events) === "Working");
  await session.interrupt();
  await ended(events);
  assert.deepEqual(events.filter(isTerminal), [{ type: "turn-cancelled" }]);
  assert.equal(session.closed, true);
  await assert.rejects(session.startTurn(TURN), (error) => error.sessionClosed === true);
});

test("Stop that has to kill the agent also stops the commands it started in groups of their own", { skip: process.platform === "win32" }, async (t) => {
  const { session, events } = antigravity(t, { scenario: "stubborn-command", interruptGraceMs: 100 });
  await session.startTurn(TURN);
  await waitUntil(() => replyText(events) === "Working");
  const { commandPid } = await fake(session);
  const alive = () => {
    try {
      process.kill(commandPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  t.after(() => alive() && process.kill(commandPid, "SIGKILL"));
  assert.ok(alive());
  await session.interrupt();
  await ended(events);
  await waitUntil(() => !alive());
});

test("a message sent while a turn runs starts the next turn", async (t) => {
  const { session, events } = antigravity(t, { scenario: "slow" });
  await session.startTurn(TURN);
  await waitUntil(() => replyText(events) === "Working");
  const queued = session.startTurn({ ...TURN, prompt: "Next" });
  await session.rpc.request("fake/finish");
  const result = await queued;
  assert.equal(result.steered, false);
  await waitUntil(() => of(events, "turn-started").length === 2);
  const prompts = await sent(session, "session/prompt");
  assert.deepEqual(prompts.at(-1).prompt, [{ type: "text", text: "Next" }]);
});

test("Stop drops a message that was waiting for the turn, and a message sent after Stop starts the next turn", async (t) => {
  const { session, events } = antigravity(t, { scenario: "slow" });
  await session.startTurn(TURN);
  await waitUntil(() => replyText(events) === "Working");
  const queued = session.startTurn({ ...TURN, prompt: "Dropped" });
  await session.interrupt();
  const after = session.startTurn({ ...TURN, prompt: "After Stop" });
  assert.deepEqual(await queued, { turnId: null, steered: false, cancelled: true });
  assert.ok((await after).turnId);
  assert.equal(of(events, "turn-started").length, 2);
  const prompts = (await sent(session, "session/prompt")).map((params) => params.prompt.at(-1).text);
  assert.equal(prompts.includes("Dropped"), false);
  assert.equal(prompts.at(-1), "After Stop");
});

test("Stop drops a waiting message when it has to kill the agent", async (t) => {
  const { session, events } = antigravity(t, { scenario: "stubborn", interruptGraceMs: 100 });
  await session.startTurn(TURN);
  await waitUntil(() => replyText(events) === "Working");
  const queued = session.startTurn({ ...TURN, prompt: "Dropped" });
  await session.interrupt();
  assert.deepEqual(await queued, { turnId: null, steered: false, cancelled: true });
  assert.deepEqual(events.filter(isTerminal), [{ type: "turn-cancelled" }]);
});

test("a crash fails the turn with the agent's error line", async (t) => {
  const { session, events } = antigravity(t, { scenario: "crash" });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(events.at(-1), failedWith(crashMessage("antigravity", "boom: model unavailable", { signal: null })));
  assert.equal(session.closed, true);
});

test("crashDetail skips info and warning lines", () => {
  assert.equal(crashDetail("I1007 1:1:1.1 1 a.py:1] hi\nTraceback\nValueError: bad\nW1007 1:1:1.1 1 b.py:2] telemetry\n"), "ValueError: bad");
  assert.equal(crashDetail("W1007 1:1:1.1 1 b.py:2] telemetry\n"), "");
});

test("a signed-out agent fails the turn with the login notice", async (t) => {
  for (const scenario of ["logged-out", "prompt-login"]) {
    const { session, events } = antigravity(t, { scenario });
    await session.startTurn(TURN);
    await ended(events);
    assert.deepEqual(events.at(-1), failedWith(loginMessage("antigravity"), { login: true }));
    await waitUntil(() => session.closed);
  }
});

test("an account without a subscription gets its own notice", async (t) => {
  const { session, events } = antigravity(t, { scenario: "subscription" });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(events.at(-1), failedWith(antigravityAcp.subscriptionMessage));
});

test("passes the linked tools as an MCP server, and starts without them when refused", async (t) => {
  const available = [];
  const linked = { url: async () => "http://127.0.0.1:9/mcp/abc", toolsAvailable: (value) => available.push(value) };
  const { session, events } = antigravity(t, { linked });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual((await sent(session, "session/new"))[0].mcpServers, [{ type: "http", name: "milagre", url: "http://127.0.0.1:9/mcp/abc", headers: [] }]);
  assert.deepEqual(available, [true]);

  const refused = antigravity(t, { scenario: "reject-mcp", linked });
  await refused.session.startTurn(TURN);
  await ended(refused.events);
  assert.deepEqual(
    (await sent(refused.session, "session/new")).map((params) => params.mcpServers.length),
    [1, 0],
  );
  assert.deepEqual(available, [true, false]);
  assert.equal(replyText(refused.events), "Hello");
});

test("fails at once without an installed agent", async (t) => {
  const { session, events } = antigravity(t, { command: null });
  await session.startTurn(TURN);
  assert.deepEqual(events, [failedWith(missingCliMessage("antigravity"))]);
});

test("temp directories carry their owner's pid, and a sweep removes only those whose owner has exited", async (t) => {
  const { makeTempDir, sweepTempDirs } = require("./antigravity-acp.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-acp-sweep-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mine = await makeTempDir(root, "run");
  assert.match(path.basename(mine), new RegExp(`^run-${process.pid}-`));
  const exited = path.join(root, "text-999999999-abc");
  const legacy = path.join(root, "run-abcdef");
  fs.mkdirSync(exited);
  fs.mkdirSync(legacy);
  await sweepTempDirs(root);
  assert.deepEqual(fs.readdirSync(root).sort(), [path.basename(legacy), path.basename(mine)].sort());
});

test("Everywhere servers reach session/new", async (t) => {
  const { session, events } = antigravity(t, {
    mcpExtras: async () => ({
      servers: [{ name: "linear", type: "http", url: "https://x", headers: {} }],
      off: ["figma"],
    }),
  });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(
    (await sent(session, "session/new"))[0].mcpServers.map((server) => server.name),
    ["linear"],
  );
});

test("an agent that refuses Everywhere servers still gets milagre, and the linked tools count as available", async (t) => {
  const available = [];
  const linked = { url: async () => "http://127.0.0.1:9/mcp/abc", toolsAvailable: (value) => available.push(value) };
  const { session, events } = antigravity(t, {
    scenario: "reject-extra-mcp",
    linked,
    mcpExtras: async () => ({ servers: [{ name: "linear", type: "http", url: "https://x", headers: {} }], off: [] }),
  });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(
    (await sent(session, "session/new")).map((params) => params.mcpServers.map((server) => server.name)),
    [["milagre", "linear"], ["milagre"]],
  );
  assert.deepEqual(available, [true]);
});

test("a failing mcpExtras still starts the agent and is logged once", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const { session, events } = antigravity(t, {
    mcpExtras: async () => {
      throw new Error("boom");
    },
  });
  await session.startTurn(TURN);
  await ended(events);
  assert.ok(events.some((event) => event.type === "turn-completed"));
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments.join(" ")), /boom/);
});

test("an ACP heartbeat_create result names its Heartbeat on the step and leaves the JSON line out of the detail", () => {
  const call = {
    toolCallId: "hb",
    kind: "other",
    status: "completed",
    title: "milagre_heartbeat_create",
    _meta: { mcp: { server: "milagre", tool: "heartbeat_create" }, is_mcp_tool_call: true },
    content: [{ type: "content", content: { type: "text", text: '{"routine":{"id":"r1","name":"Babysit"}}\nHeartbeat set: every 15 min.' } }],
  };
  assert.deepEqual(acpStepResult(call), { id: "hb", status: "done", routine: { id: "r1", name: "Babysit" }, detail: "Heartbeat set: every 15 min." });
  // Another tool's JSON first line stays as it is.
  const other = { ...call, title: "milagre_routine_list", _meta: { mcp: { server: "milagre", tool: "routine_list" }, is_mcp_tool_call: true } };
  assert.equal(acpStepResult(other).routine, undefined);
  assert.match(acpStepResult(other).detail, /^\{"routine"/);
});
