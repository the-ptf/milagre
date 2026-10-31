const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexRpc } = require("./codex-rpc.cjs");
const { CodexSession, saveGeneratedImage, recoverCodexSubagents } = require("./codex-provider.cjs");
const {
  MILAGRE_INSTRUCTIONS,
  advisorInstructions,
  RESUME_FAILED_MESSAGE,
  crashMessage,
  isTerminal,
  loginMessage,
  missingCliMessage,
  failedWith,
} = require("./events.cjs");
const { decodeImages } = require("../image-input.cjs");
const { waitUntil } = require("./test-helpers.cjs");

const FAKE = path.join(__dirname, "fixtures", "fake-app-server.cjs");
const TURN = { prompt: "Hi", images: [], model: "gpt-6-sol", permissionMode: "auto" };

function codex(
  t,
  {
    scenario = "reply",
    resumeId,
    tldrEnabled,
    analysisOnly,
    executionAdvisor,
    linked,
    mcpExtras,
    command = process.execPath,
    interruptGraceMs,
    permissionPolicy,
  } = {},
) {
  const events = [];
  const requests = [];
  const session = new CodexSession({
    cwd: os.tmpdir(),
    resumeId,
    tldrEnabled,
    analysisOnly,
    executionAdvisor,
    linked,
    mcpExtras,
    command,
    clientVersion: "test",
    interruptGraceMs,
    permissionPolicy,
    emit: (event) => events.push(event),
    createRpc: (options) => {
      const rpc = new CodexRpc({ ...options, args: [FAKE], env: { ...process.env, FAKE_SCENARIO: scenario } });
      const request = rpc.request.bind(rpc);
      rpc.request = (method, params, options) => {
        requests.push({ method, params, options });
        return request(method, params, options);
      };
      return rpc;
    },
  });
  t.after(() => session.close());
  return { session, events, requests };
}
const ended = (events, count = 1) => waitUntil(() => events.filter(isTerminal).length >= count);
const received = async (session) => (await session.rpc.request("fake/received")).received;
const asked = (events) => waitUntil(() => events.some((event) => event.type === "permission-request"));
const replyText = (events) =>
  events
    .filter((event) => event.type === "text-delta")
    .map((event) => event.text)
    .join("");

test("analysis-only Codex pins read-only policy and denies unexpected command approval", async (t) => {
  const { session, events } = codex(t, { scenario: "approval", analysisOnly: true });
  await session.startTurn({ ...TURN, permissionMode: "full" });
  await ended(events);
  assert.equal(replyText(events), "decision:decline");
  assert.equal(
    events.some((event) => event.type === "permission-request"),
    false,
  );
  const messages = await received(session);
  const thread = messages.find((message) => message.method === "thread/start").params;
  assert.equal(thread.sandbox, "read-only");
  // An advisor's own short prompt, not the Chat's (events.cjs advisorInstructions).
  assert.equal(thread.developerInstructions, advisorInstructions());
  assert.equal(thread.config.features.shell_tool, false);
  assert.equal(thread.config.mcp_servers.personal.enabled, false);
  assert.deepEqual(thread.environments, []);
  assert.deepEqual(messages.find((message) => message.method === "turn/start").params.environments, []);
  assert.deepEqual(messages.find((message) => message.method === "turn/start").params.sandboxPolicy, { type: "readOnly", networkAccess: false });
});

