const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PiRpc } = require("./pi-rpc.cjs");
const { PiSession } = require("./pi-session.cjs");
const { toolCallRequest } = require("./pi-extension.cjs");
const { isTerminal } = require("./events.cjs");
const { waitUntil } = require("./test-helpers.cjs");

const FAKE = path.join(__dirname, "fixtures", "fake-pi-agent.cjs");
const MODELS = [{ id: "ollama:qwen3:8b", name: "qwen3:8b", recommended: true, efforts: ["low", "medium", "high"] }];

function pi(t, { scenario = "chat", env = {}, ...options } = {}) {
  const events = [];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-pi-cwd-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-pi-profile-"));
  const spawned = [];
  const session = new PiSession({
    cwd,
    command: "/usr/local/bin/pi",
    env: { ...process.env, PI_CODING_AGENT_DIR: profile },
    emit: (event) => events.push(event),
    syncModels: async () => MODELS,
    createRpc: (rpcOptions) => {
      spawned.push(rpcOptions);
      return new PiRpc({
        ...rpcOptions,
        command: process.execPath,
        args: [FAKE, ...rpcOptions.args],
        env: { ...rpcOptions.env, FAKE_SCENARIO: scenario, ...env },
      });
    },
    ...options,
  });
  t.after(async () => {
    await session.close();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true });
  });
  return { session, events, spawned, cwd, profile };
}

const ended = (events) => events.some(isTerminal);
const reply = (events) =>
  events
    .filter((event) => event.type === "text-delta")
    .map((event) => event.text)
    .join("");

test("a turn starts Pi in RPC mode from the Milagre profile and maps thinking, text and context use", async (t) => {
  const { session, events, spawned, profile } = pi(t);
  await session.startTurn({ prompt: "hi", model: "ollama:qwen3:8b", effort: "low", permissionMode: "ask" });
  await waitUntil(() => ended(events));
  const { args } = spawned[0];
  assert.deepEqual(args.slice(0, 3), ["--mode", "rpc", "--no-extensions"]);
  assert.equal(args[args.indexOf("-e") + 1], path.join(profile, "milagre-extension.mjs"));
  assert.equal(args[args.indexOf("--model") + 1], "qwen3:8b");
  assert.equal(args[args.indexOf("--session-dir") + 1], path.join(profile, "sessions"));
  assert.match(fs.readFileSync(path.join(profile, "milagre-extension.mjs"), "utf8"), /registerMcpServer/);
  assert.equal(session.nativeId, "pi-session-1");
  assert.ok(events.some((event) => event.type === "session-started" && event.nativeId === "pi-session-1"));
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("step")).map((event) => [event.type, event.step?.kind ?? event.status ?? event.text]),
    [
      ["step-started", "thinking"],
      ["step-output", "Hmm"],
      ["step-completed", "done"],
    ],
  );
  assert.equal(events.find((event) => event.type === "step-completed").detail, "Hmm, easy.");
  assert.equal(reply(events), "Hello\u2028world");
  assert.deepEqual(events.at(-2), { type: "context-usage", used: 1200, size: 65536 });
  const { type, metrics } = events.at(-1);
  assert.equal(type, "turn-completed");
  assert.equal(metrics.calls, 1);
  assert.equal(metrics.inputTokens, 1000);
  assert.equal(metrics.outputTokens, 30);
  assert.ok(metrics.ttftMs >= 100, `time to first token ${metrics.ttftMs}`);
  assert.ok(metrics.outputTps > 0 && metrics.outputTps < 300, `output ${metrics.outputTps} tok/s`);
  assert.ok(metrics.prefillTps > 0, `prefill ${metrics.prefillTps} tok/s`);
});

test("Compact runs Pi's own compaction, and automatic compaction is switched on", async (t) => {
  const { session, events } = pi(t, { scenario: "compact" });
  await session.startTurn({ prompt: "/compact", model: "ollama:qwen3:8b" });
  await waitUntil(() => ended(events));
  assert.deepEqual(
    events.filter((event) => event.type.startsWith("context-compact")),
    [{ type: "context-compacting" }, { type: "context-compacted", trigger: "manual", before: 50000, after: 8000 }],
  );
  assert.deepEqual(events.at(-1), { type: "turn-completed" });
  assert.ok(!events.some((event) => event.type === "text-delta"));
});

test("a saved session resumes by id, and a missing one resets the Chat", async (t) => {
  const { session, events, spawned } = pi(t, { resumeId: "old-session", env: { FAKE_MISSING_SESSION: "1" } });
  await session.startTurn({ prompt: "again", model: "ollama:qwen3:8b" });
  await waitUntil(() => ended(events));
  assert.equal(spawned[0].args[spawned[0].args.indexOf("--session") + 1], "old-session");
  assert.ok(events.some((event) => event.type === "session-reset"));
  assert.equal(events.at(-1).type, "turn-failed");
});

