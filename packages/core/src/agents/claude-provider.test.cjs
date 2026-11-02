const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ClaudeSession } = require("./claude-provider.cjs");
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
const { DISMISSED_MESSAGE, UNSHOWN_MESSAGE } = require("./questions.cjs");
const { waitUntil } = require("./test-helpers.cjs");

const TURN = { prompt: "Hi", images: [], model: "claude-opus-5-5", permissionMode: "auto" };
const init = { type: "system", subtype: "init", session_id: "session-1" };
const delta = (text) => ({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const success = { type: "result", subtype: "success", is_error: false, result: "Hello" };
const notificationResult = { type: "result", subtype: "success", is_error: false, num_turns: 0, result: "" };

const COLOR_QUESTION = {
  questions: [
    {
      question: "Which color?",
      header: "Color",
      options: [
        { label: "Red", description: "Warm" },
        { label: "Green", description: "Calm" },
      ],
      multiSelect: false,
    },
  ],
};

const scripts = {
  async *absorbs({ next }) {
    yield init;
    const steer = await next();
    yield delta(`steered:${steer.message.content[0].text}`);
    yield success;
  },
  async *held({ released }) {
    yield init;
    await released;
    yield delta("Done");
    yield success;
  },
  async *reply() {
    yield init;
    yield delta("Hel");
    yield delta("lo");
    yield success;
  },
  // On resume, Claude Code records a stale task notification as a turn of its own before it reads the message.
  async *notified({ next }) {
    yield init;
    yield notificationResult;
    yield init;
    yield delta("Hello");
    yield success;
    await next();
  },
  async *interruptible({ interrupted }) {
    yield init;
    await interrupted;
    yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request was aborted."] };
  },
  async *unresponsive() {
    yield init;
    await new Promise(() => {});
  },
  async *crash() {
    yield init;
    throw new Error("Claude Code process exited with code 1");
  },
  // oxlint-disable-next-line require-yield -- async generator stub that throws or never settles on purpose to simulate a failing or idle stream
  async *missing() {
    throw new Error("No conversation found with session ID: gone");
  },
  async *asks({ options, signal }) {
    yield init;
    const result = await options.canUseTool(
      "Write",
      { file_path: "/repo/hello.txt", content: "hi" },
      {
        signal,
        requestId: "req-1",
        toolUseID: "tool-1",
        suggestions: [{ type: "addRules", rules: [{ toolName: "Write" }], behavior: "allow", destination: "localSettings" }],
      },
    );
    yield delta(JSON.stringify(result));
    yield success;
  },
  async *sdkAbortsPending({ options }) {
    yield init;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const result = await options.canUseTool(
      "Write",
      { file_path: "/repo/hello.txt", content: "hi" },
      {
        signal: controller.signal,
        requestId: "req-2",
        toolUseID: "tool-2",
      },
    );
    yield delta(JSON.stringify(result));
    yield success;
  },
  async *questions({ options, signal }) {
    yield init;
    const result = await options.canUseTool("AskUserQuestion", COLOR_QUESTION, {
      signal,
      requestId: "q-1",
      toolUseID: "tool-q",
      displayName: "AskUserQuestion",
      requiresUserInteraction: true,
    });
    yield delta(JSON.stringify(result));
    yield success;
  },
  async *questionThenSteer({ options, signal, next }) {
    yield init;
    const result = await options.canUseTool("AskUserQuestion", COLOR_QUESTION, { signal, requestId: "q-1", toolUseID: "tool-q" });
    const steer = await next();
    yield delta(`${JSON.stringify(result)}|${steer.message.content[0].text}`);
    yield success;
  },
  // Claude Code sends the finished tool_use block, then asks, then sends the tool's result.
  async *runsTools({ options, signal }) {
    yield init;
    yield delta("Checking.");
    yield {
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } }] },
    };
    const answer = await options.canUseTool("Bash", { command: "npm test" }, { signal, requestId: "req-1", toolUseID: "tool-1" });
    const allowed = answer.behavior === "allow";
    yield {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: allowed ? "ok" : answer.message, is_error: !allowed }] },
      tool_use_result: allowed ? { stdout: "ok", stderr: "" } : `Error: ${answer.message}`,
    };
    yield delta("All green.");
    yield success;
  },
  // A tool call that never gets its result before the turn ends.
  async *toolWithoutResult() {
    yield init;
    yield {
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "tool-9", name: "Bash", input: { command: "sleep 9" } }] },
    };
    yield success;
  },
  // Claude Code runs the PreToolUse hook, then asks canUseTool with the tool's display name.
  async *sendsMessage({ options, signal }) {
    yield init;
    const input = { channel: "#ops", text: "Merged." };
    await options.hooks.PreToolUse[0].hooks[0](
      { hook_event_name: "PreToolUse", tool_name: "mcp__slack__send_message", tool_input: input, tool_use_id: "tool-m" },
      "tool-m",
      {
        signal,
      },
    );
    const result = await options.canUseTool("mcp__slack__send_message", input, {
      signal,
      requestId: "req-m",
      toolUseID: "tool-m",
      displayName: "Send Message",
    });
    yield delta(JSON.stringify(result));
    yield success;
  },
  async *sdkAbortsAlready({ options }) {
    yield init;
    const controller = new AbortController();
    controller.abort();
    const result = await options.canUseTool(
      "Write",
      { file_path: "/repo/hello.txt", content: "hi" },
      {
        signal: controller.signal,
        requestId: "req-3",
        toolUseID: "tool-3",
      },
    );
    yield delta(JSON.stringify(result));
    yield success;
  },
};

// Stands in for the SDK's query(): consumes the streaming prompt and plays a script per message.
// Scripts get the query options (for canUseTool), an abort signal that interrupt() trips, a gate
// the test opens with calls.release(), and next() to read a message sent while they run.
function fakeSdk(script) {
  const calls = { order: [], options: null, queries: 0, prompts: [], models: [], modes: [], thinking: [], flags: [], interrupts: 0, release: () => {} };
  const query = ({ prompt, options }) => {
    calls.queries += 1;
    calls.options = options;
    let markInterrupted;
    const interrupted = new Promise((resolve) => {
      markInterrupted = resolve;
    });
    const released = new Promise((resolve) => {
      calls.release = resolve;
    });
    const controller = new AbortController();
    const messages = prompt[Symbol.asyncIterator]();
    const next = async () => {
      const { value } = await messages.next();
      if (value) {
        calls.prompts.push(value);
        calls.order.push("message");
      }
      return value;
    };
    async function* run() {
      while (await next()) yield* script({ interrupted, released, options, signal: controller.signal, next });
    }
    return Object.assign(run(), {
      interrupt: async () => {
        calls.interrupts += 1;
        controller.abort();
        markInterrupted();
      },
      setModel: async (model) => {
        calls.models.push(model);
      },
      setPermissionMode: async (mode) => {
        calls.modes.push(mode);
      },
      applyFlagSettings: async (settings) => {
        calls.flags.push(settings);
      },
      setMaxThinkingTokens: async (...args) => {
        calls.thinking.push(args);
      },
      toggleMcpServer: async (name, enabled) => {
        (calls.toggles ??= []).push([name, enabled]);
        calls.order.push(`toggle:${name}`);
      },
      getTaskOutput: async (taskId) => {
        if (taskId !== "b1") throw new Error("get_task_output: no shell or Monitor task with that task_id in this session");
        return { output: "building…\n", total_bytes: 9000, truncated: true };
      },
    });
  };
  return { calls, loadSdk: async () => ({ query }) };
}