test("analysis-only Codex never drops restrictions when a provider rejects config", async (t) => {
  const { session, events, requests } = codex(t, { scenario: "reject-config", analysisOnly: true });
  await session.startTurn(TURN);
  await ended(events);
  assert.equal(events.at(-1).type, "turn-failed");
  const starts = requests.filter((message) => message.method === "thread/start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.config.features.shell_tool, false);
});
test("execution Codex has native shell access and dismisses questions without a human card", async (t) => {
  const { session, events } = codex(t, { executionAdvisor: true, scenario: "question", linked: { tools: [], url: async () => null } });
  await session.startTurn({ ...TURN, permissionMode: "full" });
  await ended(events);
  const messages = await received(session);
  const thread = messages.find((message) => message.method === "thread/start").params;
  assert.equal(thread.sandbox, "danger-full-access");
  assert.notEqual(thread.config.features.shell_tool, false);
  assert.equal(thread.config.features.default_mode_request_user_input, false);
  assert.equal(thread.config.features.multi_agent, false);
  assert.match(thread.developerInstructions, /execution agent/);
  assert.ok(!events.some((event) => event.type === "question-request"));
  assert.match(replyText(events), /answers/);
});

test("streams a reply and keeps one thread across turns", async (t) => {
  const { session, events } = codex(t);
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(events, [
    { type: "session-started", nativeId: "thread-1" },
    { type: "turn-started", turnId: "turn-1" },
    { type: "text-delta", messageId: "turn-1", text: "Hel" },
    { type: "text-delta", messageId: "turn-1", text: "lo" },
    { type: "turn-completed" },
  ]);

  await session.startTurn(TURN);
  await ended(events, 2);
  assert.equal(events.filter((event) => event.type === "session-started").length, 1);
  assert.equal((await session.rpc.request("fake/received")).threadStarts, 1);
  assert.equal(session.nativeId, "thread-1");
});

test("starts threads and turns with Milagre's identity, instructions and policy", async (t) => {
  const { session, events } = codex(t);
  await session.startTurn({ ...TURN, permissionMode: "full" });
  await ended(events);
  const messages = await received(session);
  const find = (method) => messages.find((message) => message.method === method).params;

  assert.equal(find("initialize").clientInfo.name, "milagre");
  assert.equal(find("thread/start").developerInstructions, MILAGRE_INSTRUCTIONS);
  assert.deepEqual(find("thread/start").config, { features: { default_mode_request_user_input: true } });
  assert.equal(find("turn/start").approvalPolicy, "never");
  assert.deepEqual(find("turn/start").sandboxPolicy, { type: "dangerFullAccess" });
  assert.deepEqual(find("turn/start").input, [{ type: "text", text: "Hi", text_elements: [] }]);
  // Reasoning summaries are what the reply's thinking steps show.
  assert.equal(find("turn/start").summary, "auto");
  // Fast mode off: standard speed, whatever ~/.codex/config.toml's service_tier says.
  assert.equal(find("turn/start").serviceTierForTurn, "default");
});

test("fast mode runs the turn on Codex's priority tier", async (t) => {
  const { session, events } = codex(t);
  await session.startTurn({ ...TURN, fastMode: true });
  await ended(events);
  await session.startTurn({ ...TURN, fastMode: false });
  await ended(events, 2);
  const tiers = (await received(session)).filter((message) => message.method === "turn/start").map((message) => message.params.serviceTierForTurn);
  assert.deepEqual(tiers, ["priority", "default"]);
});

test("Ask asks about untrusted commands, Auto only about leaving the sandbox", async (t) => {
  const { session, events } = codex(t);
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await ended(events);
  await session.startTurn({ ...TURN, permissionMode: "auto" });
  await ended(events, 2);
  const turnStarts = (await received(session)).filter((message) => message.method === "turn/start").map((message) => message.params);
  assert.deepEqual(
    turnStarts.map((params) => params.approvalPolicy),
    ["untrusted", "on-request"],
  );
  for (const params of turnStarts) {
    assert.equal(params.sandboxPolicy.type, "workspaceWrite");
    assert.deepEqual(params.sandboxPolicy.writableRoots, [os.tmpdir()]);
  }
});

test("resumes a saved thread without announcing it again", async (t) => {
  const { session, events } = codex(t, { resumeId: "thread-9" });
  await session.startTurn(TURN);
  await ended(events);
  const resume = (await received(session)).find((message) => message.method === "thread/resume").params;
  assert.equal(resume.threadId, "thread-9");
  assert.deepEqual(resume.config, { features: { default_mode_request_user_input: true } });
  assert.equal(
    events.some((event) => event.type === "session-started"),
    false,
  );
  assert.equal(session.nativeId, "thread-9");
});

test("forgets a thread that can't be resumed", async (t) => {
  const { session, events } = codex(t, { resumeId: "missing" });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(events, [{ type: "session-reset" }, failedWith(RESUME_FAILED_MESSAGE)]);
  assert.equal(session.closed, true);
});

test("interrupts a running turn", async (t) => {
  const { session, events } = codex(t, { scenario: "slow" });
  await session.startTurn(TURN);
  await session.interrupt();
  await ended(events);
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
});

test("cancels before Codex has started the turn", async (t) => {
  const { session, events } = codex(t);
  const pending = session.startTurn(TURN);
  await session.interrupt();
  await pending;
  await ended(events);
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
  assert.equal(
    (await received(session)).some((message) => message.method === "turn/start"),
    false,
  );
});

test("a continuation cancelled while Codex initializes submits no turn", async (t) => {
  const { session, events } = codex(t);
  let allowed = true;
  const turn = session.startTurn({ ...TURN, canStart: () => allowed });
  allowed = false;
  assert.equal((await turn).cancelled, true);
  assert.equal(
    events.some((event) => event.type === "turn-cancelled"),
    false,
  );
  assert.equal(
    (await received(session)).some((message) => message.method === "turn/start"),
    false,
  );
});

test("reports a failed turn and a crashed process", async (t) => {
  const failed = codex(t, { scenario: "fail" });
  await failed.session.startTurn(TURN);
  await ended(failed.events);
  assert.deepEqual(failed.events.at(-1), { type: "turn-failed", message: "The model gpt-x is not supported." });

  const crashed = codex(t, { scenario: "crash" });
  await crashed.session.startTurn(TURN);
  await ended(crashed.events);
  assert.deepEqual(crashed.events.at(-1), failedWith(crashMessage("codex", "boom: model unavailable")));
  assert.equal(crashed.session.closed, true);
});

test("in bot mode the policy answers a command approval without a card", async (t) => {
  const seen = [];
  const { session, events } = codex(t, {
    scenario: "approval",
    permissionPolicy: (request) => {
      seen.push(request.command);
      return "allow";
    },
  });
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await ended(events);
  assert.deepEqual(seen, ["rm -rf build"]);
  assert.equal(replyText(events), "decision:accept");
  assert.equal(
    events.some((event) => event.type === "permission-request"),
    false,
  );
});

test("asks before running a command and passes the answer back", async (t) => {
  const { session, events } = codex(t, { scenario: "approval" });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  assert.deepEqual(
    events.find((event) => event.type === "permission-request"),
    {
      type: "permission-request",
      requestId: "srv-1",
      kind: "command",
      tool: "Shell",
      title: "Run this command?",
      command: "rm -rf build",
      cwd: "/repo",
      reason: "Clean the build",
      allowForChat: true,
      stepId: "cmd-1",
    },
  );
  assert.equal(session.respondToPermission("srv-1", "allow-for-chat"), true);
  await ended(events);
  assert.equal(replyText(events), "decision:acceptForSession");
  assert.deepEqual(
    events.find((event) => event.type === "permission-resolved"),
    { type: "permission-resolved", requestId: "srv-1", decision: "allow-for-chat" },
  );
});

test("switching to Full mid-turn approves the waiting command", async (t) => {
  const { session, events } = codex(t, { scenario: "approval" });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  session.setPermissionMode("full");
  await ended(events);
  assert.equal(replyText(events), "decision:accept");
  assert.deepEqual(
    events.find((event) => event.type === "permission-resolved"),
    { type: "permission-resolved", requestId: "srv-1", decision: "allow" },
  );
});

test("MCP tool calls in Ask mode reach the permission card and accept once", async (t) => {
  const { session, events } = codex(t, { scenario: "mcp-approval" });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  const request = events.find((event) => event.type === "permission-request");
  assert.equal(request.kind, "other");
  assert.equal(request.tool, "MCP: milagre");
  assert.equal(request.title, 'Allow the milagre MCP server to run tool "design_delete"?');
  assert.deepEqual(JSON.parse(request.detail), { id: "daily-notes" });
  assert.equal(request.allowForChat, false);
  // A stale or forged "always" UI choice cannot make Codex write a settings rule.
  session.respondToPermission("srv-mcp", "allow-for-chat");
  await ended(events);
  assert.equal(replyText(events), 'answer:{"action":"accept","content":{}}');
  assert.equal(session.respondToPermission("srv-mcp", "allow"), false);
});

test("Milagre's plan tools are accepted without a card in every mode", async (t) => {
  for (const permissionMode of ["ask", "auto"]) {
    const { session, events } = codex(t, { scenario: "mcp-plan-approval" });
    await session.startTurn({ ...TURN, permissionMode });
    await ended(events);
    assert.equal(replyText(events), 'answer:{"action":"accept","content":{}}');
    assert.equal(
      events.some((event) => event.type === "permission-request"),
      false,
    );
  }
});

test("MCP permission denial and cancellation use elicitation responses", async (t) => {
  const denied = codex(t, { scenario: "mcp-approval" });
  await denied.session.startTurn(TURN);
  await asked(denied.events);
  denied.session.respondToPermission("srv-mcp", "deny");
  await ended(denied.events);
  assert.equal(replyText(denied.events), 'answer:{"action":"decline","content":null}');
  const cancelled = codex(t, { scenario: "mcp-approval" });
  await cancelled.session.startTurn(TURN);
  await asked(cancelled.events);
  await cancelled.session.interrupt();
  await ended(cancelled.events);
  assert.ok((await received(cancelled.session)).some((message) => message.id === "srv-mcp" && message.result?.action === "cancel"));
});

test("MCP approvals never grant analysis-only access or submit unknown forms", async (t) => {
  for (const options of [{ scenario: "mcp-approval", analysisOnly: true }, { scenario: "mcp-form" }]) {
    const { session, events } = codex(t, options);
    await session.startTurn({ ...TURN, permissionMode: "full" });
    await ended(events);
    assert.equal(replyText(events), 'answer:{"action":"decline","content":null}');
    assert.equal(
      events.some((event) => event.type === "permission-request"),
      false,
    );
  }
});

test("switching to Auto mid-turn leaves a waiting command to the user", async (t) => {
  const { session, events } = codex(t, { scenario: "approval" });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  session.setPermissionMode("auto");
  assert.equal(session.permissions.size, 1);
  session.respondToPermission("srv-1", "deny");
  await ended(events);
});

const PUSH_DENIED = "Babysit level Fix, don't push doesn't allow pushing to GitHub. Change it in Settings › Experimental › Babysit PRs.";

test("guarded turn denies push and allows ls in full mode", async (t) => {
  const { session, events } = codex(t, { scenario: "guarded" });
  await session.startTurn({ ...TURN, permissionMode: "full", guard: { level: 2, resolveThreads: false } });
  await ended(events);
  // Commands come to Milagre, with Full's sandbox: push is declined, the rest runs unasked.
  assert.equal(replyText(events), "decision:decline decision:accept");
  assert.equal(
    events.some((event) => event.type === "permission-request"),
    false,
  );
  const start = (await received(session)).find((message) => message.method === "turn/start").params;
  assert.equal(start.approvalPolicy, "untrusted");
  assert.deepEqual(start.sandboxPolicy, { type: "dangerFullAccess" });
  // The step says why.
  const step = events.find((event) => event.type === "step-completed" && event.id === "cmd-1");
  assert.equal(step.detail, `$ git push origin HEAD\n${PUSH_DENIED}`);
  // The Chat's next turn is the user's own: Full asks about nothing again.
  await session.startTurn({ ...TURN, permissionMode: "full" });
  await ended(events, 2);
  const starts = (await received(session)).filter((message) => message.method === "turn/start");
  assert.equal(starts[1].params.approvalPolicy, "never");
});

test("a guarded turn in Ask or Auto keeps its policy, denies push and asks about the rest", async (t) => {
  for (const [permissionMode, policy] of [
    ["ask", "untrusted"],
    ["auto", "on-request"],
  ]) {
    const { session, events } = codex(t, { scenario: "guarded" });
    await session.startTurn({ ...TURN, permissionMode, guard: { level: 2, resolveThreads: false } });
    await asked(events);
    assert.equal(events.find((event) => event.type === "permission-request").command, "ls build", permissionMode);
    session.respondToPermission("srv-2", "allow");
    await ended(events);
    assert.equal(replyText(events), "decision:decline decision:accept");
    assert.equal((await received(session)).find((message) => message.method === "turn/start").params.approvalPolicy, policy);
  }
});

test("a command that writes to GitHub is allowed once, never for the whole Chat", async (t) => {
  const { session, events } = codex(t, { scenario: "guarded" });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  const push = events.find((event) => event.type === "permission-request");
  assert.equal(push.command, "git push origin HEAD");
  assert.equal(push.allowForChat, false);
  session.respondToPermission("srv-1", "allow-for-chat");
  await waitUntil(() => events.filter((event) => event.type === "permission-request").length === 2);
  const list = events.filter((event) => event.type === "permission-request")[1];
  assert.equal(list.allowForChat, true);
  session.respondToPermission("srv-2", "allow-for-chat");
  await ended(events);
  // A cached approval would let a later babysit Run's push run without asking, past the guard.
  assert.equal(replyText(events), "decision:accept decision:acceptForSession");
  assert.deepEqual(
    events.filter((event) => event.type === "permission-resolved").map((event) => event.decision),
    ["allow", "allow-for-chat"],
  );
});

test("denying declines the command", async (t) => {
  const { session, events } = codex(t, { scenario: "approval" });
  await session.startTurn(TURN);
  await asked(events);
  session.respondToPermission("srv-1", "deny");
  await ended(events);
  assert.equal(replyText(events), "decision:decline");
});

test("file changes show the diff Codex is about to apply", async (t) => {
  const { session, events } = codex(t, { scenario: "file-approval" });
  await session.startTurn(TURN);
  await asked(events);
  assert.deepEqual(
    events.find((event) => event.type === "permission-request"),
    {
      type: "permission-request",
      requestId: "srv-1",
      kind: "edit",
      tool: "Edit files",
      title: "Edit notes.txt?",
      files: ["/repo/notes.txt"],
      diff: "--- /repo/notes.txt\n+hello\n",
      reason: "Write notes",
      allowForChat: true,
      stepId: "patch-1",
    },
  );
  session.respondToPermission("srv-1", "allow");
  await ended(events);
  assert.equal(replyText(events), "decision:accept");
});

test("interrupting cancels a pending approval", async (t) => {
  const { session, events } = codex(t, { scenario: "approval" });
  await session.startTurn(TURN);
  await asked(events);
  await session.interrupt();
  await ended(events);
  assert.deepEqual(
    events.find((event) => event.type === "permission-resolved"),
    { type: "permission-resolved", requestId: "srv-1", decision: "cancelled" },
  );
  assert.equal(replyText(events), "decision:cancel");
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
});

test("a request Codex withdraws is dropped without an answer", async (t) => {
  const { session, events } = codex(t, { scenario: "withdrawn" });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(
    events.find((event) => event.type === "permission-resolved"),
    { type: "permission-resolved", requestId: "srv-1", decision: "cancelled" },
  );
  assert.equal(
    (await received(session)).some((message) => message.id === "srv-1"),
    false,
  );
  assert.equal(session.respondToPermission("srv-1", "allow"), false);
});

test("extra sandbox permissions are declined", async (t) => {
  const { session, events } = codex(t, { scenario: "permissions" });
  await session.startTurn(TURN);
  await ended(events);
  assert.equal(replyText(events), 'answer:{"permissions":{},"scope":"turn"}');
  assert.equal(
    events.some((event) => event.type === "permission-request"),
    false,
  );
});

test("passes images as interleaved local files and removes them afterwards", async (t) => {
  const { session, events } = codex(t);
  const png = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString("base64")}`;
  await session.startTurn({ ...TURN, prompt: "Before [Image #2] then [Image #1] after", images: decodeImages([{ dataUrl: png }, { dataUrl: png }]) });
  await ended(events);
  const turnStart = (await received(session)).find((message) => message.method === "turn/start");
  const input = turnStart.params.input;
  assert.deepEqual(
    input.map((block) => block.type),
    ["text", "localImage", "text", "localImage", "text"],
  );
  assert.deepEqual(
    input.filter((block) => block.type === "text").map((block) => block.text),
    ["Before ", " then ", " after"],
  );
  assert.deepEqual(turnStart.imagesExist, [true, true]);
  for (const image of input.filter((block) => block.type === "localImage")) assert.equal(fs.existsSync(image.path), false);
});

test("closes a session whose startup failed so the next message starts over", async (t) => {
  const { session, events } = codex(t, { command: "milagre-definitely-missing-cli" });
  await session.startTurn(TURN);
  assert.match(events.at(-1).message, /isn't installed or isn't on your PATH/);
  assert.equal(session.closed, true);
});

test("a logged-out Codex fails the turn at once with the login message", async (t) => {
  const { session, events } = codex(t, { scenario: "logged-out" });
  await session.startTurn(TURN);
  assert.deepEqual(events, [failedWith(loginMessage("codex"), { login: true })]);
  assert.equal(session.closed, true);
});

test("a Codex on a provider that needs no OpenAI login isn't held up", async (t) => {
  const { session, events } = codex(t, { scenario: "custom-provider" });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(events.at(-1), { type: "turn-completed" });
  assert.deepEqual((await received(session)).map((message) => message.method).slice(0, 4), ["initialize", "initialized", "account/read", "thread/start"]);
});

test("explains a missing CLI without starting anything", async (t) => {
  const { session, events } = codex(t, { command: null });
  await session.startTurn(TURN);
  assert.deepEqual(events, [failedWith(missingCliMessage("codex"))]);
});

test("gives up on an interrupt Codex never answers", async (t) => {
  const { session, events } = codex(t, { scenario: "stubborn", interruptGraceMs: 50 });
  await session.startTurn(TURN);
  await session.interrupt();
  await ended(events);
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
  assert.equal(session.closed, true);
});

test("cancels a startup that hangs", async (t) => {
  const { session, events } = codex(t, { scenario: "hang-init", interruptGraceMs: 50 });
  const pending = session.startTurn(TURN);
  await session.interrupt();
  await ended(events);
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
  assert.equal(session.closed, true);
  await pending;
});

test("starts and resumes threads without a time limit", async (t) => {
  const started = codex(t);
  await started.session.startTurn(TURN);
  await ended(started.events);
  const resumed = codex(t, { resumeId: "thread-9" });
  await resumed.session.startTurn(TURN);
  await ended(resumed.events);
  assert.equal(started.requests.find((r) => r.method === "thread/start").options.timeoutMs, null);
  assert.equal(resumed.requests.find((r) => r.method === "thread/resume").options.timeoutMs, null);
});

test("cancels a thread start that never answers", async (t) => {
  const { session, events, requests } = codex(t, { scenario: "hang-thread", interruptGraceMs: 50 });
  const pending = session.startTurn(TURN);
  await waitUntil(() => requests.some((r) => r.method === "thread/start"));
  await session.interrupt();
  await ended(events);
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
  assert.equal(session.closed, true);
  await pending;
});

test("keeps the saved thread when resuming fails without an answer", async (t) => {
  const { session, events } = codex(t, { scenario: "resume-exit", resumeId: "thread-9" });
  await session.startTurn(TURN);
  await ended(events);
  assert.equal(
    events.some((event) => event.type === "session-reset"),
    false,
  );
  assert.equal(events.at(-1).type, "turn-failed");
  assert.equal(session.nativeId, "thread-9");
});

test("steers a running turn", async (t) => {
  const { session, events } = codex(t, { scenario: "steer" });
  const first = await session.startTurn(TURN);
  const second = await session.startTurn({ ...TURN, prompt: "Also add tests" });
  await ended(events);
  assert.deepEqual(first, { turnId: "turn-1", steered: false });
  assert.deepEqual(second, { turnId: "turn-1", steered: true });
  assert.ok(events.some((event) => event.type === "text-delta" && event.text === "steered:Also add tests"));
  const steer = (await received(session)).find((message) => message.method === "turn/steer").params;
  assert.equal(steer.expectedTurnId, "turn-1");
  assert.equal(steer.threadId, "thread-1");
  assert.deepEqual(steer.input, [{ type: "text", text: "Also add tests", text_elements: [] }]);
});

test("a steer Codex refuses starts the next turn once this one ends", async (t) => {
  const { session, events } = codex(t, { scenario: "steer" });
  await session.startTurn(TURN);
  const late = await session.startTurn({ ...TURN, prompt: "too late" });
  await ended(events, 2);
  assert.deepEqual(late, { turnId: "turn-2", steered: false });
  assert.deepEqual(
    events.filter((event) => event.type === "turn-started").map((event) => event.turnId),
    ["turn-1", "turn-2"],
  );
  const types = events.map((event) => event.type);
  assert.ok(types.indexOf("turn-completed") < types.lastIndexOf("turn-started"));
  const starts = (await received(session)).filter((message) => message.method === "turn/start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1].params.input[0].text, "too late");
});

test("a steer sent before Codex has started the turn waits for it", async (t) => {
  const { session, events } = codex(t, { scenario: "steer" });
  const first = session.startTurn(TURN);
  const second = session.startTurn({ ...TURN, prompt: "Also add tests" });
  assert.deepEqual(await second, { turnId: "turn-1", steered: true });
  assert.deepEqual(await first, { turnId: "turn-1", steered: false });
  await ended(events);
});

test("a steer for a turn Codex gave no id becomes the next turn", async (t) => {
  const { session, events } = codex(t, { scenario: "no-turn-id" });
  const first = await session.startTurn(TURN);
  assert.deepEqual(first, { turnId: null, steered: false });
  const second = await session.startTurn({ ...TURN, prompt: "Also add tests" });
  await ended(events, 2);
  assert.deepEqual(second, { turnId: "turn-2", steered: false });
  const starts = (await received(session)).filter((message) => message.method === "turn/start");
  assert.equal(starts.length, 2);
  assert.equal(starts[1].params.input[0].text, "Also add tests");
});

test("a turn's end settles even when a new turn starts during its cleanup", async (t) => {
  const { session } = codex(t, { scenario: "slow" });
  await session.startTurn(TURN);
  const firstEnded = session.turnEnded;
  let settled = false;
  void firstEnded.then(() => {
    settled = true;
  });
  // Hold the first turn's finishTurn on a pending image cleanup, so a new turn can start inside it.
  let release;
  session.imageSets.push({
    cleanup: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  await session.interrupt();
  await waitUntil(() => release);
  assert.equal(session.turnActive, false);
  await session.startTurn(TURN);
  const secondEnded = session.turnEnded;
  let secondSettled = false;
  void secondEnded.then(() => {
    secondSettled = true;
  });
  release();
  await waitUntil(() => settled);
  assert.notEqual(firstEnded, secondEnded);
  assert.equal(secondSettled, false);
});

test("a message sent while a turn is stopping starts the next turn", async (t) => {
  const { session, events } = codex(t, { scenario: "slow-stop" });
  const first = await session.startTurn(TURN);
  const stopping = session.interrupt();
  const second = await session.startTurn({ ...TURN, prompt: "Next" });
  await stopping;
  await ended(events, 2);
  assert.deepEqual(first, { turnId: "turn-1", steered: false });
  assert.deepEqual(second, { turnId: "turn-2", steered: false });
  assert.deepEqual(events.filter(isTerminal), [{ type: "turn-cancelled" }, { type: "turn-completed" }]);
  const types = events.map((event) => event.type);
  assert.ok(types.indexOf("turn-cancelled") < types.lastIndexOf("turn-started"));
  const messages = await received(session);
  assert.equal(messages.filter((message) => message.method === "turn/steer").length, 0);
  assert.equal(messages.filter((message) => message.method === "turn/start").length, 2);
});

test("a message sent while Stop closes the session is handed back as sessionClosed", async (t) => {
  const { session, events } = codex(t, { scenario: "stubborn", interruptGraceMs: 50 });
  await session.startTurn(TURN);
  const stopping = session.interrupt();
  await assert.rejects(session.startTurn({ ...TURN, prompt: "Next" }), (error) => error.sessionClosed === true);
  await stopping;
  assert.deepEqual(events.filter(isTerminal), [{ type: "turn-cancelled" }]);
  assert.equal(
    events.some((event) => event.type === "turn-failed"),
    false,
  );
  assert.equal(session.closed, true);
});

test("an approval requested after the turn was stopped is cancelled at once", async (t) => {
  const { session, events } = codex(t, { scenario: "late-approval" });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await session.interrupt();
  await ended(events);
  let answer;
  for (let attempt = 0; !answer; attempt += 1) {
    assert.ok(attempt < 300, "Timed out waiting for the late approval's answer");
    answer = (await received(session)).find((message) => message.id === "srv-late");
    if (!answer) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(answer.result, { decision: "cancel" });
  assert.equal(
    events.some((event) => event.type === "permission-request" || event.type === "permission-resolved"),
    false,
  );
  assert.equal(session.permissions.size, 0);
});

test("a turn Codex announces that this session isn't running is ignored", async (t) => {
  const { session, events } = codex(t);
  await session.startTurn(TURN);
  await ended(events);
  await session.rpc.request("fake/turn-started");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(events.filter((event) => event.type === "turn-started").length, 1);
});

test("commands, reasoning and file changes become steps, in order with the reply", async (t) => {
  const { session, events } = codex(t, { scenario: "steps" });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(events.slice(2), [
    { type: "step-started", step: { id: "exec-1", kind: "shell", title: "Ran `npm test`", detail: "$ npm test\n" } },
    { type: "step-output", id: "exec-1", text: "ok 2\n" },
    { type: "step-completed", id: "exec-1", status: "done", detail: "$ npm test\nok 1\nok 2\n" },
    { type: "step-started", step: { id: "rs-1", kind: "thinking", title: "Thinking" } },
    { type: "step-started", step: { id: "exec-2", kind: "edit", title: "Created `notes.txt`", file: "/repo/notes.txt" } },
    { type: "step-completed", id: "exec-2", status: "done", title: "Created `notes.txt`", detail: "--- /repo/notes.txt\n+hello\n" },
    { type: "text-delta", messageId: "turn-1", text: "Done" },
    { type: "turn-completed" },
  ]);
});

test("a command still running when the turn is stopped gets no step-completed", async (t) => {
  const { session, events } = codex(t, { scenario: "running-step" });
  await session.startTurn(TURN);
  await waitUntil(() => events.some((event) => event.type === "step-started"));
  await session.interrupt();
  await ended(events);
  assert.equal(
    events.some((event) => event.type === "step-completed"),
    false,
  );
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
  assert.equal(session.state.steps.size, 0);
});

test("bot mode asks for every command with network on", async (t) => {
  const { session, events } = codex(t);
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await ended(events);
  const messages = await received(session);
  const find = (method) => messages.find((message) => message.method === method).params;
  assert.equal(find("turn/start").approvalPolicy, "untrusted");
  assert.equal(find("turn/start").sandboxPolicy.type, "workspaceWrite");
  assert.equal(find("turn/start").sandboxPolicy.networkAccess, true);
  assert.deepEqual(find("turn/start").sandboxPolicy.writableRoots, [os.tmpdir()]);
  assert.equal(find("thread/start").sandbox, "workspace-write");
});

test("an unknown permission mode uses Ask's policy", async (t) => {
  const { session, events } = codex(t);
  await session.startTurn({ ...TURN, permissionMode: "something-else" });
  await ended(events);
  const params = (await received(session)).find((message) => message.method === "turn/start").params;
  assert.equal(params.approvalPolicy, "untrusted");
  assert.equal(params.sandboxPolicy.type, "workspaceWrite");
  assert.equal((await received(session)).find((message) => message.method === "thread/start").params.sandbox, "workspace-write");
});

const questioned = (events) => waitUntil(() => events.some((event) => event.type === "question-request"));
// Polls until the fake app-server has received the client's reply to one of its own requests.
async function replyTo(session, id) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const reply = (await received(session)).find((message) => message.id === id && !message.method);
    if (reply) return reply;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for the reply to ${id}`);
}

