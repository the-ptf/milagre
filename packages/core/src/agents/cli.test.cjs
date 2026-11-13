const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { MIN_VERSIONS, createCliCache, inspectCli, isAtLeast, parseVersion, runVersion } = require("./cli.cjs");
const os = require("node:os");
const { refreshInstallPath } = require("./environment.cjs");
const { cliBrokenMessage, cliTooOldMessage, missingCliMessage } = require("./events.cjs");

test("reads the version each CLI prints", () => {
  assert.deepEqual(parseVersion("2.1.287 (Claude Code)\n"), [2, 1, 287]);
  assert.deepEqual(parseVersion("codex-cli 0.158.0\n"), [0, 158, 0]);
  assert.deepEqual(parseVersion("codex-cli 0.160.0-alpha.2"), [0, 160, 0]);
  assert.equal(parseVersion("Claude Code"), null);
});

test("compares versions part by part", () => {
  assert.equal(isAtLeast([2, 1, 286], "2.1.286"), true);
  assert.equal(isAtLeast([2, 1, 285], "2.1.286"), false);
  assert.equal(isAtLeast([2, 2, 0], "2.1.286"), true);
  assert.equal(isAtLeast([2, 0, 77], "2.1.286"), false);
  assert.equal(isAtLeast([0, 159, 9], "0.160.0"), false);
  assert.equal(isAtLeast([0, 160, 0], "0.160.0"), true);
  assert.equal(isAtLeast([1, 0, 0], "0.160.0"), true);
});

test("the Claude minimum is the Claude Code release the pinned SDK is built against", () => {
  const sdk = JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8"));
  assert.equal(MIN_VERSIONS.claude, sdk.claudeCodeVersion);
});

test("runs --version and keeps the last line of a failure", async () => {
  const calls = [];
  const ok = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, "codex-cli 0.158.0\n", "");
  };
  assert.deepEqual(await runVersion("/bin/codex", { execFileImpl: ok }), { output: "codex-cli 0.158.0\n" });
  assert.equal(calls.length, 1);
  const [
    {
      file,
      args,
      options: { env, ...options },
    },
  ] = calls;
  assert.deepEqual({ file, args, options }, { file: "/bin/codex", args: ["--version"], options: { encoding: "utf8", timeout: 10000 } });
  // The host's own variables stay with the host (agents/command.cjs).
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  const broken = (file, args, options, callback) =>
    callback(Object.assign(new Error("Command failed: /bin/codex --version"), { code: 127 }), "", "env: node: No such file or directory\n");
  assert.deepEqual(await runVersion("/bin/codex", { execFileImpl: broken }), { error: "env: node: No such file or directory" });
});

test("a missing, outdated or broken CLI comes with the message the turn fails with", async () => {
  const resolve = async (name) => (name === "codex" ? null : "/Users/x/.local/bin/claude");
  assert.deepEqual(await inspectCli("codex", { resolve }), { command: null, version: null, problem: missingCliMessage("codex") });
  assert.deepEqual(await inspectCli("claude", { resolve, version: async () => ({ output: "2.1.200 (Claude Code)" }) }), {
    command: "/Users/x/.local/bin/claude",
    version: "2.1.200",
    problem: cliTooOldMessage("claude", "2.1.200", "2.1.288"),
  });
  assert.deepEqual(await inspectCli("claude", { resolve, version: async () => ({ error: "Killed: 9" }) }), {
    command: "/Users/x/.local/bin/claude",
    version: null,
    problem: cliBrokenMessage("claude", "/Users/x/.local/bin/claude", "Killed: 9"),
  });
  // codex-cli 0.158.0 runs, but doesn't know GPT-6.1 Sol; the picker offers the update.
  const codex = async () => "/opt/homebrew/bin/codex";
  assert.deepEqual(await inspectCli("codex", { resolve: codex, version: async () => ({ output: "codex-cli 0.158.0\n" }) }), {
    command: "/opt/homebrew/bin/codex",
    version: "0.158.0",
    problem: cliTooOldMessage("codex", "0.158.0", "0.160.0"),
  });
});