function claude(
  t,
  {
    script = scripts.reply,
    resumeId,
    tldrEnabled,
    analysisOnly,
    executionAdvisor,
    env = process.env,
    defaultConfigDir = "/missing-claude-settings",
    command = "/usr/local/bin/claude",
    interruptGraceMs,
    permissionPolicy,
  } = {},
) {
  const sdk = fakeSdk(script);
  const events = [];
  const session = new ClaudeSession({
    cwd: "/repo",
    resumeId,
    tldrEnabled,
    analysisOnly,
    executionAdvisor,
    env,
    defaultConfigDir,
    command,
    emit: (event) => events.push(event),
    loadSdk: sdk.loadSdk,
    interruptGraceMs,
    permissionPolicy,
  });
  t.after(() => session.close());
  return { session, events, calls: sdk.calls };
}
const ended = (events, count = 1) => waitUntil(() => events.filter(isTerminal).length >= count);

test("analysis-only Claude denies shell tools and cannot switch to Full", async (t) => {
  const { session, events, calls } = claude(t, { analysisOnly: true, script: scripts.runsTools });
  await session.startTurn({ ...TURN, permissionMode: "full" });
  await ended(events);
  assert.equal(calls.options.permissionMode, "dontAsk");
  // An advisor's own short prompt, not the Chat's (events.cjs advisorInstructions).
  assert.equal(calls.options.systemPrompt.append, advisorInstructions());
  assert.deepEqual(calls.options.tools, []);
  assert.deepEqual(calls.options.settingSources, []);
  assert.equal(calls.options.strictMcpConfig, true);
  assert.equal(
    events.some((event) => event.type === "permission-request"),
    false,
  );
  const denied = events.find((event) => event.type === "step-completed" && event.id === "tool-1");
  assert.equal(denied.status, "failed");
  assert.match(denied.detail, /analysis-only/);
  await session.setPermissionMode("full");
  await session.startTurn({ ...TURN, permissionMode: "full" });
  await ended(events, 2);
  assert.equal(calls.modes.includes("bypassPermissions"), false);
});
test("execution Claude has native tools and reports questions to its parent", async (t) => {
  const { session, events, calls } = claude(t, { executionAdvisor: true, script: scripts.questions });
  await session.startTurn({ ...TURN, permissionMode: "full" });
  await ended(events);
  assert.equal(calls.options.permissionMode, "bypassPermissions");
  assert.notDeepEqual(calls.options.tools, []);
  assert.ok(calls.options.disallowedTools.includes("AskUserQuestion"));
  assert.ok(calls.options.disallowedTools.includes("Agent"));
  assert.match(calls.options.systemPrompt.append, /execution agent/);
  assert.ok(!events.some((event) => event.type === "question-request"));
  assert.match(
    events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join(""),
    /parent Chat/,
  );
});

test("reads the end of a background command's output from Claude Code, until the session closes", async (t) => {
  const { session, events } = claude(t);
  await assert.rejects(session.taskOutput("b1"), /That background task has ended/);
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(await session.taskOutput("b1"), { output: "building…\n", totalBytes: 9000, truncated: true });
  await assert.rejects(session.taskOutput("other"), /no shell or Monitor task/);
  await session.close();
  await assert.rejects(session.taskOutput("b1"), /That background task has ended/);
});

test("turns on Claude Code's task tools, which headless runs hide", async (t) => {
  const { session, events, calls } = claude(t);
  await session.startTurn(TURN);
  await ended(events);
  assert.equal(calls.options.env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1");
  assert.equal(calls.options.env.PATH, process.env.PATH);
});

test("starts with Milagre's options and streams a reply", async (t) => {
  const { session, events, calls } = claude(t);
  await session.startTurn(TURN);
  await ended(events);

  assert.deepEqual(
    events.map((event) => event.type),
    ["turn-started", "session-started", "text-delta", "text-delta", "turn-completed"],
  );
  assert.equal(events[1].nativeId, "session-1");
  assert.equal(
    events
      .filter((event) => event.type === "text-delta")
      .map((event) => event.text)
      .join(""),
    "Hello",
  );
  assert.equal(calls.options.cwd, "/repo");
  assert.equal(calls.options.model, "claude-opus-5-5");
  assert.equal(calls.options.permissionMode, "acceptEdits");
  assert.equal(calls.options.includePartialMessages, true);
  assert.deepEqual(calls.options.settings, { fastMode: false });
  assert.deepEqual(calls.thinking, [[null, "summarized"]]);
  assert.equal(calls.options.allowDangerouslySkipPermissions, true);
  assert.equal(calls.options.pathToClaudeCodeExecutable, "/usr/local/bin/claude");
  assert.deepEqual(calls.options.settingSources, ["user", "project", "local"]);
  assert.deepEqual(calls.options.systemPrompt, { type: "preset", preset: "claude_code", append: MILAGRE_INSTRUCTIONS });
  assert.equal("resume" in calls.options, false);
  assert.deepEqual(calls.prompts[0].message.content, [{ type: "text", text: "Hi" }]);
  assert.equal(typeof calls.options.canUseTool, "function");
  assert.equal("disallowedTools" in calls.options, false);
});

test("keeps one query across turns and applies model and mode changes", async (t) => {
  const { session, events, calls } = claude(t);
  await session.startTurn(TURN);
  await ended(events);
  await session.startTurn({ ...TURN, model: "claude-sonnet-5-5", permissionMode: "full" });
  await ended(events, 2);

  assert.equal(calls.queries, 1);
  assert.deepEqual(calls.models, ["claude-sonnet-5-5"]);
  assert.deepEqual(calls.modes, ["bypassPermissions"]);
  assert.equal(events.filter((event) => event.type === "session-started").length, 1);
});

test("fast mode starts on and can be turned off in the same Claude session", async (t) => {
  const { session, events, calls } = claude(t);
  await session.startTurn({ ...TURN, fastMode: true });
  await ended(events);
  assert.deepEqual(calls.options.settings, { fastMode: true });

  await session.startTurn({ ...TURN, fastMode: false });
  await ended(events, 2);
  assert.equal(calls.queries, 1);
  assert.deepEqual(calls.flags, [{ fastMode: false }]);
});

test("Concise replies apply Claude Code's Concise output style before the first message, and Milagre's own prompt is unchanged", async (t) => {
  const { session, events, calls } = claude(t);
  await session.startTurn({ ...TURN, replies: "concise" });
  await ended(events);
  assert.deepEqual(calls.options.settings, { fastMode: false });
  assert.deepEqual(calls.options.systemPrompt, { type: "preset", preset: "claude_code", append: MILAGRE_INSTRUCTIONS });
  assert.deepEqual(calls.flags, [{ outputStyle: "Concise" }]);
});

test("Normal replies leave the output style alone", async (t) => {
  const { session, events, calls } = claude(t);
  await session.startTurn({ ...TURN, replies: "normal" });
  await ended(events);
  assert.deepEqual(calls.options.settings, { fastMode: false });
  assert.deepEqual(calls.flags, []);
});

test("Concise keeps ultracode in the query's settings", async (t) => {
  const { session, events, calls } = claude(t);
  await session.startTurn({ ...TURN, replies: "concise", ultracode: true });
  await ended(events);
  assert.deepEqual(calls.options.settings, { fastMode: false, ultracode: true });
  assert.deepEqual(calls.flags, [{ outputStyle: "Concise" }]);
});

test("switching replies mid-chat applies and clears the style on the running query", async (t) => {
  const { session, events, calls } = claude(t);
  await session.startTurn({ ...TURN, replies: "normal" });
  await ended(events);
  await session.startTurn({ ...TURN, replies: "concise" });
  await ended(events, 2);
  assert.equal(calls.queries, 1);
  assert.deepEqual(calls.flags, [{ outputStyle: "Concise" }]);

  await session.startTurn({ ...TURN, replies: "concise" });
  await ended(events, 3);
  assert.equal(calls.flags.length, 1);

  // null restores whatever style the user's own Claude settings give, instead of forcing "default".
  await session.startTurn({ ...TURN, replies: "normal" });
  await ended(events, 4);
  assert.deepEqual(calls.flags, [{ outputStyle: "Concise" }, { outputStyle: null }]);
});

test("a resumed chat gets the style before its first message", async (t) => {
  const { session, events, calls } = claude(t, { resumeId: "session-1" });
  await session.startTurn({ ...TURN, replies: "concise" });
  await ended(events);
  assert.deepEqual(calls.flags, [{ outputStyle: "Concise" }]);
  assert.equal(calls.options.resume, "session-1");
});

test("a CLI that rejects the style still runs the turn, and the style is not retried", async (t) => {
  const { session, events, calls } = claude(t);
  const original = calls;
  const sdkQuery = session.loadSdk;
  session.loadSdk = async () => {
    const { query } = await sdkQuery();
    return {
      query: (args) =>
        Object.assign(query(args), {
          applyFlagSettings: async (settings) => {
            original.flags.push(settings);
            if ("outputStyle" in settings) throw new Error("Unknown output style: Concise");
          },
        }),
    };
  };
  await session.startTurn({ ...TURN, replies: "concise" });
  await ended(events);
  assert.equal(events.at(-1).type, "turn-completed");
  assert.equal(
    events.some((event) => event.type === "turn-failed"),
    false,
  );
  await session.startTurn({ ...TURN, replies: "concise" });
  await ended(events, 2);
  assert.equal(events.at(-1).type, "turn-completed");
  assert.deepEqual(calls.flags, [{ outputStyle: "Concise" }]);
});

test("sends images as base64 content blocks and interleaves [Image #N] tokens in reading order", async (t) => {
  const { session, events, calls } = claude(t);
  await session.startTurn({
    ...TURN,
    prompt: "Compare [Image #2] with [Image #1] here",
    images: [
      { mime: "image/png", base64: "img1" },
      { mime: "image/jpeg", base64: "img2" },
    ],
  });
  await ended(events);
  assert.deepEqual(calls.prompts[0].message.content, [
    { type: "text", text: "Compare " },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "img2" } },
    { type: "text", text: " with " },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "img1" } },
    { type: "text", text: " here" },
  ]);
});