test("Codex's question becomes a card, and the answers go back per question id", async (t) => {
  const { session, events } = codex(t, { scenario: "question" });
  await session.startTurn(TURN);
  await questioned(events);
  assert.deepEqual(
    events.find((event) => event.type === "question-request"),
    {
      type: "question-request",
      requestId: "srv-q",
      questions: [
        {
          id: "color",
          header: "Color",
          question: "Which color?",
          options: [
            { label: "Red", description: "Warm" },
            { label: "Green", description: "Calm" },
          ],
          multiSelect: false,
          allowOther: true,
          secret: false,
        },
      ],
    },
  );
  assert.equal(session.answerQuestion("srv-q", { color: ["Green"] }), true);
  await ended(events);
  assert.equal(replyText(events), 'answer:{"answers":{"color":{"answers":["Green"]}}}');
  assert.deepEqual(
    events.find((event) => event.type === "question-resolved"),
    { type: "question-resolved", requestId: "srv-q", outcome: "answered" },
  );
});

test("dismissing Codex's question sends no answers", async (t) => {
  const { session, events } = codex(t, { scenario: "question" });
  await session.startTurn(TURN);
  await questioned(events);
  session.answerQuestion("srv-q", null);
  await ended(events);
  assert.equal(replyText(events), 'answer:{"answers":{}}');
  assert.equal(events.find((event) => event.type === "question-resolved").outcome, "dismissed");
});