test("Ask shows a command as a card and runs it once allowed", async (t) => {
  const { session, events } = pi(t, { scenario: "tool" });
  await session.startTurn({ prompt: "list", model: "ollama:qwen3:8b", permissionMode: "ask" });
  await waitUntil(() => events.some((event) => event.type === "permission-request"));
  const card = events.find((event) => event.type === "permission-request");
  assert.equal(card.kind, "command");
  assert.equal(card.command, "ls");
  assert.equal(card.stepId, "call-1");
  assert.equal(session.respondToPermission(card.requestId, "allow"), true);
  await waitUntil(() => ended(events));
  assert.equal(events.find((event) => event.type === "step-started").step.title, "Ran `ls`");
  assert.ok(events.some((event) => event.type === "step-output" && event.text === "a\n"));
  assert.equal(events.find((event) => event.type === "step-completed").status, "done");
  assert.equal(reply(events), "answer:allow");
});

test("Auto runs a command that stays in the folder and asks, with the reason, for a risky one", async (t) => {
  const safe = pi(t, { scenario: "tool" });
  await safe.session.startTurn({ prompt: "list", model: "ollama:qwen3:8b", permissionMode: "auto" });
  await waitUntil(() => ended(safe.events));
  assert.ok(!safe.events.some((event) => event.type === "permission-request"));
  assert.equal(reply(safe.events), "answer:allow");

  const risky = pi(t, { scenario: "tool", env: { FAKE_TOOL: JSON.stringify({ toolName: "bash", input: { command: "git push --force origin main" } }) } });
  await risky.session.startTurn({ prompt: "push", model: "ollama:qwen3:8b", permissionMode: "auto" });
  await waitUntil(() => risky.events.some((event) => event.type === "permission-request"));
  const card = risky.events.find((event) => event.type === "permission-request");
  assert.ok(card.reason);
  assert.equal(card.allowForChat, false);
  risky.session.respondToPermission(card.requestId, "deny");
  await waitUntil(() => ended(risky.events));
  assert.match(reply(risky.events), /^answer:deny:/);
  assert.equal(risky.events.find((event) => event.type === "step-completed").status, "failed");
});

test("Auto edits files inside the Chat's folder without asking", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-pi-edit-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { session, events } = pi(t, {
    scenario: "tool",
    cwd,
    workspaceRoots: [cwd],
    env: { FAKE_TOOL: JSON.stringify({ toolName: "edit", input: { path: "notes.md", edits: [{ oldText: "a", newText: "b" }] } }) },
  });
  await session.startTurn({ prompt: "edit", model: "ollama:qwen3:8b", permissionMode: "auto" });
  await waitUntil(() => ended(events));
  assert.ok(!events.some((event) => event.type === "permission-request"));
  assert.equal(events.find((event) => event.type === "step-started").step.title, "Edited `notes.md`");
});

test("a read-only Chat turns down changes without a card", async (t) => {
  const { session, events } = pi(t, { scenario: "tool", analysisOnly: true });
  await session.startTurn({ prompt: "list", model: "ollama:qwen3:8b", permissionMode: "full" });
  await waitUntil(() => ended(events));
  assert.ok(!events.some((event) => event.type === "permission-request"));
  assert.equal(reply(events), "answer:deny:This Chat can only read.");
});

test("a message sent mid-turn steers it, and Stop aborts the run", async (t) => {
  const { session, events } = pi(t, { scenario: "hang" });
  const first = await session.startTurn({ prompt: "work", model: "ollama:qwen3:8b" });
  await waitUntil(() => events.some((event) => event.type === "turn-started"));
  const steered = await session.startTurn({ prompt: "also this", model: "ollama:qwen3:8b" });
  assert.deepEqual(steered, { turnId: first.turnId, steered: true });
  await waitUntil(() => reply(events) === "steered:also this");
  await session.interrupt();
  await waitUntil(() => ended(events));
  assert.equal(events.at(-1).type, "turn-cancelled");
});

test("a model error ends the turn with Ollama's message", async (t) => {
  const { session, events } = pi(t, { scenario: "error" });
  await session.startTurn({ prompt: "hi", model: "ollama:qwen3:8b" });
  await waitUntil(() => ended(events));
  assert.deepEqual(events.at(-1), { type: "turn-failed", message: "Ollama: model not found" });
});

test("no Ollama means a turn that says how to start it", async (t) => {
  const { session, events, spawned } = pi(t, {
    syncModels: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await session.startTurn({ prompt: "hi", model: "ollama:qwen3:8b" });
  await waitUntil(() => ended(events));
  assert.equal(spawned.length, 0);
  assert.match(events.at(-1).message, /Ollama isn't running/);
});

test("only Milagre's own tool-call dialogs count as permission requests", () => {
  const title = JSON.stringify({ type: "milagre:tool_call", toolCallId: "c", toolName: "bash", input: { command: "ls" } });
  assert.equal(toolCallRequest({ method: "select", title }).toolName, "bash");
  assert.equal(toolCallRequest({ method: "confirm", title }), null);
  assert.equal(toolCallRequest({ method: "select", title: "Allow dangerous command?" }), null);
  assert.equal(toolCallRequest({ method: "select", title: '{"type":"other"}' }), null);
});