test("resumes a saved session without announcing it again", async (t) => {
  const { session, events, calls } = claude(t, { resumeId: "session-1" });
  await session.startTurn(TURN);
  await ended(events);
  assert.equal(calls.options.resume, "session-1");
  assert.equal(
    events.some((event) => event.type === "session-started"),
    false,
  );
});

test("forgets a session that can't be resumed", async (t) => {
  const { session, events } = claude(t, { script: scripts.missing, resumeId: "gone" });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(events.slice(1), [{ type: "session-reset" }, failedWith(RESUME_FAILED_MESSAGE)]);
  assert.equal(events[0].type, "turn-started");
  assert.equal(session.closed, true);
});

test("interrupts a running turn", async (t) => {
  const { session, events, calls } = claude(t, { script: scripts.interruptible });
  await session.startTurn(TURN);
  await waitUntil(() => events.length > 0);
  await session.interrupt();
  await ended(events);
  assert.equal(calls.interrupts, 1);
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
});

test("gives up on an interrupt Claude never answers", async (t) => {
  const { session, events } = claude(t, { script: scripts.unresponsive, interruptGraceMs: 50 });
  await session.startTurn(TURN);
  await waitUntil(() => events.length > 0);
  await session.interrupt();
  await ended(events);
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
});

test("reports a crash mid-turn", async (t) => {
  const { session, events } = claude(t, { script: scripts.crash });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(events.at(-1), failedWith(crashMessage("claude", "Claude Code process exited with code 1")));
  assert.equal(session.closed, true);
});

test("a logged-out Claude fails the turn with the login message", async (t) => {
  // Recorded from Claude Code 2.1.287 with an empty CLAUDE_CONFIG_DIR.
  const script = async function* () {
    yield init;
    yield {
      type: "assistant",
      error: "authentication_failed",
      parent_tool_use_id: null,
      message: { model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] },
    };
    yield { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" };
  };
  const { session, events } = claude(t, { script });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(events.at(-1), failedWith(loginMessage("claude"), { login: true }));
  assert.equal(
    events.some((event) => event.type === "text-delta"),
    false,
  );
});

test("explains a missing CLI without starting anything", async (t) => {
  const { session, events, calls } = claude(t, { command: null });
  await session.startTurn(TURN);
  assert.deepEqual(events, [failedWith(missingCliMessage("claude"))]);
  assert.equal(calls.queries, 0);
});

test("keeps the saved session when a resumed start fails for another reason", async (t) => {
  // oxlint-disable-next-line require-yield -- async generator stub that throws or never settles on purpose to simulate a failing or idle stream
  const script = async function* () {
    throw new Error("spawn EACCES");
  };
  const { session, events } = claude(t, { script, resumeId: "session-1" });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(events.slice(1), [failedWith(crashMessage("claude", "spawn EACCES"))]);
});

test("cancels a turn interrupted while the SDK is still loading", async (t) => {
  const sdk = fakeSdk(scripts.reply);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const events = [];
  const session = new ClaudeSession({
    cwd: "/repo",
    command: "/usr/local/bin/claude",
    emit: (event) => events.push(event),
    loadSdk: async () => {
      await gate;
      return sdk.loadSdk();
    },
  });
  t.after(() => session.close());
  const turn = session.startTurn(TURN);
  await session.interrupt();
  release();
  await turn;
  await ended(events);
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
  assert.deepEqual(sdk.calls.prompts, []);
});

test("a continuation cancelled during Claude SDK initialization submits no prompt", async (t) => {
  const sdk = fakeSdk(scripts.reply);
  let release;
  let allowed = true;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const events = [];
  const session = new ClaudeSession({
    cwd: "/repo",
    command: "/usr/local/bin/claude",
    emit: (event) => events.push(event),
    loadSdk: async () => {
      await gate;
      return sdk.loadSdk();
    },
  });
  t.after(() => session.close());
  const turn = session.startTurn({ ...TURN, canStart: () => allowed });
  allowed = false;
  release();
  assert.equal((await turn).cancelled, true);
  assert.equal(
    events.some((event) => event.type === "turn-cancelled"),
    false,
  );
  assert.deepEqual(sdk.calls.prompts, []);
});

test("close() ends a running turn even when Claude never answers", async (t) => {
  const { session, events } = claude(t, { script: scripts.unresponsive });
  await session.startTurn(TURN);
  await waitUntil(() => events.length > 0);
  await session.close();
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
});

test("refuses new turns once closed", async (t) => {
  const { session } = claude(t);
  await session.close();
  await assert.rejects(session.startTurn(TURN), /closed/);
});

const asked = (events) => waitUntil(() => events.some((event) => event.type === "permission-request"));
const replyText = (events) =>
  events
    .filter((event) => event.type === "text-delta")
    .map((event) => event.text)
    .join("");

test("Ask mode lets Claude Code check with the user", async (t) => {
  const { session, events, calls } = claude(t);
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await ended(events);
  assert.equal(calls.options.permissionMode, "default");
});

test("bot mode runs Claude in default mode", async (t) => {
  const { session, events, calls } = claude(t);
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await ended(events);
  assert.equal(calls.options.permissionMode, "default");
});

test("asks before a tool runs and passes the answer back", async (t) => {
  const { session, events } = claude(t, { script: scripts.asks });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  assert.deepEqual(
    events.find((event) => event.type === "permission-request"),
    {
      type: "permission-request",
      requestId: "req-1",
      kind: "edit",
      tool: "Write",
      title: "Write hello.txt?",
      files: ["/repo/hello.txt"],
      diff: "+hi",
      allowForChat: true,
      stepId: "tool-1",
    },
  );
  assert.equal(session.respondToPermission("req-1", "allow"), true);
  await ended(events);
  assert.deepEqual(JSON.parse(replyText(events)), { behavior: "allow", updatedInput: { file_path: "/repo/hello.txt", content: "hi" } });
  const types = events.map((event) => event.type);
  assert.ok(types.indexOf("permission-resolved") < types.indexOf("turn-completed"));
  assert.deepEqual(
    events.find((event) => event.type === "permission-resolved"),
    { type: "permission-resolved", requestId: "req-1", decision: "allow" },
  );
});