test("interrupting cancels Codex's open question", async (t) => {
  const { session, events } = codex(t, { scenario: "question" });
  await session.startTurn(TURN);
  await questioned(events);
  await session.interrupt();
  await ended(events);
  assert.deepEqual(
    events.find((event) => event.type === "question-resolved"),
    { type: "question-resolved", requestId: "srv-q", outcome: "cancelled" },
  );
  assert.equal(replyText(events), 'answer:{"answers":{}}');
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
  assert.equal(session.answerQuestion("srv-q", { color: ["Green"] }), false);
});

test("a question Codex withdraws is dropped without an answer", async (t) => {
  const { session, events } = codex(t, { scenario: "question-withdrawn" });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(
    events.find((event) => event.type === "question-resolved"),
    { type: "question-resolved", requestId: "srv-q", outcome: "cancelled" },
  );
  assert.equal(
    (await received(session)).some((message) => message.id === "srv-q"),
    false,
  );
  assert.equal(session.answerQuestion("srv-q", null), false);
});

test("a steering message dismisses Codex's open question, then steers the turn", async (t) => {
  const { session, events } = codex(t, { scenario: "question-steer" });
  await session.startTurn(TURN);
  await questioned(events);
  assert.deepEqual(await session.startTurn({ ...TURN, prompt: "Green, please" }), { turnId: "turn-1", steered: true });
  await ended(events);
  assert.equal(events.find((event) => event.type === "question-resolved").outcome, "dismissed");
  assert.equal(replyText(events), "steered:Green, please");
  const messages = await received(session);
  const answer = messages.findIndex((message) => message.id === "srv-q");
  assert.deepEqual(messages[answer].result, { answers: {} });
  assert.ok(answer < messages.findIndex((message) => message.method === "turn/steer"));
});