test("a current CLI, or one whose version can't be read, is used as is", async () => {
  const resolve = async () => "/opt/homebrew/bin/codex";
  assert.deepEqual(await inspectCli("codex", { resolve, version: async () => ({ output: "codex-cli 0.160.0\n" }) }), {
    command: "/opt/homebrew/bin/codex",
    version: "0.160.0",
  });
  assert.deepEqual(await inspectCli("codex", { resolve, version: async () => ({ output: "codex-cli dev build" }) }), {
    command: "/opt/homebrew/bin/codex",
    version: null,
  });
});

test("each CLI is inspected once per run, after the environment, until it has a problem", async () => {
  const order = [];
  let release;
  const environment = new Promise((resolve) => {
    release = resolve;
  });
  const statuses = {
    claude: [{ command: "/c", version: "2.1.287" }],
    codex: [
      { command: null, version: null, problem: "missing" },
      { command: "/x", version: "0.158.0" },
    ],
  };
  const cli = createCliCache({
    ready: () => environment.then(() => order.push("environment")),
    inspect: async (name) => {
      order.push(name);
      return statuses[name].shift();
    },
  });
  const first = Promise.all([cli("claude"), cli("claude"), cli("codex")]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  release();
  const [claude, again, codex] = await first;
  assert.equal(claude, again);
  assert.equal(codex.problem, "missing");
  assert.deepEqual(await cli("codex"), { command: "/x", version: "0.158.0" });
  assert.deepEqual(await cli("claude"), { command: "/c", version: "2.1.287" });
  assert.deepEqual(order, ["environment", "environment", "claude", "codex", "environment", "codex"]);
});

test("a CLI whose installer creates a new folder is found on the next check", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-install-"));
  const target = { PATH: "/usr/bin:/bin" };
  const bin = path.join(home, ".local/bin");
  const dirs = (root) => [path.join(root, ".local/bin")].filter((dir) => fs.existsSync(dir));
  const resolve = async (name) => {
    for (const dir of target.PATH.split(":")) if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
    return null;
  };
  try {
    const cli = createCliCache({
      inspect: (name) => inspectCli(name, { resolve, version: async () => ({ output: "2.1.289 (Claude Code)" }) }),
      refresh: () => refreshInstallPath({ target, platform: "darwin", home, dirs }),
    });
    assert.equal((await cli("claude")).problem, missingCliMessage("claude"));
    // The installer runs: a folder that didn't exist at startup appears, with the CLI in it.
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n");
    assert.deepEqual(await cli("claude"), { command: path.join(bin, "claude"), version: "2.1.289" });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the refresh runs only before looking again at a CLI that had a problem", async () => {
  let refreshed = 0;
  const answers = [
    { command: null, version: null, problem: "missing" },
    { command: "/c", version: "2.1.287" },
  ];
  const cli = createCliCache({
    inspect: async () => answers.shift() ?? { command: "/c", version: "2.1.287" },
    refresh: () => {
      refreshed += 1;
    },
  });
  await cli("claude");
  assert.equal(refreshed, 0);
  await cli("claude");
  assert.equal(refreshed, 1);
  await cli("claude");
  assert.equal(refreshed, 1);
});

test("Antigravity is the Milagre-managed install: no PATH lookup, no --version spawn", async () => {
  const never = () => assert.fail("not looked up on PATH");
  const found = { command: "/d/agy_acp_server.par", harness: "/d/localharness_external", args: [], version: "1.3.0" };
  assert.deepEqual(await inspectCli("antigravity", { resolve: never, version: never, antigravity: { supported: () => true, resolve: () => found } }), {
    command: found.command,
    version: "1.3.0",
    harness: found.harness,
    args: [],
  });
  assert.deepEqual(await inspectCli("antigravity", { antigravity: { supported: () => true, resolve: () => null } }), {
    command: null,
    version: null,
    problem: missingCliMessage("antigravity"),
  });
  assert.match(
    (await inspectCli("antigravity", { antigravity: { supported: () => false, resolve: () => null } })).problem,
    /isn't available on this computer yet/,
  );
  assert.equal((await inspectCli("antigravity", {})).problem, missingCliMessage("antigravity"));
});

test("the CLI cache hands its Antigravity install to inspectCli", async () => {
  const found = { command: "/d/agy_acp_server.par", harness: "/d/h", args: [], version: "1.3.0" };
  const antigravity = { supported: () => true, resolve: () => found };
  const cli = createCliCache({ antigravity });
  assert.equal((await cli("antigravity")).command, found.command);
});