test("canUseTool in bot mode resolves allow when the policy allows", async (t) => {
  const seen = [];
  const { session, events } = claude(t, {
    script: scripts.asks,
    permissionPolicy: (request) => {
      seen.push(request);
      return "allow";
    },
  });
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await ended(events);
  const answer = JSON.parse(replyText(events));
  assert.equal(answer.behavior, "allow");
  assert.equal(seen[0].tool, "Write");
  assert.equal(
    events.some((event) => event.type === "permission-request"),
    false,
  );
});

test("canUseTool in bot mode shows a gate card when the policy gates", async (t) => {
  const gate = { kind: "delete", title: "Delete: hello.txt" };
  const { session, events } = claude(t, { script: scripts.asks, permissionPolicy: () => ({ gate }) });
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await asked(events);
  assert.deepEqual(events.find((event) => event.type === "permission-request").gate, gate);
  session.respondToPermission("req-1", "deny");
  await ended(events);
  assert.equal(JSON.parse(replyText(events)).behavior, "deny");
});

test("switching to Full mid-turn reaches Claude Code and approves the waiting card", async (t) => {
  const { session, events, calls } = claude(t, { script: scripts.asks });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  await session.setPermissionMode("full");
  await ended(events);
  assert.deepEqual(calls.modes, ["bypassPermissions"]);
  assert.deepEqual(JSON.parse(replyText(events)), { behavior: "allow", updatedInput: { file_path: "/repo/hello.txt", content: "hi" } });
  assert.deepEqual(
    events.find((event) => event.type === "permission-resolved"),
    { type: "permission-resolved", requestId: "req-1", decision: "allow" },
  );
  // The next turn already runs in Full; nothing is set again.
  await session.startTurn({ ...TURN, permissionMode: "full" });
  await ended(events, 2);
  assert.deepEqual(calls.modes, ["bypassPermissions"]);
});

test("switching to Auto mid-turn approves a waiting edit", async (t) => {
  const { session, events, calls } = claude(t, { script: scripts.asks });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  await session.setPermissionMode("auto");
  await ended(events);
  assert.deepEqual(calls.modes, ["acceptEdits"]);
  assert.equal(JSON.parse(replyText(events)).behavior, "allow");
});

test("a steer carries the mode it was sent with", async (t) => {
  const { session, events, calls } = claude(t, { script: scripts.absorbs });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await session.startTurn({ ...TURN, prompt: "go on", permissionMode: "full" });
  await ended(events);
  assert.deepEqual(calls.modes, ["bypassPermissions"]);
});

test("always allowing in this chat keeps the rule in the session", async (t) => {
  const { session, events } = claude(t, { script: scripts.asks });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  session.respondToPermission("req-1", "allow-for-chat");
  await ended(events);
  assert.deepEqual(JSON.parse(replyText(events)).updatedPermissions, [
    { type: "addRules", rules: [{ toolName: "Write" }], behavior: "allow", destination: "session" },
  ]);
});

test("denying tells Claude it was denied in Milagre", async (t) => {
  const { session, events } = claude(t, { script: scripts.asks });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  session.respondToPermission("req-1", "deny");
  await ended(events);
  assert.deepEqual(JSON.parse(replyText(events)), { behavior: "deny", message: "Denied in Milagre" });
});

test("interrupting cancels a pending approval", async (t) => {
  const { session, events } = claude(t, { script: scripts.asks });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  await session.interrupt();
  await ended(events);
  assert.deepEqual(
    events.find((event) => event.type === "permission-resolved"),
    { type: "permission-resolved", requestId: "req-1", decision: "cancelled" },
  );
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
  assert.equal(session.respondToPermission("req-1", "allow"), false);
});

test("closing cancels a pending approval", async (t) => {
  const { session, events } = claude(t, { script: scripts.asks });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  await session.close();
  assert.ok(events.some((event) => event.type === "permission-resolved" && event.decision === "cancelled"));
  // The script may still flush its last text while the query closes, so check the ending, not the order.
  assert.deepEqual(events.filter(isTerminal), [{ type: "turn-cancelled" }]);
});

test("a tool call shows as a step before its approval, and ends with its result", async (t) => {
  const { session, events } = claude(t, { script: scripts.runsTools });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  const request = events.find((event) => event.type === "permission-request");
  const started = events.find((event) => event.type === "step-started");
  assert.deepEqual(started, { type: "step-started", step: { id: "tool-1", kind: "shell", title: "Ran `npm test`", detail: "$ npm test\n" } });
  assert.equal(request.stepId, started.step.id);
  assert.ok(events.indexOf(started) < events.indexOf(request));
  session.respondToPermission("req-1", "allow");
  await ended(events);
  assert.deepEqual(
    events.filter((event) => event.type !== "permission-request").map((event) => event.type),
    ["turn-started", "session-started", "text-delta", "step-started", "permission-resolved", "step-completed", "text-delta", "turn-completed"],
  );
  assert.deepEqual(
    events.find((event) => event.type === "step-completed"),
    { type: "step-completed", id: "tool-1", status: "done", detail: "$ npm test\nok" },
  );
});

test("a denied tool call ends as a failed step", async (t) => {
  const { session, events } = claude(t, { script: scripts.runsTools });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  session.respondToPermission("req-1", "deny");
  await ended(events);
  assert.deepEqual(
    events.find((event) => event.type === "step-completed"),
    { type: "step-completed", id: "tool-1", status: "failed", detail: "$ npm test\nDenied in Milagre" },
  );
});

test("tool calls still waiting for a result are forgotten when the turn ends", async (t) => {
  const { session, events } = claude(t, { script: scripts.toolWithoutResult });
  await session.startTurn(TURN);
  await ended(events);
  assert.equal(session.state.tools.size, 0);
});

test("an answer for an unknown request changes nothing", async (t) => {
  const { session } = claude(t);
  assert.equal(session.respondToPermission("nope", "allow"), false);
});

test("the SDK can abort a pending approval", async (t) => {
  const { session, events } = claude(t, { script: scripts.sdkAbortsPending });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  // Wait for the abort to fire and resolve the request
  await waitUntil(() => events.some((event) => event.type === "permission-resolved" && event.decision === "cancelled"));
  // The turn should end normally with turn-completed since the SDK aborted, not the session
  await ended(events);
  assert.deepEqual(JSON.parse(replyText(events)), { behavior: "deny", message: "The turn was cancelled in Milagre.", interrupt: true });
  assert.deepEqual(events.at(-1), { type: "turn-completed" });
});

test("canUseTool works when the signal is already aborted", async (t) => {
  const { session, events } = claude(t, { script: scripts.sdkAbortsAlready });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await asked(events);
  // The request should be immediately resolved as cancelled
  await waitUntil(() => events.some((event) => event.type === "permission-resolved" && event.decision === "cancelled"));
  await ended(events);
  assert.deepEqual(JSON.parse(replyText(events)), { behavior: "deny", message: "The turn was cancelled in Milagre.", interrupt: true });
  // respondToPermission should return false since the request is already resolved
  assert.equal(session.respondToPermission("req-3", "allow"), false);
});

test("steers a running turn", async (t) => {
  const { session, events, calls } = claude(t, { script: scripts.absorbs });
  const first = await session.startTurn(TURN);
  const second = await session.startTurn({ ...TURN, prompt: "Also add tests" });
  await ended(events);
  assert.equal(first.steered, false);
  assert.deepEqual(second, { turnId: first.turnId, steered: true });
  assert.equal(calls.prompts.length, 2);
  assert.ok(events.some((event) => event.type === "text-delta" && event.text === "steered:Also add tests"));
  assert.equal(events.filter(isTerminal).length, 1);
});

test("a steer that arrives as the turn ends becomes a turn of its own", async (t) => {
  const { session, events, calls } = claude(t, { script: scripts.held });
  const first = await session.startTurn(TURN);
  const second = await session.startTurn({ ...TURN, prompt: "One more thing" });
  calls.release();
  await ended(events, 2);
  assert.equal(second.steered, true);
  const started = events.filter((event) => event.type === "turn-started");
  assert.equal(started.length, 2);
  assert.equal(started[0].turnId, first.turnId);
  assert.notEqual(started[1].turnId, first.turnId);
  assert.equal(session.turnActive, false);
  assert.equal(calls.prompts.length, 2);
});