test("a question asked after the turn was stopped gets no answers at once", async (t) => {
  const { session, events } = codex(t, { scenario: "late-question" });
  await session.startTurn(TURN);
  await session.interrupt();
  await ended(events);
  assert.deepEqual((await replyTo(session, "srv-late")).result, { answers: {} });
  assert.equal(
    events.some((event) => event.type === "question-request" || event.type === "question-resolved"),
    false,
  );
  assert.equal(session.questions.size, 0);
});

test("threads start and resume without the question tool when Codex rejects the config", async (t) => {
  for (const options of [{}, { resumeId: "thread-9" }]) {
    const { session, events } = codex(t, { scenario: "reject-config", ...options });
    await session.startTurn(TURN);
    await ended(events);
    const calls = (await received(session)).filter((message) => message.method === "thread/start" || message.method === "thread/resume");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].params.config !== undefined, true);
    assert.equal("config" in calls[1].params, false);
    assert.equal(
      events.some((event) => event.type === "session-reset"),
      false,
    );
    assert.deepEqual(events.at(-1), { type: "turn-completed" });
  }
});

test("a Chat's linked tools reach Codex as an MCP server in the thread config; a Codex that refuses it makes the Chat receive-only", async (t) => {
  const reported = [];
  const linked = { tools: [], url: async () => "http://127.0.0.1:1234/mcp/abc", toolsAvailable: (available) => reported.push(available) };
  const { session, events } = codex(t, { linked });
  await session.startTurn(TURN);
  await ended(events);
  const start = (await received(session)).find((message) => message.method === "thread/start").params;
  assert.deepEqual(start.config, {
    features: { default_mode_request_user_input: true },
    mcp_servers: { milagre: { url: "http://127.0.0.1:1234/mcp/abc", tool_timeout_sec: 86400 } },
  });
  assert.deepEqual(reported, [true]);
  const rejecting = codex(t, { scenario: "reject-config", linked });
  await rejecting.session.startTurn(TURN);
  await ended(rejecting.events);
  const attempts = (await received(rejecting.session)).filter((message) => message.method === "thread/start").map((message) => message.params.config);
  assert.deepEqual(
    attempts,
    [start.config, { features: { default_mode_request_user_input: true } }, undefined],
    "the MCP server goes first, the whole config last",
  );
  assert.deepEqual(reported, [true, false]);
  assert.deepEqual(rejecting.events.at(-1), { type: "turn-completed" });
});

test("a Codex whose token expired mid-session closes its session, so the next message starts a fresh app-server", async (t) => {
  const { session, events } = codex(t, { scenario: "unauthorized" });
  await session.startTurn(TURN);
  await ended(events);
  // closed flips when close() starts; the app-server's exit lands once the kill completes.
  await waitUntil(() => session.closed && session.rpc.exited);
  assert.deepEqual(events.at(-1), failedWith(loginMessage("codex"), { login: true }));
});

test("a 401 on a provider that needs no OpenAI login keeps Codex's own error and the session", async (t) => {
  const { session, events } = codex(t, { scenario: "unauthorized-custom" });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(events.at(-1), { type: "turn-failed", message: "unexpected status 401 Unauthorized: token expired" });
  assert.equal(session.closed, false);
});

test("after a login failure the next message starts a fresh app-server that resumes the saved thread", async (t) => {
  const { SessionManager } = require("./session-manager.cjs");
  const sessions = [];
  const sent = [];
  const manager = new SessionManager({
    send: (chatId, event) => sent.push(event),
    createSession: (provider, options) => {
      const scenario = sessions.length === 0 ? "unauthorized" : "reply";
      const session = new CodexSession({
        ...options,
        cwd: os.tmpdir(),
        clientVersion: "test",
        createRpc: (rpcOptions) => new CodexRpc({ ...rpcOptions, args: [FAKE], env: { ...process.env, FAKE_SCENARIO: scenario } }),
      });
      sessions.push(session);
      return session;
    },
  });
  t.after(() => Promise.all(sessions.map((session) => session.close())));
  const request = {
    chatId: "chat-1",
    provider: "codex",
    cwd: os.tmpdir(),
    command: process.execPath,
    prompt: "Hi",
    images: [],
    model: "gpt-6-sol",
    permissionMode: "auto",
    resumeId: "thread-1",
  };
  await manager.startTurn(request);
  await waitUntil(() => sent.some((event) => event.login) && sessions[0].closed);
  await manager.startTurn(request);
  await waitUntil(() => sent.filter(isTerminal).length === 2);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sent.at(-1), { type: "turn-completed" });
  assert.equal(
    sent.some((event) => event.message === RESUME_FAILED_MESSAGE),
    false,
  );
});

test("a crashed Codex's failure is one of Milagre's own messages", async (t) => {
  const { session, events } = codex(t, { scenario: "crash" });
  await session.startTurn(TURN);
  await ended(events);
  assert.equal(events.at(-1).notice, true);
});

test("TLDR can be disabled when starting or resuming Codex", async (t) => {
  for (const resumeId of [undefined, "thread-existing"]) {
    const { session, events } = codex(t, { tldrEnabled: false, resumeId });
    await session.startTurn(TURN);
    await ended(events);
    const calls = await received(session);
    const params = calls.find((call) => call.method === (resumeId ? "thread/resume" : "thread/start")).params;
    assert.ok(!params.developerInstructions.includes("# tldr eval"));
    assert.match(params.developerInstructions, /TLDR.*disabled/);
  }
});

