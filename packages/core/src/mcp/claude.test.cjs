const test = require("node:test");
const assert = require("node:assert/strict");
const { checkClaude, claudeServer, addClaude, removeClaude, runCli } = require("./claude.cjs");

test("an SDK status maps to a report", () => {
  assert.deepEqual(claudeServer({ name: "pencil", status: "connected", scope: "user", tools: [{ name: "a" }, { name: "b" }], config: { type: "stdio" } }), {
    name: "pencil",
    transport: "command",
    scope: "user",
    state: "connected",
    tools: 2,
    error: null,
  });
  assert.deepEqual(claudeServer({ name: "resend", status: "needs-auth", scope: "user", config: { type: "http" } }), {
    name: "resend",
    transport: "url",
    scope: "user",
    state: "needs-sign-in",
    tools: 0,
    error: null,
  });
  assert.equal(claudeServer({ name: "atl", status: "failed", scope: "dynamic", error: "No URL", config: { type: "http" } }).scope, "plugin");
  assert.equal(claudeServer({ name: "claude.ai Gmail", status: "connected", scope: "claudeai", config: { type: "claudeai-proxy" } }).transport, "connector");
  assert.equal(claudeServer({ name: "x", status: "connected", scope: "local" }).transport, "command");
});

test("in-process SDK servers are left out", () => {
  assert.equal(claudeServer({ name: "milagre", status: "connected", config: { type: "sdk" } }), null);
});

test("a server still pending at the cap is failed with a timeout error", () => {
  assert.deepEqual(claudeServer({ name: "slow", status: "pending", scope: "user", config: { type: "stdio" } }, { timedOut: true }), {
    name: "slow",
    transport: "command",
    scope: "user",
    state: "failed",
    tools: 0,
    error: "Timed out. Check this server in a terminal.",
  });
});

function fakeSdk(answers) {
  const calls = { options: null, closed: false, polls: 0 };
  return {
    calls,
    loadSdk: async () => ({
      query: ({ options }) => {
        calls.options = options;
        return {
          mcpServerStatus: async () => answers[Math.min(calls.polls++, answers.length - 1)],
          close: () => {
            calls.closed = true;
          },
        };
      },
    }),
  };
}

test("checkClaude polls until nothing is pending, then closes the session", async () => {
  const sdk = fakeSdk([
    [{ name: "pencil", status: "pending", scope: "user", config: { type: "stdio" } }],
    [{ name: "pencil", status: "connected", scope: "user", tools: [{ name: "a" }], config: { type: "stdio" } }],
  ]);
  const servers = await checkClaude({ command: "/bin/claude", env: { CLAUDE_CONFIG_DIR: "/x" }, cwd: "/home", loadSdk: sdk.loadSdk, sleep: async () => {} });
  assert.deepEqual(
    servers.map((s) => `${s.name}:${s.state}:${s.tools}`),
    ["pencil:connected:1"],
  );
  assert.equal(sdk.calls.options.pathToClaudeCodeExecutable, "/bin/claude");
  assert.equal(sdk.calls.options.env.CLAUDE_CONFIG_DIR, "/x");
  assert.equal(sdk.calls.options.cwd, "/home");
  assert.equal(sdk.calls.closed, true);
});

test("checkClaude stops polling at the cap", async () => {
  const sdk = fakeSdk([[{ name: "slow", status: "pending", scope: "user", config: { type: "stdio" } }]]);
  let clock = 0;
  const servers = await checkClaude({
    command: "c",
    cwd: "/",
    loadSdk: sdk.loadSdk,
    timeoutMs: 1000,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
  });
  assert.equal(servers[0].error, "Timed out. Check this server in a terminal.");
  assert.equal(sdk.calls.closed, true);
});

test("aborting the signal closes the session while the check hangs", async () => {
  let closed = false;
  const controller = new AbortController();
  void checkClaude({
    command: "c",
    cwd: "/",
    signal: controller.signal,
    loadSdk: async () => ({ query: () => ({ mcpServerStatus: () => new Promise(() => {}), close: () => void (closed = true) }) }),
  }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  controller.abort();
  assert.equal(closed, true);
});

test("a signal that is already aborted closes the session right away", async () => {
  let closed = false;
  const controller = new AbortController();
  controller.abort();
  void checkClaude({
    command: "c",
    cwd: "/",
    signal: controller.signal,
    loadSdk: async () => ({ query: () => ({ mcpServerStatus: () => new Promise(() => {}), close: () => void (closed = true) }) }),
  }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
});

test("add and remove call the Claude CLI at user scope", async () => {
  const calls = [];
  const run = async (command, args, options) => (calls.push({ command, args, env: options.env }), { stdout: "", stderr: "" });
  await addClaude({ command: "/bin/claude", env: { A: "1" }, def: { name: "linear", type: "http", url: "https://x", headers: {} }, run });
  await removeClaude({ command: "/bin/claude", env: { A: "1" }, name: "linear", run });
  assert.deepEqual(calls, [
    { command: "/bin/claude", args: ["mcp", "add-json", "linear", '{"type":"http","url":"https://x"}', "--scope", "user"], env: { A: "1" } },
    { command: "/bin/claude", args: ["mcp", "remove", "linear", "--scope", "user"], env: { A: "1" } },
  ]);
});

test("runCli rejects with stderr", async () => {
  await assert.rejects(runCli(process.execPath, ["-e", "process.stderr.write('bad name'); process.exit(1)"], {}), /bad name/);
});