test("a turn that only records a task notification doesn't end the user's turn", async (t) => {
  const { session, events, calls } = claude(t, { script: scripts.notified });
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(
    events.map((event) => event.type),
    ["turn-started", "session-started", "text-delta", "turn-completed"],
  );
  assert.equal(calls.prompts[0].uuid.length, 36);
});

test("a task notification recorded while no turn runs starts no turn", async (t) => {
  const { session, events } = claude(t, {
    script: async function* ({ next }) {
      yield init;
      yield delta("Hello");
      yield success;
      yield init;
      yield notificationResult;
      await next();
    },
  });
  await session.startTurn(TURN);
  await ended(events);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.filter((event) => event.type === "turn-started").length, 1);
  assert.equal(events.filter(isTerminal).length, 1);
  assert.equal(session.turnActive, false);
});

test("a steer sent while the SDK is still loading waits for the turn", async (t) => {
  const { session, events, calls } = claude(t, { script: scripts.absorbs });
  const first = session.startTurn(TURN);
  const second = session.startTurn({ ...TURN, prompt: "Also add tests" });
  assert.equal((await second).steered, true);
  await first;
  await ended(events);
  assert.deepEqual(
    calls.prompts.map((prompt) => prompt.message.content[0].text),
    ["Hi", "Also add tests"],
  );
});