function childPoller(request) {
  const events = [];
  const session = new CodexSession({ emit: (e) => events.push(e) });
  session.state.threadId = "parent";
  session.state.subagents = new Map([["child", { id: "child", title: "Review", status: "running", startedAt: 1, updatedAt: 1, transcript: [] }]]);
  session.rpc = { request };
  return { session, events };
}

test("reads paginated child history without resuming and keeps completion separate from parent", async () => {
  const { session, events } = childPoller(async (method, params) => {
    if (method === "thread/read") {
      assert.deepEqual(params, { threadId: "child" });
      return { thread: { id: "child", status: { type: "idle" } } };
    }
    assert.equal(method, "thread/turns/list");
    assert.equal(params.itemsView, "full");
    assert.equal(params.sortDirection, "desc");
    return {
      data: [{ id: "t", status: "completed", items: [{ id: "m", type: "agentMessage", text: "Paged result" }] }],
      nextCursor: null,
      backwardsCursor: "anchor-t",
    };
  });
  await session.refreshSubagents();
  assert.equal(
    events.some((e) => e.type === "turn-completed"),
    false,
  );
  const child = events.findLast((e) => e.type === "subagent-update").agent;
  assert.equal(child.status, "completed");
  assert.equal(child.transcript[0].text, "Paged result");
});

test("child polling starts at the last turn, follows pages and updates active items with the same id", async () => {
  let round = 0;
  const calls = [];
  const turn = (id, text, status = "completed") => ({ id, status, items: [{ id: "message-" + id, type: "agentMessage", text }] });
  const { session, events } = childPoller(async (method, params) => {
    assert.ok(!params.includeTurns);
    if (method === "thread/read") return { thread: { id: "child", status: { type: "active" } } };
    assert.equal(method, "thread/turns/list");
    calls.push(params);
    if (params.sortDirection === "desc")
      return {
        data: [turn(round === 2 ? "t3" : "t1", round === 0 ? "Partial" : "Complete", round === 0 ? "inProgress" : "completed")],
        backwardsCursor: round === 2 ? "anchor-3" : "anchor-1",
        nextCursor: null,
      };
    assert.equal(params.sortDirection, "asc");
    assert.equal(params.cursor, round === 3 ? "anchor-3" : params.cursor);
    if (params.cursor === "page-2") return { data: [turn("t3", "Third")], nextCursor: null };
    assert.equal(params.cursor, round === 3 ? "anchor-3" : "anchor-1");
    return {
      data: round === 1 ? [turn("t1", "Complete")] : round === 2 ? [turn("t1", "Complete"), turn("t2", "Second")] : [turn("t3", "Third")],
      nextCursor: round === 2 ? "page-2" : null,
    };
  });
  await session.refreshSubagents();
  assert.equal(events.at(-1).agent.transcript[0].text, "Partial");
  round = 1;
  await session.refreshSubagents();
  assert.equal(events.at(-1).agent.transcript[0].text, "Complete");
  round = 2;
  await session.refreshSubagents();
  assert.deepEqual(
    events.at(-1).agent.transcript.map((x) => x.text),
    ["Complete", "Second", "Third"],
  );
  const count = events.length;
  round = 3;
  await session.refreshSubagents();
  assert.equal(events.length, count, "unchanged completed ids emit nothing");
  assert.ok(calls.some((p) => p.cursor === "page-2"));
});

