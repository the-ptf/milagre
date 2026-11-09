const test = require("node:test");
const assert = require("node:assert/strict");
const { checkClaude, claudeServer, addClaude, removeClaude, runCli, signInClaude } = require("./claude.cjs");

test("an SDK status maps to a report", () => {
  assert.deepEqual(claudeServer({ name: "pencil", status: "connected", scope: "user", tools: [{ name: "a" }, { name: "b" }], config: { type: "stdio" } }), {
    name: "pencil",
    transport: "command",
    scope: "user",
    state: "connected",
    tools: 2,
    error: null,
    detail: null,
  });
  assert.deepEqual(claudeServer({ name: "resend", status: "needs-auth", scope: "user", config: { type: "http" } }), {
    name: "resend",
    transport: "url",
    scope: "user",
    state: "needs-sign-in",
    tools: 0,
    error: null,
    detail: null,
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
    detail: null,
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

const SECRET = "Bearer sk-live-0123456789abcdef0123456789abcdef0123456789";

test("runCli keeps a long argument out of the message when stderr is empty", async () => {
  await assert.rejects(runCli(process.execPath, ["-e", "process.exit(1)", SECRET], {}), (error) => {
    assert.match(error.message, /failed \(exit 1\)/);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
});

test("runCli redacts a long argument that the CLI echoes to stderr", async () => {
  await assert.rejects(runCli(process.execPath, ["-e", "process.stderr.write('bad ' + process.argv.at(-1)); process.exit(1)", SECRET], {}), (error) => {
    assert.match(error.message, /\[config\]/);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
});

function fakeSignInSdk({ auth, statuses }) {
  const seen = { options: null, closed: false, opened: [] };
  let index = 0;
  const loadSdk = async () => ({
    query: ({ options }) => {
      seen.options = options;
      return {
        mcpAuthenticate: async (name) => (typeof auth === "function" ? auth(name) : auth),
        mcpServerStatus: async () => statuses[Math.min(index++, statuses.length - 1)],
        close: () => (seen.closed = true),
      };
    },
  });
  return { seen, loadSdk };
}
const signInSleep = async () => {};

test("signInClaude opens the URL, waits for connected and closes", async () => {
  const { seen, loadSdk } = fakeSignInSdk({
    auth: { authUrl: "https://auth", callbackExpected: true },
    statuses: [[{ name: "linear", status: "needs-auth" }], [{ name: "linear", status: "connected" }]],
  });
  const everywhere = [{ name: "linear", type: "http", url: "https://x", headers: {} }];
  const result = await signInClaude({
    command: "/c",
    cwd: "/",
    name: "linear",
    everywhere,
    openUrl: (url) => seen.opened.push(url),
    loadSdk,
    sleep: signInSleep,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(seen.opened, ["https://auth"]);
  assert.deepEqual(seen.options.mcpServers, { linear: { type: "http", url: "https://x" } });
  assert.equal(seen.closed, true);
});

test("signInClaude reports a failed server, a cap and a cancel", async () => {
  const failed = fakeSignInSdk({ auth: { authUrl: "u", callbackExpected: true }, statuses: [[{ name: "x", status: "failed", error: "invalid_client" }]] });
  assert.deepEqual(await signInClaude({ command: "/c", cwd: "/", name: "x", openUrl() {}, loadSdk: failed.loadSdk, sleep: signInSleep }), {
    ok: false,
    error: "invalid_client",
  });
  assert.equal(failed.seen.closed, true);

  let clock = 0;
  const slow = fakeSignInSdk({ auth: { authUrl: "u", callbackExpected: true }, statuses: [[{ name: "x", status: "needs-auth" }]] });
  const capped = await signInClaude({
    command: "/c",
    cwd: "/",
    name: "x",
    openUrl() {},
    loadSdk: slow.loadSdk,
    sleep: async () => void (clock += 1000),
    now: () => clock,
    timeoutMs: 3000,
  });
  assert.deepEqual(capped, { ok: false, error: "Sign-in timed out after 5 minutes. Try again." });
  assert.equal(slow.seen.closed, true);

  const controller = new AbortController();
  const waiting = fakeSignInSdk({ auth: { authUrl: "u", callbackExpected: true }, statuses: [[{ name: "x", status: "needs-auth" }]] });
  const cancelled = signInClaude({
    command: "/c",
    cwd: "/",
    name: "x",
    openUrl: () => controller.abort(),
    loadSdk: waiting.loadSdk,
    sleep: signInSleep,
    signal: controller.signal,
  });
  assert.deepEqual(await cancelled, { cancelled: true });
  assert.equal(waiting.seen.closed, true);
});

test("signInClaude returns opened for a claude.ai connector and errors for stdio", async () => {
  const connector = fakeSignInSdk({ auth: { authUrl: "https://claude.ai/x", callbackExpected: false }, statuses: [[]] });
  assert.deepEqual(await signInClaude({ command: "/c", cwd: "/", name: "claude.ai Linear", openUrl() {}, loadSdk: connector.loadSdk, sleep: signInSleep }), {
    opened: true,
  });
  const stdio = fakeSignInSdk({
    auth: () => {
      throw new Error('Server type "stdio" does not support OAuth authentication');
    },
    statuses: [[]],
  });
  assert.deepEqual(await signInClaude({ command: "/c", cwd: "/", name: "p", openUrl() {}, loadSdk: stdio.loadSdk, sleep: signInSleep }), {
    ok: false,
    error: 'Server type "stdio" does not support OAuth authentication',
  });
});

test("signInClaude never rejects: a throwing openUrl or status poll is an error and the session closes", async () => {
  const throwing = fakeSignInSdk({ auth: { authUrl: "u", callbackExpected: true }, statuses: [[]] });
  assert.deepEqual(
    await signInClaude({
      command: "/c",
      cwd: "/",
      name: "x",
      openUrl() {
        throw new Error("no browser");
      },
      loadSdk: throwing.loadSdk,
      sleep: signInSleep,
    }),
    { ok: false, error: "no browser" },
  );
  assert.equal(throwing.seen.closed, true);

  const seen = { closed: false };
  const loadSdk = async () => ({
    query: () => ({
      mcpAuthenticate: async () => ({ authUrl: "u", callbackExpected: true }),
      mcpServerStatus: async () => {
        throw new Error("status down");
      },
      close: () => (seen.closed = true),
    }),
  });
  assert.deepEqual(await signInClaude({ command: "/c", cwd: "/", name: "x", openUrl() {}, loadSdk, sleep: signInSleep }), {
    ok: false,
    error: "status down",
  });
  assert.equal(seen.closed, true);

  const controller = new AbortController();
  const aborted = { closed: false };
  const abortSdk = async () => ({
    query: () => ({
      mcpAuthenticate: async () => ({ authUrl: "u", callbackExpected: true }),
      mcpServerStatus: async () => {
        controller.abort();
        throw new Error("torn down");
      },
      close: () => (aborted.closed = true),
    }),
  });
  assert.deepEqual(await signInClaude({ command: "/c", cwd: "/", name: "x", openUrl() {}, loadSdk: abortSdk, sleep: signInSleep, signal: controller.signal }), {
    cancelled: true,
  });
  assert.equal(aborted.closed, true);
});

test("claude reports carry detail and mark Everywhere servers", () => {
  assert.equal(
    claudeServer({ name: "l", status: "connected", scope: "user", config: { type: "http", url: "https://mcp.linear.app/mcp" } }).detail,
    "https://mcp.linear.app/mcp",
  );
  assert.equal(
    claudeServer({ name: "p", status: "connected", scope: "user", config: { type: "stdio", command: "npx", args: ["-y", "x"] } }).detail,
    "npx -y x",
  );
  assert.equal(
    claudeServer({ name: "pencil", status: "connected", scope: "dynamic", config: { type: "stdio", command: "p" } }, { everywhereNames: new Set(["pencil"]) })
      .scope,
    "everywhere",
  );
});

test("checkClaude passes Everywhere servers to the idle session", async () => {
  let options;
  const loadSdk = async () => ({ query: (args) => ((options = args.options), { mcpServerStatus: async () => [], close() {} }) });
  await checkClaude({ command: "/c", cwd: "/", loadSdk, everywhere: [{ name: "pencil", type: "stdio", command: "p", args: [], env: {} }] });
  assert.deepEqual(options.mcpServers, { pencil: { type: "stdio", command: "p", args: [] } });
});

test("claude detail hides secrets", () => {
  assert.equal(
    claudeServer({ name: "l", status: "connected", scope: "user", config: { type: "http", url: "https://u:p@x.dev/mcp?key=1" } }).detail,
    "https://x.dev/mcp",
  );
  assert.equal(
    claudeServer({ name: "p", status: "connected", scope: "user", config: { type: "stdio", command: "npx", args: ["--token", "t"] } }).detail,
    "npx --token ••••••",
  );
});

test("a server disabled in Claude's own config says so", () => {
  const off = claudeServer({ name: "old", status: "disabled", scope: "project", config: { type: "stdio", command: "old" } });
  assert.equal(off.state, "disabled");
  assert.equal(off.disabledBy, "provider");
  assert.equal("disabledBy" in claudeServer({ name: "on", status: "connected", scope: "user", config: { type: "stdio" } }), false);
});

test("addClaude keeps the stored config's own keys under the regenerated config", async () => {
  const calls = [];
  const run = async (_command, args) => (calls.push(args), { stdout: "", stderr: "" });
  const def = { name: "linear", type: "http", url: "https://x", headers: {} };
  await addClaude({ command: "/bin/claude", def, extra: { oauth: { clientId: "c" }, timeout: 5, url: "https://stale" }, run });
  assert.deepEqual(JSON.parse(calls[0][3]), { oauth: { clientId: "c" }, timeout: 5, type: "http", url: "https://x" });
});