test("a message sent while a turn is stopping starts the next turn", async (t) => {
  let runs = 0;
  const script = async function* ({ interrupted, released }) {
    runs += 1;
    yield init;
    if (runs === 1) {
      await interrupted;
      await released;
      yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request was aborted."] };
      return;
    }
    yield delta("second");
    yield success;
  };
  const { session, events, calls } = claude(t, { script });
  const first = await session.startTurn(TURN);
  await waitUntil(() => events.length > 0);
  const release = calls.release;
  await session.interrupt();
  const pending = session.startTurn({ ...TURN, prompt: "Next" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.prompts.length, 1);
  release();
  const second = await pending;
  await ended(events, 2);

  assert.equal(second.steered, false);
  assert.notEqual(second.turnId, first.turnId);
  assert.deepEqual(events.filter(isTerminal), [{ type: "turn-cancelled" }, { type: "turn-completed" }]);
  const types = events.map((event) => event.type);
  assert.ok(types.indexOf("turn-cancelled") < types.lastIndexOf("turn-started"));
  assert.deepEqual(
    calls.prompts.map((prompt) => prompt.message.content[0].text),
    ["Hi", "Next"],
  );
});

test("a message sent while Stop closes the session is handed back as sessionClosed", async (t) => {
  const { session, events } = claude(t, { script: scripts.unresponsive, interruptGraceMs: 50 });
  await session.startTurn(TURN);
  await waitUntil(() => events.length > 0);
  await session.interrupt();
  await assert.rejects(session.startTurn({ ...TURN, prompt: "Next" }), (error) => error.sessionClosed === true);
  assert.deepEqual(events.filter(isTerminal), [{ type: "turn-cancelled" }]);
  assert.equal(session.closed, true);
  await assert.rejects(session.startTurn(TURN), (error) => error.sessionClosed === true);
});

test("an approval requested after the turn was stopped is cancelled at once", async (t) => {
  const script = async function* ({ interrupted, options }) {
    yield init;
    await interrupted;
    const result = await options.canUseTool("Write", { file_path: "/repo/hello.txt", content: "hi" }, { requestId: "late-1", toolUseID: "tool-late" });
    yield delta(JSON.stringify(result));
    yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request was aborted."] };
  };
  const { session, events } = claude(t, { script });
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  await waitUntil(() => events.length > 0);
  await session.interrupt();
  await ended(events);
  assert.equal(
    events.some((event) => event.type === "permission-request" || event.type === "permission-resolved"),
    false,
  );
  assert.deepEqual(JSON.parse(replyText(events)), { behavior: "deny", message: "The turn was cancelled in Milagre.", interrupt: true });
  assert.equal(session.respondToPermission("late-1", "allow"), false);
});

const questioned = (events) => waitUntil(() => events.some((event) => event.type === "question-request"));

test("Claude's question becomes a card, and the answers go back keyed by question text", async (t) => {
  const { session, events, calls } = claude(t, { script: scripts.questions });
  await session.startTurn({ ...TURN, permissionMode: "full" });
  await questioned(events);
  assert.equal(calls.options.permissionMode, "bypassPermissions");
  assert.deepEqual(
    events.find((event) => event.type === "question-request"),
    {
      type: "question-request",
      requestId: "q-1",
      questions: [
        {
          id: "0",
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
  assert.equal(session.answerQuestion("q-1", { 0: ["Green"] }), true);
  assert.equal(session.answerQuestion("q-1", { 0: ["Red"] }), false);
  await ended(events);
  assert.deepEqual(JSON.parse(replyText(events)), { behavior: "allow", updatedInput: { ...COLOR_QUESTION, answers: { "Which color?": "Green" } } });
  assert.deepEqual(
    events.find((event) => event.type === "question-resolved"),
    { type: "question-resolved", requestId: "q-1", outcome: "answered" },
  );
  assert.deepEqual(events.at(-1), { type: "turn-completed" });
});

test("dismissing Claude's question tells Claude the user closed it", async (t) => {
  const { session, events } = claude(t, { script: scripts.questions });
  await session.startTurn(TURN);
  await questioned(events);
  assert.equal(session.answerQuestion("q-1", null), true);
  await ended(events);
  assert.deepEqual(JSON.parse(replyText(events)), { behavior: "deny", message: DISMISSED_MESSAGE });
  assert.equal(events.find((event) => event.type === "question-resolved").outcome, "dismissed");
});

test("interrupting cancels Claude's open question", async (t) => {
  const { session, events } = claude(t, { script: scripts.questions });
  await session.startTurn(TURN);
  await questioned(events);
  await session.interrupt();
  await ended(events);
  assert.deepEqual(
    events.find((event) => event.type === "question-resolved"),
    { type: "question-resolved", requestId: "q-1", outcome: "cancelled" },
  );
  assert.deepEqual(events.at(-1), { type: "turn-cancelled" });
  assert.equal(session.answerQuestion("q-1", { 0: ["Green"] }), false);
});

test("a steering message dismisses Claude's open question and reaches Claude", async (t) => {
  const { session, events } = claude(t, { script: scripts.questionThenSteer });
  const first = await session.startTurn(TURN);
  await questioned(events);
  assert.deepEqual(await session.startTurn({ ...TURN, prompt: "Green, please" }), { turnId: first.turnId, steered: true });
  await ended(events);
  const [result, steer] = replyText(events).split("|");
  assert.deepEqual(JSON.parse(result), { behavior: "deny", message: DISMISSED_MESSAGE });
  assert.equal(steer, "Green, please");
  assert.equal(events.find((event) => event.type === "question-resolved").outcome, "dismissed");
});

test("a question Milagre can't show is turned down without a card", async (t) => {
  const script = async function* ({ options }) {
    yield init;
    yield delta(JSON.stringify(await options.canUseTool("AskUserQuestion", { questions: [] }, { requestId: "q-bad", toolUseID: "tool-bad" })));
    yield success;
  };
  const { session, events } = claude(t, { script });
  await session.startTurn(TURN);
  await ended(events);
  assert.equal(
    events.some((event) => event.type === "question-request"),
    false,
  );
  assert.deepEqual(JSON.parse(replyText(events)), { behavior: "deny", message: UNSHOWN_MESSAGE });
});

test("a question asked after the turn was stopped is cancelled at once", async (t) => {
  const script = async function* ({ interrupted, options }) {
    yield init;
    await interrupted;
    yield delta(JSON.stringify(await options.canUseTool("AskUserQuestion", COLOR_QUESTION, { requestId: "q-late", toolUseID: "tool-late" })));
    yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request was aborted."] };
  };
  const { session, events } = claude(t, { script });
  await session.startTurn(TURN);
  await waitUntil(() => events.length > 0);
  await session.interrupt();
  await ended(events);
  assert.equal(
    events.some((event) => event.type === "question-request" || event.type === "question-resolved"),
    false,
  );
  assert.deepEqual(JSON.parse(replyText(events)), { behavior: "deny", message: "The turn was cancelled in Milagre.", interrupt: true });
  assert.equal(session.answerQuestion("q-late", null), false);
});

const loggedOut = async function* () {
  yield init;
  yield {
    type: "assistant",
    error: "authentication_failed",
    parent_tool_use_id: null,
    message: { model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] },
  };
  yield { type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" };
};

test("a logged-out Claude closes its session and forgets the id its logged-out run announced", async (t) => {
  const { session, events } = claude(t, { script: loggedOut });
  await session.startTurn(TURN);
  await ended(events);
  await waitUntil(() => session.closed);
  assert.deepEqual(events.slice(-2), [{ type: "session-reset" }, failedWith(loginMessage("claude"), { login: true })]);
  assert.equal(
    events.some((event) => event.message === RESUME_FAILED_MESSAGE),
    false,
  );
});

test("a logged-out Claude that resumed a chat keeps the chat's id", async (t) => {
  const { session, events } = claude(t, { script: loggedOut, resumeId: "session-1" });
  await session.startTurn(TURN);
  await ended(events);
  await waitUntil(() => session.closed);
  assert.equal(
    events.some((event) => event.type === "session-reset"),
    false,
  );
  assert.deepEqual(events.at(-1), failedWith(loginMessage("claude"), { login: true }));
});

test("after a login failure the next message starts a fresh process that resumes the saved id", async (t) => {
  const { SessionManager } = require("./session-manager.cjs");
  const sdks = [fakeSdk(loggedOut), fakeSdk(scripts.reply)];
  const sessions = [];
  const sent = [];
  const manager = new SessionManager({
    send: (chatId, event) => sent.push(event),
    createSession: (provider, options) => {
      const session = new ClaudeSession({ ...options, loadSdk: sdks[sessions.length].loadSdk });
      sessions.push(session);
      return session;
    },
  });
  t.after(() => Promise.all(sessions.map((session) => session.close())));
  const request = {
    chatId: "chat-1",
    provider: "claude",
    cwd: "/repo",
    command: "/c/claude",
    prompt: "Hi",
    images: [],
    model: "claude-opus-5-5",
    permissionMode: "auto",
    resumeId: "session-1",
  };
  await manager.startTurn(request);
  await waitUntil(() => sent.filter(isTerminal).length === 1 && sessions[0].closed);
  assert.deepEqual(sent.at(-1), failedWith(loginMessage("claude"), { login: true }));
  await manager.startTurn(request);
  await waitUntil(() => sent.filter(isTerminal).length === 2);
  assert.equal(sessions.length, 2);
  assert.equal(sdks[1].calls.options.resume, "session-1");
  assert.deepEqual(sent.at(-1), { type: "turn-completed" });
});

test("a login failure on a later turn keeps the chat's id, and only a fresh logged-out first turn resets it", async (t) => {
  let turns = 0;
  const script = async function* (context) {
    turns += 1;
    if (turns === 1) yield* scripts.reply(context);
    else yield* loggedOut();
  };
  const { session, events } = claude(t, { script });
  await session.startTurn(TURN);
  await ended(events);
  assert.equal(events.filter((event) => event.type === "session-started").length, 1);
  // The user logged out; Claude Code announces the same id again and answers "not logged in".
  await session.startTurn(TURN);
  await ended(events, 2);
  await waitUntil(() => session.closed);
  assert.equal(
    events.some((event) => event.type === "session-reset"),
    false,
  );
  assert.deepEqual(events.at(-1), failedWith(loginMessage("claude"), { login: true }));
});

test("TLDR can be disabled when starting or resuming Claude", async (t) => {
  for (const resumeId of [undefined, "session-existing"]) {
    const { session, events, calls } = claude(t, { tldrEnabled: false, resumeId });
    await session.startTurn(TURN);
    await ended(events);
    assert.ok(!calls.options.systemPrompt.append.includes("# tldr eval"));
    assert.match(calls.options.systemPrompt.append, /TLDR.*disabled/);
    assert.equal(calls.options.resume, resumeId);
  }
});

test("only the read, plan, own-canvas and self-gated Milagre tools skip Claude's approval; the rest follow the Chat's mode", async (t) => {
  const tool = (name, readOnly) => ({ name, description: name, input: {}, readOnly, run: async () => `${name} ran` });
  const tools = [
    tool("linked_overview", true),
    tool("linear_issue", true),
    tool("tasks_set", false),
    tool("phase_set", false),
    tool("delegate", false),
    tool("worktree_link", false),
    tool("chat_set_mode", false),
    tool("design_show", false),
    tool("design_apply", false),
    tool("artifact_show", false),
    tool("worktree_create", false),
    tool("chat_stop", false),
    tool("linear_create_issue", false),
    tool("design_delete", false),
  ];
  const sdk = fakeSdk(async function* ({ options, signal }) {
    yield init;
    const result = await options.canUseTool("mcp__milagre__worktree_create", { projectPath: "/repo" }, { signal, requestId: "req-mcp", toolUseID: "tool-mcp" });
    yield delta(JSON.stringify(result));
    yield success;
  });
  const loadSdk = async () => ({
    ...(await sdk.loadSdk()),
    tool: (name, description, input, handler, extras) => ({ name, description, input, handler, extras }),
    createSdkMcpServer: (options) => ({ type: "sdk", name: options.name, instance: {} }),
  });
  const events = [];
  const session = new ClaudeSession({ cwd: "/repo", command: "/usr/local/bin/claude", linked: { tools }, emit: (event) => events.push(event), loadSdk });
  t.after(() => session.close());
  await session.startTurn({ ...TURN, permissionMode: "ask" });
  assert.deepEqual(
    sdk.calls.options.allowedTools,
    [
      "linked_overview",
      "linear_issue",
      "tasks_set",
      "phase_set",
      "delegate",
      "worktree_link",
      "chat_set_mode",
      "design_show",
      "design_apply",
      "artifact_show",
    ].map((name) => `mcp__milagre__${name}`),
  );
  // A write tool reaches canUseTool and waits on the Chat's card in Ask mode.
  await waitUntil(() => events.some((event) => event.type === "permission-request"));
  const card = events.find((event) => event.type === "permission-request");
  assert.equal(card.requestId, "req-mcp");
  assert.equal(card.kind, "other");
  session.respondToPermission("req-mcp", "deny");
  await ended(events);
  assert.match(events.findLast((event) => event.type === "text-delta").text, /"behavior":"deny"/);
});

test("a Chat's linked tools are served in-process and allowed without Claude's own approval", async (t) => {
  const sdk = fakeSdk(scripts.reply);
  const made = [];
  const loadSdk = async () => ({
    ...(await sdk.loadSdk()),
    tool: (name, description, input, handler, extras) => ({ name, description, input, handler, extras }),
    createSdkMcpServer: (options) => {
      made.push(options);
      return { type: "sdk", name: options.name, instance: {} };
    },
  });
  const events = [];
  const linked = { tools: [{ name: "linked_overview", description: "Summary", input: {}, readOnly: true, run: async () => "summary of web" }] };
  const session = new ClaudeSession({ cwd: "/repo", command: "/usr/local/bin/claude", linked, emit: (event) => events.push(event), loadSdk });
  t.after(() => session.close());
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(sdk.calls.options.mcpServers, { milagre: { type: "sdk", name: "milagre", instance: {} } });
  assert.deepEqual(sdk.calls.options.allowedTools, ["mcp__milagre__linked_overview"]);
  assert.equal(made[0].tools[0].extras.annotations.readOnlyHint, true);
  assert.deepEqual(await made[0].tools[0].handler({}), { content: [{ type: "text", text: "summary of web" }], isError: false });
});

test("Everywhere servers join mcpServers and off servers are toggled after init", async (t) => {
  const sdk = fakeSdk(scripts.reply);
  const events = [];
  const session = new ClaudeSession({
    cwd: "/repo",
    command: "/usr/local/bin/claude",
    emit: (event) => events.push(event),
    mcpExtras: async () => ({ servers: [{ name: "linear", type: "http", url: "https://x", headers: {} }], off: ["figma"] }),
    loadSdk: sdk.loadSdk,
  });
  t.after(() => session.close());
  await session.startTurn(TURN);
  await ended(events);
  assert.deepEqual(sdk.calls.options.mcpServers.linear, { type: "http", url: "https://x" });
  // Switched off before the first message reaches Claude Code, and once more on init as a second try.
  assert.deepEqual(sdk.calls.toggles, [
    ["figma", false],
    ["figma", false],
  ]);
  assert.ok(sdk.calls.order.indexOf("toggle:figma") < sdk.calls.order.indexOf("message"));
});

test("analysis-only Claude gets no Everywhere servers, and a failing mcpExtras still starts the Chat", async (t) => {
  const sdk = fakeSdk(scripts.reply);
  const events = [];
  const session = new ClaudeSession({
    cwd: "/repo",
    command: "/usr/local/bin/claude",
    analysisOnly: true,
    emit: (event) => events.push(event),
    mcpExtras: async () => ({ servers: [{ name: "linear", type: "http", url: "https://x", headers: {} }], off: ["figma"] }),
    loadSdk: sdk.loadSdk,
  });
  t.after(() => session.close());
  await session.startTurn(TURN);
  await ended(events);
  assert.equal(sdk.calls.options.mcpServers?.linear, undefined);
  assert.equal(sdk.calls.toggles, undefined);

  const warn = t.mock.method(console, "warn", () => {});
  const failing = fakeSdk(scripts.reply);
  const failEvents = [];
  const second = new ClaudeSession({
    cwd: "/repo",
    command: "/usr/local/bin/claude",
    emit: (event) => failEvents.push(event),
    mcpExtras: async () => {
      throw new Error("boom");
    },
    loadSdk: failing.loadSdk,
  });
  t.after(() => second.close());
  await second.startTurn(TURN);
  await ended(failEvents);
  assert.equal(failing.calls.queries, 1);
  // The failure is logged once, with its message, instead of being swallowed.
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments.join(" ")), /boom/);
});

test("Claude's subagents are told to keep a to-do list as they start, and to design on the Chat's canvas when design tools are linked", async (t) => {
  const { SUBAGENT_DESIGN_INSTRUCTIONS, SUBAGENT_PLAN_INSTRUCTIONS } = require("./events.cjs");
  const design = { name: "design_show", description: "Show", input: {}, readOnly: false, run: async () => "" };
  for (const [tools, designs] of [
    [[design], true],
    [[], false],
  ]) {
    const sdk = fakeSdk(scripts.reply);
    const loadSdk = async () => ({
      ...(await sdk.loadSdk()),
      tool: (name, description, input, handler, extras) => ({ name, description, input, handler, extras }),
      createSdkMcpServer: (options) => ({ type: "sdk", name: options.name, instance: {} }),
    });
    const events = [];
    const session = new ClaudeSession({
      cwd: "/repo",
      command: "/usr/local/bin/claude",
      linked: { tools },
      emit: (event) => events.push(event),
      loadSdk,
    });
    t.after(() => session.close());
    await session.startTurn(TURN);
    await ended(events);
    const hook = sdk.calls.options.hooks?.SubagentStart?.[0]?.hooks?.[0];
    assert.deepEqual(await hook({ hook_event_name: "SubagentStart", agent_id: "a", agent_type: "general-purpose" }), {
      hookSpecificOutput: {
        hookEventName: "SubagentStart",
        additionalContext: designs ? `${SUBAGENT_PLAN_INSTRUCTIONS}\n\n${SUBAGENT_DESIGN_INSTRUCTIONS}` : SUBAGENT_PLAN_INSTRUCTIONS,
      },
    });
  }
  assert.match(SUBAGENT_DESIGN_INSTRUCTIONS, /show a mockup or visual design \(not to implement UI in code\), use the milagre design_show tool/);
  assert.match(SUBAGENT_DESIGN_INSTRUCTIONS, /Don't write HTML or image files.*names another design tool, use that one/s);
  assert.match(SUBAGENT_PLAN_INSTRUCTIONS, /TodoWrite, or TaskCreate and TaskUpdate.*Never use the milagre tasks_set/s);
});

const mergePolicy = (request) => (request.command?.startsWith("gh pr merge") ? { gate: { kind: "merge", title: "Merge PR #1" } } : "allow");

test("bot mode adds a PreToolUse hook that asks for gated tools", async (t) => {
  const { session, events, calls } = claude(t, { permissionPolicy: mergePolicy });
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await ended(events);
  const hook = calls.options.hooks.PreToolUse[0].hooks[0];
  const signal = new AbortController().signal;
  assert.deepEqual(
    await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh pr merge 1" }, tool_use_id: "t1" }, "t1", { signal }),
    {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Merge PR #1" },
    },
  );
  assert.deepEqual(await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t2" }, "t2", { signal }), {});
});

test("the gate hook denies what the policy denies, asks when the policy fails, and stands down outside Bot rules", async (t) => {
  let verdict = () => "deny";
  const { session, events, calls } = claude(t, { permissionPolicy: (request) => verdict(request) });
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await ended(events);
  const hook = calls.options.hooks.PreToolUse[0].hooks[0];
  const input = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "t3" };
  assert.equal((await hook(input, "t3")).hookSpecificOutput.permissionDecision, "deny");
  verdict = () => {
    throw new Error("broken");
  };
  assert.equal((await hook(input, "t3")).hookSpecificOutput.permissionDecision, "ask");
  // The user took the Chat over: Bot rules no longer applies, and neither does the bot's policy.
  await session.setPermissionMode("ask");
  assert.deepEqual(await hook(input, "t3"), {});
});

test("the gate hook hands the policy the same request canUseTool would", async (t) => {
  const seen = [];
  const { session, events, calls } = claude(t, {
    permissionPolicy: (request) => {
      seen.push(request);
      return "allow";
    },
  });
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await ended(events);
  await calls.options.hooks.PreToolUse[0].hooks[0](
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "t4" },
    "t4",
  );
  assert.deepEqual(seen, [
    { requestId: "t4", kind: "command", tool: "Bash", title: "Run this command?", command: "npm test", allowForChat: false, stepId: "t4" },
  ]);
});

test("an MCP tool shown by its display name still gates on its own name", async (t) => {
  const { matchGate } = require("../bots/gates.cjs");
  const seen = [];
  const policy = (request) => {
    seen.push(request);
    const gate = matchGate(request);
    return gate ? { gate } : "allow";
  };
  const { session, events } = claude(t, { script: scripts.sendsMessage, permissionPolicy: policy });
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await asked(events);
  const request = events.find((event) => event.type === "permission-request");
  assert.equal(request.tool, "Send Message");
  assert.equal(request.toolName, "mcp__slack__send_message");
  assert.equal(request.gate.kind, "post");
  session.respondToPermission("req-m", "deny");
  await ended(events);
  assert.equal(JSON.parse(replyText(events)).behavior, "deny");
});

test("canUseTool never lets through what the PreToolUse hook asked about", async (t) => {
  const gate = { kind: "post", title: "Post as you: mcp__slack__send_message" };
  // A policy that sees the gate in the hook and misses it in canUseTool.
  const { session, events } = claude(t, {
    script: scripts.sendsMessage,
    permissionPolicy: (request) => (request.tool === "Send Message" ? "allow" : { gate }),
  });
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await asked(events);
  assert.deepEqual(events.find((event) => event.type === "permission-request").gate, gate);
  session.respondToPermission("req-m", "allow");
  await ended(events);
  assert.equal(JSON.parse(replyText(events)).behavior, "allow");
});

test("outside Bot rules the PreToolUse hook lets every tool through", async (t) => {
  const merge = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh pr merge 1" }, tool_use_id: "t1" };
  for (const permissionMode of ["ask", "auto", "full"]) {
    const { session, events, calls } = claude(t, { permissionPolicy: mergePolicy });
    await session.startTurn({ ...TURN, permissionMode });
    await ended(events);
    assert.deepEqual(await calls.options.hooks.PreToolUse[0].hooks[0](merge, "t1"), {}, permissionMode);
  }
  // Bot rules without a policy has nothing to gate with.
  const { session, events, calls } = claude(t);
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await ended(events);
  assert.deepEqual(await calls.options.hooks.PreToolUse[0].hooks[0](merge, "t1"), {});
});

test("guarded turn denies push in full mode, and only that turn", async (t) => {
  const { session, events, calls } = claude(t, { script: scripts.held });
  await session.startTurn({ ...TURN, permissionMode: "full", guard: { level: 2, resolveThreads: false } });
  await waitUntil(() => calls.options);
  const hook = calls.options.hooks.PreToolUse[0].hooks[0];
  const bash = (command, id) => hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: id }, id);
  assert.deepEqual(await bash("npm test && git push origin HEAD", "t1"), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Babysit level Fix, don't push doesn't allow pushing to GitHub. Change it in Settings › Experimental › Babysit PRs.",
    },
  });
  assert.equal((await bash("gh pr merge 4", "t2")).hookSpecificOutput.permissionDecisionReason, "Babysitting never merges.");
  assert.deepEqual(await bash("npm test", "t3"), {});
  // A message steered into the Run keeps its guard.
  await session.startTurn({ ...TURN, prompt: "also run lint", permissionMode: "full" });
  assert.equal((await bash("git push", "t4")).hookSpecificOutput.permissionDecision, "deny");
  calls.release();
  await ended(events);
  // The Chat's next turn is the user's own: nothing is guarded.
  await session.startTurn({ ...TURN, permissionMode: "full" });
  assert.deepEqual(await bash("git push", "t5"), {});
});