test("a generated image Codex didn't save is written out from its base64", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-ig-test-"));
  try {
    const item = { type: "imageGeneration", id: "ig/1", status: "completed", result: Buffer.from("png bytes").toString("base64") };
    const saved = saveGeneratedImage(item, directory);
    assert.equal(saved.savedPath, path.join(directory, "ig_1.png"));
    assert.equal(fs.readFileSync(saved.savedPath, "utf8"), "png bytes");
    const already = { ...item, savedPath: "/elsewhere.png" };
    assert.equal(saveGeneratedImage(already, directory), already);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// Canvas lifecycle fixtures expose the same paginated contract as live child polling.
function childSnapshotRpc(snapshot, onRead = () => {}) {
  return {
    close: async () => {},
    request: async (method, params) => {
      assert.equal(params.threadId, "child");
      assert.ok(!params.includeTurns);
      const thread = structuredClone(snapshot());
      if (method === "thread/read") {
        onRead();
        return { thread: { ...thread, turns: [] } };
      }
      assert.equal(method, "thread/turns/list");
      return { data: thread.turns.toReversed(), nextCursor: null };
    },
  };
}

test("a completed child catches up to a follow-up turn after native interaction without replaying history", async (t) => {
  const events = [];
  const session = new CodexSession({ emit: (event) => events.push(event) });
  t.after(() => session.close());
  session.state.threadId = "parent";
  session.state.subagents = new Map([["child", { id: "child", title: "Review", status: "completed", startedAt: 1, updatedAt: 2, endedAt: 2, transcript: [] }]]);
  const firstTurn = { id: "first", status: "completed", items: [{ type: "agentMessage", id: "old-answer", text: "First review finished" }] };
  let snapshot = { id: "child", status: { type: "idle" }, turns: [firstTurn] };
  let reads = 0;
  session.rpc = childSnapshotRpc(
    () => snapshot,
    () => reads++,
  );
  await session.refreshSubagents();
  const interaction = {
    threadId: "parent",
    item: { type: "subAgentActivity", id: "follow-up", kind: "interacted", agentThreadId: "child", agentPath: "/root/review" },
  };
  session.handleNotification("item/completed", interaction);
  assert.equal(session.state.subagents.get("child").status, "completed");
  // The provider may return the old completed turn before it has flushed the follow-up.
  await session.refreshSubagents();
  assert.equal(reads, 2);
  assert.equal(session.state.subagents.get("child").status, "completed");
  const followup = { id: "followup", status: "inProgress", items: [] };
  snapshot = { id: "child", status: { type: "active", activeFlags: ["waitingOnApproval"] }, turns: [firstTurn, followup] };
  await session.refreshSubagents();
  assert.equal(session.state.subagents.get("child").status, "waiting");
  assert.equal(session.state.subagents.get("child").endedAt, undefined);
  snapshot = { ...snapshot, status: { type: "active", activeFlags: [] } };
  await session.refreshSubagents();
  assert.equal(session.state.subagents.get("child").status, "running");
  snapshot = {
    ...snapshot,
    status: { type: "idle" },
    turns: [firstTurn, { ...followup, status: "completed", items: [{ type: "agentMessage", id: "new-answer", text: "Follow-up finished" }] }],
  };
  await session.refreshSubagents();
  assert.equal(session.state.subagents.get("child").status, "completed");
  assert.deepEqual(
    session.state.subagents.get("child").transcript.map((entry) => entry.text),
    ["First review finished", "Follow-up finished"],
  );
  const saved = structuredClone(session.state.subagents.get("child"));
  session.handleNotification("item/completed", interaction);
  await session.refreshSubagents();
  assert.deepEqual(session.state.subagents.get("child"), saved);
  assert.equal(
    events.some((event) => event.type === "turn-started" || event.type === "turn-completed"),
    false,
  );
});

test("a new interaction briefly polls a finished child without claiming a message restarted it", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const events = [];
  const session = new CodexSession({ emit: (event) => events.push(event) });
  t.after(() => session.close());
  session.state.threadId = "parent";
  session.state.subagents = new Map([["child", { id: "child", title: "Review", status: "completed", startedAt: 1, updatedAt: 2, endedAt: 2, transcript: [] }]]);
  let reads = 0;
  session.rpc = childSnapshotRpc(
    () => ({ id: "child", status: { type: "idle" }, turns: [{ id: "done", status: "completed", items: [] }] }),
    () => reads++,
  );
  await session.refreshSubagents();
  const interaction = {
    threadId: "parent",
    item: { type: "subAgentActivity", id: "message", kind: "interacted", agentThreadId: "child", agentPath: "/root/review" },
  };
  session.handleNotification("item/completed", interaction);
  await session.refreshSubagents();
  assert.equal(reads, 2);
  assert.equal(session.state.subagents.get("child").status, "completed");
  now += 1500;
  await session.refreshSubagents();
  assert.equal(reads, 3);
  now += 60000;
  await session.refreshSubagents();
  assert.equal(reads, 3);
  session.handleNotification("item/completed", interaction);
  await session.refreshSubagents();
  assert.equal(reads, 3);
  assert.equal(
    events.some((event) => event.type === "subagent-update" && event.agent.status !== "completed"),
    false,
  );
});

test("a resumed child latest in-progress turn corrects an earlier completion record", async (t) => {
  const session = new CodexSession({ emit: () => {} });
  t.after(() => session.close());
  session.state.threadId = "parent";
  session.state.subagents = new Map([["child", { id: "child", title: "Review", status: "completed", startedAt: 1, updatedAt: 2, endedAt: 2, transcript: [] }]]);
  session.rpc = childSnapshotRpc(() => ({
    id: "child",
    status: { type: "notLoaded" },
    turns: [
      { id: "old", status: "completed", items: [] },
      { id: "new", status: "inProgress", items: [] },
    ],
  }));
  await session.refreshSubagents();
  assert.equal(session.state.subagents.get("child").status, "running");
  assert.equal(session.state.subagents.get("child").endedAt, undefined);
});

test("child turn notifications remain live after the parent finishes", (t) => {
  const events = [];
  const session = new CodexSession({ emit: (event) => events.push(event) });
  t.after(() => session.close());
  session.state.threadId = "parent";
  session.state.subagents = new Map([["child", { id: "child", title: "Review", status: "completed", startedAt: 1, updatedAt: 2, endedAt: 2, transcript: [] }]]);
  session.handleNotification("turn/started", { threadId: "child", turn: { id: "followup", status: "inProgress", items: [] } });
  assert.equal(session.state.subagents.get("child").status, "running");
  assert.equal(
    events.some((event) => event.type === "turn-started"),
    false,
  );
  session.handleNotification("turn/started", { threadId: "parent", turn: { id: "stale-parent", status: "inProgress", items: [] } });
  assert.equal(
    events.some((event) => event.type === "turn-started"),
    false,
  );
});

test("the scheduled child poll continues through stale completion until a follow-up appears", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const session = new CodexSession({ emit: () => {} });
  t.after(() => session.close());
  session.state.threadId = "parent";
  session.state.subagents = new Map([["child", { id: "child", title: "Review", status: "completed", startedAt: 1, updatedAt: 2, endedAt: 2, transcript: [] }]]);
  let reads = 0;
  let followup = false;
  session.rpc = childSnapshotRpc(
    () => ({
      id: "child",
      status: { type: followup ? "active" : "idle", ...(followup ? { activeFlags: [] } : {}) },
      turns: [{ id: followup ? "followup" : "first", status: followup ? "inProgress" : "completed", items: [] }],
    }),
    () => reads++,
  );
  await session.refreshSubagents();
  session.handleNotification("item/completed", {
    threadId: "parent",
    item: { type: "subAgentActivity", id: "follow-up", kind: "interacted", agentThreadId: "child", agentPath: "/root/review" },
  });
  t.mock.timers.tick(1500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  followup = true;
  t.mock.timers.tick(1500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 3);
  assert.equal(session.state.subagents.get("child").status, "running");
});

const savedUnknownChild = (id) => ({
  id,
  title: "Review auth",
  status: "unknown",
  startedAt: 1,
  updatedAt: 10,
  endedAt: 9,
  parentId: "review-parent",
  latestActivity: "Responding",
  transcript: [{ id: "saved", kind: "message", text: "Saved output" }],
});

test("read-only recovery restores only authoritative latest terminal child outcomes", async (t) => {
  t.mock.method(Date, "now", () => 100);
  const agents = ["done", "failed", "stopped", "unfinished", "empty", "active", "unreadable", "archived", "known"].map(savedUnknownChild);
  agents.find((agent) => agent.id === "archived").archived = true;
  agents.find((agent) => agent.id === "known").status = "completed";
  agents.find((agent) => agent.id === "done").latestActivity = "Session disconnected. Last received activity is shown below.";
  const saved = structuredClone(agents);
  const reads = [];
  let starts = 0,
    closes = 0;
  const rpc = {
    start: () => {
      starts++;
    },
    notify: (method) => assert.equal(method, "initialized"),
    close: async () => {
      closes++;
    },
    request: async (method, params) => {
      if (method === "initialize") return {};
      if (method === "thread/read") {
        reads.push(params.threadId);
        if (params.threadId === "unreadable") throw new Error("Read failed");
        return { thread: { id: params.threadId, status: { type: params.threadId === "active" ? "active" : "notLoaded" }, turns: [] } };
      }
      assert.equal(method, "thread/turns/list");
      const status = { done: "completed", failed: "failed", stopped: "interrupted", unfinished: "inProgress", active: "completed" }[params.threadId];
      return { data: status ? [{ id: "latest", status, items: [] }] : [], nextCursor: null };
    },
  };
  const events = await recoverCodexSubagents({ cwd: "/repo", command: "/bin/codex", agents, clientVersion: "test", createRpc: () => rpc });
  assert.deepEqual(
    events.map((event) => [event.type, event.agent.id, event.agent.status]),
    [
      ["subagent-update", "done", "completed"],
      ["subagent-update", "failed", "failed"],
      ["subagent-update", "stopped", "cancelled"],
    ],
  );
  assert.equal(starts, 1);
  assert.equal(closes, 1);
  assert.deepEqual(reads, ["done", "failed", "stopped", "unfinished", "empty", "active", "unreadable"]);
  assert.deepEqual(agents, saved);
  for (const { agent } of events) {
    const previous = saved.find((item) => item.id === agent.id);
    assert.deepEqual(agent.transcript, previous.transcript);
    assert.equal(agent.parentId, "review-parent");
    assert.equal(agent.startedAt, 1);
    assert.equal(agent.endedAt, 9);
    assert.equal(agent.updatedAt, 100);
  }
  assert.equal(events[0].agent.latestActivity, "Finished");
  assert.equal(events[1].agent.latestActivity, "Responding");
});

test("read-only child recovery uses paginated latest turns without replaying old output", async () => {
  let closed = false;
  const calls = [];
  const rpc = {
    start: () => {},
    notify: () => {},
    close: async () => {
      closed = true;
    },
    request: async (method, params) => {
      calls.push(method);
      if (method === "initialize") return {};
      if (method === "thread/read" && params.includeTurns) throw Object.assign(new Error("Use paginated history"), { rpcError: true });
      if (method === "thread/read") return { thread: { id: "child", status: { type: "notLoaded" } } };
      assert.equal(method, "thread/turns/list");
      assert.equal(params.sortDirection, "desc");
      return {
        data: [
          { id: "latest", status: "failed", items: [] },
          { id: "older", status: "completed", items: [] },
        ],
        nextCursor: null,
      };
    },
  };
  const events = await recoverCodexSubagents({ cwd: "/repo", command: "/bin/codex", agents: [savedUnknownChild("child")], createRpc: () => rpc });
  assert.equal(events[0]?.agent.status, "failed");
  assert.deepEqual(calls, ["initialize", "thread/read", "thread/turns/list"]);
  assert.equal(closed, true);
});

test("child recovery closes an unreadable provider and leaves unknown outcomes unchanged", async () => {
  let closes = 0;
  const agents = [savedUnknownChild("child")];
  const rpc = {
    start: () => {},
    notify: () => {},
    close: async () => {
      closes++;
    },
    request: async () => {
      throw new Error("Provider unavailable");
    },
  };
  assert.deepEqual(await recoverCodexSubagents({ cwd: "/repo", command: "/bin/codex", agents, createRpc: () => rpc }), []);
  assert.equal(closes, 1);
  assert.equal(agents[0].status, "unknown");
  let created = false;
  assert.deepEqual(
    await recoverCodexSubagents({
      cwd: "/repo",
      command: "/bin/codex",
      agents: [{ ...agents[0], status: "completed" }],
      createRpc: () => {
        created = true;
        return rpc;
      },
    }),
    [],
  );
  assert.equal(created, false);
});

test("polling always uses paginated child history without requesting a full read", async () => {
  const calls = [];
  const session = new CodexSession({ emit: () => {} });
  session.rpc = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read" && params.includeTurns) throw Object.assign(new Error("Use paginated history"), { rpcError: true });
      if (method === "thread/read") return { thread: { id: "child", status: { type: "active", activeFlags: [] } } };
      return { data: [{ id: "latest", status: "inProgress", items: [] }], nextCursor: null };
    },
  };
  const first = await session.readSubagentThread("child");
  const second = await session.readSubagentThread("child");
  assert.deepEqual(first, second);
  assert.equal(calls.filter((call) => call.params.includeTurns).length, 0);
  assert.equal(calls.length, 4);
});

