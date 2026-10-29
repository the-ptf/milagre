const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRuntime } = require("./runtime.cjs");

// Settings › MCP through the runtime's commands, as the desktop bridge and phones reach them: arguments are coerced
// on the way in, and the writes land in <dataDir>/mcp.json.
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-runtime-mcp-")));
  const dataDir = path.join(dir, "data");
  const home = path.join(dir, "home");
  await fs.mkdir(home);
  const events = [];
  const seen = { checks: [], signIns: [], writes: [] };
  const runtime = createRuntime({
    dataDir,
    chatsHome: path.join(dir, "chats"),
    cwd: dir,
    environmentReady: Promise.resolve(),
    titleModels: {},
    agentCli: async () => ({ command: "fixture" }),
    emit: (channel, payload) => events.push([channel, payload]),
    createSession: () => ({ turnActive: false, startTurn: async () => ({ turnId: "t" }), interrupt: async () => {}, close: async () => {} }),
    mcp: {
      home,
      accounts: { snapshot: async () => ({ providers: [{ provider: "claude", accounts: [{ id: "default", label: "Me", state: "ready" }] }] }) },
      routing: { forAccount: async (provider, accountId) => ({ command: `/bin/${provider}`, env: {}, accountId }) },
      checkers: {
        claude: async (options) => {
          seen.checks.push(options.command);
          return [{ name: "pencil", transport: "command", scope: "user", state: "connected", tools: 1, error: null, detail: "pencil" }];
        },
      },
      writers: {
        claude: { add: async (o) => seen.writes.push(["add", o.def.name]), remove: async (o) => seen.writes.push(["remove", o.name]) },
        codex: { read: async () => null },
      },
      signers: { claude: async (o) => (seen.signIns.push(o.name), { ok: true }) },
    },
  });
  t.after(async () => {
    await runtime.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const file = path.join(dataDir, "mcp.json");
  const stored = async () => JSON.parse(await fs.readFile(file, "utf8"));
  return { runtime, events, seen, stored };
}

const linear = { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer s" } };

test("every mcp:* command reaches the MCP module with coerced arguments and writes mcp.json", async (t) => {
  const { runtime, events, seen, stored } = await fixture(t);
  const invoke = (method, args) => runtime.invoke(method, args);

  assert.deepEqual(await invoke("mcp:accounts", []), [{ provider: "claude", accountId: "default", label: "Me" }]);
  const check = await invoke("mcp:check", ["claude", "default"]);
  assert.equal(check.problem, null);
  assert.deepEqual(seen.checks, ["/bin/claude"]);
  // String(): a number is a name like any other, and finds no account.
  assert.equal((await invoke("mcp:check", [7, 8])).problem, "Account not found. Refresh and try again.");

  // previous: null is a new server (previous ?? undefined); extra fields never reach the file.
  await invoke("mcp:save", [{ ...linear, extra: "x" }, "everywhere", null]);
  assert.deepEqual((await stored()).everywhere, [linear]);
  assert.deepEqual(await invoke("mcp:definition", ["linear", "everywhere"]), { ...linear, headers: { Authorization: "••••••" } });

  // A rename over saveUrl sends the mask back; the stored token is kept and the previous name goes.
  await invoke("mcp:saveUrl", [
    { ...linear, name: "linear2", headers: { Authorization: "••••••" } },
    "everywhere",
    { name: "linear", target: "everywhere", junk: 1 },
  ]);
  assert.deepEqual((await stored()).everywhere, [{ ...linear, name: "linear2" }]);
  await assert.rejects(invoke("mcp:saveUrl", [linear, "everywhere", "linear2"]), /Pick where to load it/);
  await assert.rejects(invoke("mcp:saveUrl", [linear, "everywhere", { name: 5, target: "everywhere" }]), /Unknown server name/);

  // on === true: anything but true switches the server off.
  await invoke("mcp:toggle", ["claude", "default", "pencil", "true"]);
  assert.deepEqual((await stored()).off, { "claude:default": ["pencil"] });
  await invoke("mcp:toggle", ["claude", "default", "pencil", true]);
  assert.deepEqual((await stored()).off, {});

  await invoke("mcp:save", [{ name: "p", type: "stdio", command: "p", args: ["--x"], env: {} }, "claude", undefined]);
  assert.deepEqual(seen.writes, [["add", "p"]]);
  await assert.rejects(invoke("mcp:remove", ["-p", "claude"]), /Unknown server name/);
  await invoke("mcp:remove", ["p", "claude"]);
  await invoke("mcp:remove", ["linear2", "everywhere"]);
  assert.deepEqual(seen.writes, [
    ["add", "p"],
    ["remove", "p"],
  ]);
  assert.deepEqual((await stored()).everywhere, []);

  // Targets that aren't an array become none, which ends the row at once.
  events.length = 0;
  assert.deepEqual(await invoke("mcp:signIn", ["linear", "claude"]), { started: true });
  assert.deepEqual(events, [["mcp:changed", { name: "linear", signIn: "failed", error: "Nothing to sign in to.", last: true }]]);
  await invoke("mcp:signIn", ["linear", [{ provider: "claude", accountId: "default" }]]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen.signIns, ["linear"]);
  await invoke("mcp:cancelSignIn", [42]);
});