test("a guarded command that reaches canUseTool is denied there too", async (t) => {
  const { session, events, calls } = claude(t, { script: scripts.held });
  await session.startTurn({ ...TURN, permissionMode: "ask", guard: { level: 1, resolveThreads: false } });
  await waitUntil(() => calls.options);
  const result = await calls.options.canUseTool("Bash", { command: "git push" }, { requestId: "r1", toolUseID: "u1" });
  assert.deepEqual(result, {
    behavior: "deny",
    message: "Babysit level Report only doesn't allow pushing to GitHub. Change it in Settings › Experimental › Babysit PRs.",
  });
  assert.equal(
    events.some((event) => event.type === "permission-request"),
    false,
  );
  calls.release();
  await ended(events);
});

test("analysis-only Claude gets no hooks at all, even in Bot rules", async (t) => {
  const { session, events, calls } = claude(t, { analysisOnly: true, permissionPolicy: mergePolicy });
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await ended(events);
  assert.equal("hooks" in calls.options, false);
});

test("the design SubagentStart hook and the gate hook coexist", async (t) => {
  const { SUBAGENT_DESIGN_INSTRUCTIONS, SUBAGENT_PLAN_INSTRUCTIONS } = require("./events.cjs");
  const design = { name: "design_show", description: "Show", input: {}, readOnly: false, run: async () => "" };
  const sdk = fakeSdk(scripts.reply);
  const loadSdk = async () => ({
    ...(await sdk.loadSdk()),
    tool: (name, description, input, handler, extras) => ({ name, description, input, handler, extras }),
    createSdkMcpServer: (options) => ({ type: "sdk", name: options.name, instance: {} }),
  });
  const events = [];
  const session = new ClaudeSession({
    cwd: "/repo",
    command: "/usr/local/bin/claude",
    linked: { tools: [design] },
    permissionPolicy: mergePolicy,
    emit: (event) => events.push(event),
    loadSdk,
  });
  t.after(() => session.close());
  await session.startTurn({ ...TURN, permissionMode: "bot" });
  await ended(events);
  const { hooks } = sdk.calls.options;
  assert.equal(
    (await hooks.SubagentStart[0].hooks[0]()).hookSpecificOutput.additionalContext,
    `${SUBAGENT_PLAN_INSTRUCTIONS}\n\n${SUBAGENT_DESIGN_INSTRUCTIONS}`,
  );
  assert.equal(
    (await hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh pr merge 1" } }, "t5"))
      .hookSpecificOutput.permissionDecision,
    "ask",
  );
});

const suggested = { type: "prompt_suggestion", session_id: "session-1", suggestion: "Add tests" };
async function* suggests() {
  yield init;
  yield delta("Hello");
  yield success;
  yield suggested;
}

async function* overlap({ next }) {
  yield init;
  yield success;
  await next();
  yield suggested;
  yield init;
  yield delta("Second reply");
  yield success;
  yield init;
  yield suggested;
}

async function* steered({ next }) {
  yield init;
  await next();
  yield success;
  yield suggested;
}

async function* cancelled({ interrupted }) {
  yield init;
  await interrupted;
  yield success;
  yield suggested;
}

test("Claude receives a suggestion after completion without starting another turn", async (t) => {
  const { session, events, calls } = claude(t, { script: suggests });
  const { turnId } = await session.startTurn(TURN);
  await waitUntil(() => events.some((event) => event.type === "prompt-suggestion"));
  assert.equal(calls.options.promptSuggestions, true);
  assert.deepEqual(events.at(-1), { type: "prompt-suggestion", text: "Add tests", turnId });
  assert.equal(session.turnActive, false);
  assert.equal(events.filter((event) => event.type === "turn-started").length, 1);
});

test("Claude ignores old suggestions during the next turn and after an implicit init", async (t) => {
  const { session, events } = claude(t, { script: overlap });
  await session.startTurn(TURN);
  await ended(events);
  await session.startTurn({ ...TURN, prompt: "Second" });
  await ended(events, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === "prompt-suggestion").length, 0);
  assert.equal(events.filter((event) => event.type === "turn-started").length, 2);
  assert.equal(session.turnActive, false);
});