test("concurrent child refreshes share one read and one output update", async (t) => {
  const events = [];
  const session = new CodexSession({ emit: (event) => events.push(event) });
  t.after(() => session.close());
  session.state.threadId = "parent";
  session.state.subagents = new Map([["child", { id: "child", title: "Review", status: "running", startedAt: 1, updatedAt: 2, transcript: [] }]]);
  const waiting = [];
  session.rpc = {
    close: async () => {},
    request: (method) =>
      method === "thread/read"
        ? new Promise((resolve) => waiting.push(resolve))
        : Promise.resolve({
            data: [{ id: "review", status: "inProgress", items: [{ id: "answer", type: "agentMessage", text: "Reviewing auth" }] }],
            nextCursor: null,
          }),
  };
  const first = session.refreshSubagents();
  const second = session.refreshSubagents();
  const reads = waiting.length;
  for (const resolve of waiting)
    resolve({
      thread: {
        id: "child",
        status: { type: "active", activeFlags: [] },
        turns: [{ id: "review", status: "inProgress", items: [{ id: "answer", type: "agentMessage", text: "Reviewing auth" }] }],
      },
    });
  await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.equal(session.state.subagents.get("child").transcript[0].text, "Reviewing auth");
  assert.equal(events.filter((event) => event.type === "subagent-update" && event.agent.transcript.length).length, 2);
});

test("unknown recovery reads one latest turn without downloading historical items", async () => {
  const calls = [];
  const rpc = {
    start: () => {},
    notify: () => {},
    close: async () => {},
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "initialize") return {};
      if (method === "thread/read")
        return { thread: { id: "child", status: { type: "notLoaded" }, turns: params.includeTurns ? [{ id: "latest", status: "completed", items: [] }] : [] } };
      return { data: [{ id: "latest", status: "completed", items: [] }], nextCursor: "older-turns" };
    },
  };
  const events = await recoverCodexSubagents({ cwd: "/repo", command: "/bin/codex", agents: [savedUnknownChild("child")], createRpc: () => rpc });
  assert.equal(events[0]?.agent.status, "completed");
  const reads = calls.filter((call) => call.method !== "initialize");
  assert.deepEqual(reads, [
    { method: "thread/read", params: { threadId: "child" } },
    { method: "thread/turns/list", params: { threadId: "child", limit: 1, sortDirection: "desc", itemsView: "notLoaded" } },
  ]);
});

test("unknown recovery still supports providers without paginated history", async () => {
  const calls = [];
  const rpc = {
    start: () => {},
    notify: () => {},
    close: async () => {},
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "initialize") return {};
      if (method === "thread/turns/list") throw Object.assign(new Error("Unknown method"), { rpcError: true });
      return { thread: { id: "child", status: { type: "notLoaded" }, turns: params.includeTurns ? [{ id: "latest", status: "interrupted", items: [] }] : [] } };
    },
  };
  const events = await recoverCodexSubagents({ cwd: "/repo", command: "/bin/codex", agents: [savedUnknownChild("child")], createRpc: () => rpc });
  assert.equal(events[0]?.agent.status, "cancelled");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["initialize", "thread/read", "thread/turns/list", "thread/read"],
  );
});

test("Codex tool image blocks become visible image steps, including dynamic tool output", async (t) => {
  const events = [];
  const session = new CodexSession({ emit: (event) => events.push(event) });
  session.state.threadId = "parent";
  t.after(() => session.close());
  const data = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("tool image")]).toString("base64");
  for (const type of ["mcpToolCall", "dynamicToolCall"]) {
    const content = [{ type: "image", data, mimeType: "image/png" }];
    session.handleNotification("item/completed", {
      threadId: "parent",
      item: { id: type, type, tool: "screenshot", status: "completed", result: { content }, contentItems: content },
    });
  }
  const images = events.filter((event) => event.type === "step-completed" && event.file);
  assert.equal(images.length, 2);
  assert.deepEqual(fs.readFileSync(images[0].file), Buffer.from(data, "base64"));
  assert.ok(events.some((event) => event.type === "step-started" && event.step.kind === "image"));
});

test("internal design renders and HTML previews stay out of image steps, including nested exec calls", async (t) => {
  const events = [];
  const session = new CodexSession({ emit: (event) => events.push(event) });
  session.state.threadId = "parent";
  t.after(() => session.close());
  const data = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("design render")]).toString("base64");
  const content = [{ type: "image", data, mimeType: "image/png" }];
  const complete = (id, server, tool) =>
    session.handleNotification("item/completed", {
      threadId: "parent",
      item: { id, type: "mcpToolCall", server, tool, status: "completed", result: { content } },
    });
  complete("show", "milagre", "design_show");
  complete("apply", "milagre", "design_apply");
  complete("preview", "milagre", "html_preview");
  // A real functions.exec call surfaces its nested tool with MCP provenance, not as a generic dynamic image.
  complete("exec-a750cdfe-7781-4832-a7f7-bc4ad1d2e7fb", "milagre", "html_preview");
  assert.equal(events.filter((event) => event.step?.kind === "image").length, 0);
  assert.ok(events.some((event) => event.type === "step-completed" && event.id === "preview" && event.status === "done"));
  assert.deepEqual(content, [{ type: "image", data, mimeType: "image/png" }], "the model's original preview result is untouched");
  complete("other", "browser", "design_show");
  complete("other-preview", "browser", "html_preview");
  complete("shot", "milagre", "screenshot");
  assert.equal(events.filter((event) => event.step?.kind === "image").length, 3);
});

test("Everywhere servers and the off list reach thread config", async (t) => {
  const { session, events, requests } = codex(t, {
    mcpExtras: async () => ({ servers: [{ name: "linear", type: "http", url: "https://x", headers: {} }], off: ["figma"] }),
  });
  await session.startTurn(TURN);
  await ended(events);
  const config = requests.find((r) => r.method === "thread/start").params.config;
  assert.deepEqual(config.mcp_servers.linear, { url: "https://x" });
  assert.deepEqual(config.mcp_servers.figma, { enabled: false });
});

test("a failing mcpExtras still starts the Codex thread and is logged once", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const { session, events, requests } = codex(t, {
    mcpExtras: async () => {
      throw new Error("boom");
    },
  });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(requests.find((r) => r.method === "thread/start").params.config, { features: { default_mode_request_user_input: true } });
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments.join(" ")), /boom/);
});

test("a Codex that refuses Everywhere servers keeps the off entries and milagre on the retry", async (t) => {
  const reported = [];
  const linked = { tools: [], url: async () => "http://127.0.0.1:1234/mcp/abc", toolsAvailable: (available) => reported.push(available) };
  const { session, events, requests } = codex(t, {
    scenario: "reject-extra-mcp",
    linked,
    mcpExtras: async () => ({ servers: [{ name: "linear", type: "http", url: "https://x", headers: {} }], off: ["figma"] }),
  });
  await session.startTurn(TURN);
  await ended(events);
  const attempts = requests.filter((r) => r.method === "thread/start").map((r) => r.params.config.mcp_servers);
  assert.deepEqual(Object.keys(attempts[0]).sort(), ["figma", "linear", "milagre"]);
  assert.deepEqual(attempts.at(-1), { figma: { enabled: false }, milagre: { url: "http://127.0.0.1:1234/mcp/abc", tool_timeout_sec: 86400 } });
  assert.deepEqual(reported, [true]);
  assert.deepEqual(events.at(-1), { type: "turn-completed" });
});