test("Claude disables suggestion requests for either advisor mode, env off and the computer default settings", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-suggestions-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "settings.json");
  for (const configuration of [
    { analysisOnly: true },
    { executionAdvisor: true },
    { env: { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false" } },
    { defaultConfigDir: directory, env: { CLAUDE_CONFIG_DIR: "/extra-account" } },
  ]) {
    fs.writeFileSync(file, JSON.stringify({ promptSuggestionEnabled: false }));
    const { session, events, calls } = claude(t, { ...configuration, script: suggests });
    await session.startTurn(TURN);
    await ended(events);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.options.promptSuggestions, false);
    assert.equal(
      events.some((event) => event.type === "prompt-suggestion"),
      false,
    );
  }
  for (const settings of ["{", "{}", '{"promptSuggestionEnabled":true}']) {
    fs.writeFileSync(file, settings);
    const { session, events, calls } = claude(t, { defaultConfigDir: directory, script: suggests });
    await session.startTurn(TURN);
    await ended(events);
    assert.equal(calls.options.promptSuggestions, true);
  }
});

test("Claude suppresses suggestions after a steer or cancellation", async (t) => {
  const first = claude(t, { script: steered });
  await first.session.startTurn(TURN);
  await first.session.steer(TURN);
  await ended(first.events);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    first.events.some((event) => event.type === "prompt-suggestion"),
    false,
  );

  const second = claude(t, { script: cancelled });
  await second.session.startTurn(TURN);
  await second.session.interrupt();
  await ended(second.events);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    second.events.some((event) => event.type === "prompt-suggestion"),
    false,
  );
});
