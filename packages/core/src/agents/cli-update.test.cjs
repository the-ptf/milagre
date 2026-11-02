const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { runCliUpdate, linkNewestClaudeVersion } = require("./cli-update.cjs");

test("runCliUpdate: claude returns immediately if linkVersion finds compliant version", async () => {
  const executed = [];
  const execImpl = (cmd, opts, callback) => {
    executed.push(cmd);
    callback(null, "", "");
  };
  const inspect = async () => ({ command: "/bin/claude", version: "2.1.287" });
  const linkVersion = () => true;

  const result = await runCliUpdate("claude", { execImpl, inspect, linkVersion });
  assert.equal(result.ok, true);
  assert.equal(result.version, "2.1.287");
  assert.deepEqual(executed, []);
});

test("runCliUpdate: claude install --force latest succeeds", async () => {
  const executed = [];
  let inspections = 0;
  const execImpl = (cmd, opts, callback) => {
    executed.push(cmd);
    callback(null, "Done", "");
  };
  const inspect = async () => {
    inspections += 1;
    if (inspections === 1) {
      return { command: "/bin/claude", version: "2.1.285", problem: "Milagre needs Claude Code 2.1.286 or later" };
    }
    return { command: "/bin/claude", version: "2.1.287" };
  };
  const linkVersion = () => {};

  const result = await runCliUpdate("claude", { execImpl, inspect, linkVersion });
  assert.equal(result.ok, true);
  assert.equal(result.version, "2.1.287");
  assert.deepEqual(executed, ["claude install --force latest"]);
});

test("runCliUpdate: claude falls back to install.sh latest", async () => {
  const executed = [];
  let inspections = 0;
  const execImpl = (cmd, opts, callback) => {
    executed.push(cmd);
    callback(null, "Done", "");
  };
  const inspect = async () => {
    inspections += 1;
    if (inspections <= 2) {
      return { command: "/bin/claude", version: "2.1.285", problem: "Milagre needs Claude Code 2.1.286 or later" };
    }
    return { command: "/bin/claude", version: "2.1.287" };
  };
  const linkVersion = () => {};

  const result = await runCliUpdate("claude", { execImpl, inspect, linkVersion });
  assert.equal(result.ok, true);
  assert.equal(result.version, "2.1.287");
  assert.deepEqual(executed, ["claude install --force latest", "curl -fsSL https://claude.ai/install.sh | bash -s latest"]);
});

test("runCliUpdate: codex update succeeds", async () => {
  const executed = [];
  const execImpl = (cmd, opts, callback) => {
    executed.push(cmd);
    callback(null, "Updated codex", "");
  };
  const inspect = async () => ({ command: "/bin/codex", version: "0.158.0" });

  const result = await runCliUpdate("codex", { execImpl, inspect });
  assert.equal(result.ok, true);
  assert.equal(result.version, "0.158.0");
  assert.deepEqual(executed, ["codex update"]);
});

test("runCliUpdate: returns error when CLI remains broken or outdated", async () => {
  const execImpl = (cmd, opts, callback) => callback(new Error("fail"), "", "failed");
  const inspect = async () => ({ command: "/bin/codex", version: "0.150.0", problem: "Still too old" });

  const result = await runCliUpdate("codex", { execImpl, inspect });
  assert.equal(result.ok, false);
  assert.equal(result.error, "Still too old");
});

test("linkNewestClaudeVersion: symlinks highest compliant version", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "claude-link-test-"));
  const versionsDir = path.join(tempHome, ".local/share/claude/versions");
  fs.mkdirSync(versionsDir, { recursive: true });
  fs.writeFileSync(path.join(versionsDir, "2.1.287"), "bin287");
  fs.writeFileSync(path.join(versionsDir, "2.1.289"), "bin289");
  fs.writeFileSync(path.join(versionsDir, "2.1.286"), "bin286");

  const success = linkNewestClaudeVersion(tempHome);
  assert.equal(success, true);
  const targetBin = path.join(tempHome, ".local/bin/claude");
  assert.equal(fs.readlinkSync(targetBin), path.join(versionsDir, "2.1.289"));

  fs.rmSync(tempHome, { recursive: true, force: true });
});

test("runCliUpdate: antigravity installs the pinned Antigravity release when nothing, or another version, is active", async () => {
  const progress = [];
  const antigravity = (current, update) => ({
    resolve: () => current,
    updateAvailable: () => update,
    install: async ({ onProgress }) => {
      onProgress?.({ phase: "download", received: 1, total: 2 });
      return { version: "1.3.0", changed: true };
    },
  });
  assert.deepEqual(await runCliUpdate("antigravity", { antigravity: antigravity(null, true), onProgress: (event) => progress.push(event) }), {
    ok: true,
    version: "1.3.0",
  });
  assert.deepEqual(progress, [{ phase: "download", received: 1, total: 2 }]);
  assert.deepEqual(await runCliUpdate("antigravity", { antigravity: antigravity({ version: "1.2.0" }, true) }), { ok: true, version: "1.3.0" });
  // Already on the pinned release: nothing to download.
  const current = { ...antigravity({ version: "1.3.0" }, false), install: async () => assert.fail("not installed again") };
  assert.deepEqual(await runCliUpdate("antigravity", { antigravity: current }), { ok: true, version: "1.3.0" });
});

test("runCliUpdate: a failed Antigravity install reports its message and the version still active", async () => {
  const antigravity = {
    resolve: () => ({ version: "1.2.0" }),
    updateAvailable: () => true,
    install: async () => {
      throw new Error("The Antigravity download doesn't match its checksum, so it was discarded.");
    },
  };
  assert.deepEqual(await runCliUpdate("antigravity", { antigravity }), {
    ok: false,
    version: "1.2.0",
    error: "The Antigravity download doesn't match its checksum, so it was discarded.",
  });
  assert.equal((await runCliUpdate("antigravity", {})).ok, false);
});

test("an advertised Claude upgrade runs even when the installed CLI meets the minimum", async () => {
  const commands = [];
  let version = "2.1.288";
  const result = await runCliUpdate("claude", {
    targetVersion: "2.1.300",
    platform: "darwin",
    linkVersion() {},
    inspect: async () => ({ command: "/bin/claude", version }),
    execImpl: (cmd, _opts, callback) => {
      commands.push(cmd);
      version = "2.1.300";
      callback(null, "", "");
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(commands, ["claude install --force latest"]);
});

test("a failed Codex upgrade cannot report success because the old version still runs", async () => {
  const result = await runCliUpdate("codex", {
    targetVersion: "0.163.0",
    platform: "darwin",
    inspect: async () => ({ command: "/bin/codex", version: "0.160.0" }),
    execImpl: (_cmd, _opts, callback) => callback(new Error("permission denied"), "", ""),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /permission denied/);
});

test("Codex latest upgrade uses npm and verifies the newly activated version on Windows", async () => {
  let version = "0.160.0";
  const commands = [];
  const result = await runCliUpdate("codex", {
    targetVersion: "0.163.0",
    platform: "win32",
    resolve: async () => "C:\\npm.cmd",
    inspect: async () => ({ command: "C:\\codex.cmd", version }),
    execFileImpl: (file, args, opts, callback) => {
      commands.push([file, args]);
      version = "0.163.0";
      callback(null, "", "");
    },
  });
  assert.equal(result.ok, true);
  assert.match(JSON.stringify(commands), /@openai\/codex@latest/);
});

test("a Codex release upgrade runs codex update through its own install first, with its folder first on PATH", async () => {
  let version = "0.163.0";
  const calls = [];
  const result = await runCliUpdate("codex", {
    targetVersion: "0.165.0",
    platform: "darwin",
    inspect: async () => ({ command: "/opt/homebrew/bin/codex", version }),
    execImpl: (cmd, opts, callback) => {
      calls.push({ cmd, first: opts.env.PATH.split(":")[0] });
      version = "0.165.0";
      callback(null, "", "");
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ cmd: "/opt/homebrew/bin/codex update", first: "/opt/homebrew/bin" }]);
});

test("when codex update leaves the old release, npm runs next and the error names the codex still on PATH", async () => {
  const commands = [];
  const result = await runCliUpdate("codex", {
    targetVersion: "0.165.0",
    platform: "darwin",
    inspect: async () => ({ command: "/Users/me/Library/Application Support/bin/codex", version: "0.163.0" }),
    execImpl: (cmd, _opts, callback) => {
      commands.push(cmd);
      callback(null, "", "");
    },
  });
  assert.deepEqual(commands, ["'/Users/me/Library/Application Support/bin/codex' update", "npm install -g @openai/codex@latest"]);
  assert.equal(result.ok, false);
  assert.match(result.error, /codex at \/Users\/me\/Library\/Application Support\/bin\/codex is still 0\.163\.0/);
});

test("a missing Codex comes from the official installer without prompts, then npm", async () => {
  const executed = [];
  const execImpl = (cmd, opts, callback) => {
    executed.push({ cmd, quiet: opts.env.CODEX_NON_INTERACTIVE, timeout: opts.timeout });
    callback(new Error("failed"), "", "curl: (6) Could not resolve host");
  };
  const inspect = async () => ({ command: null, version: null, problem: "Milagre couldn't find Codex." });
  const result = await runCliUpdate("codex", { execImpl, inspect, refresh() {}, platform: "darwin" });
  assert.deepEqual(
    executed.map((call) => call.cmd),
    ["curl -fsSL https://chatgpt.com/codex/install.sh | sh", "npm install -g @openai/codex@latest"],
  );
  assert.equal(executed[0].quiet, "1");
  assert.ok(executed[0].timeout > 120_000);
  assert.deepEqual(result, { ok: false, version: null, error: "curl: (6) Could not resolve host" });
});

test("a missing Claude skips its own commands and runs the official installer", async () => {
  const executed = [];
  let inspections = 0;
  const execImpl = (cmd, opts, callback) => {
    executed.push(cmd);
    callback(null, "", "");
  };
  const inspect = async () => (++inspections === 1 ? { command: null, problem: "missing" } : { command: "/Users/me/.local/bin/claude", version: "2.1.300" });
  const result = await runCliUpdate("claude", { execImpl, inspect, linkVersion() {}, refresh() {}, platform: "darwin" });
  assert.deepEqual(result, { ok: true, version: "2.1.300" });
  assert.deepEqual(executed, ["curl -fsSL https://claude.ai/install.sh | bash -s latest"]);
});

test("PATH takes in the installer's new folder before the CLI is looked for again", async () => {
  const order = [];
  const execImpl = (cmd, opts, callback) => {
    order.push("install");
    callback(null, "", "");
  };
  let inspections = 0;
  const inspect = async () => {
    order.push("inspect");
    return ++inspections === 1 ? { command: null, problem: "missing" } : { command: "/x/codex", version: "0.160.0" };
  };
  await runCliUpdate("codex", { execImpl, inspect, refresh: () => order.push("refresh"), platform: "darwin" });
  assert.deepEqual(order, ["inspect", "install", "refresh", "inspect"]);
});

test("Windows installs a missing CLI with the official PowerShell installer from System32", async () => {
  for (const [name, script] of [
    ["claude", "irm https://claude.ai/install.ps1 | iex"],
    ["codex", "irm https://chatgpt.com/codex/install.ps1 | iex"],
  ]) {
    const calls = [];
    let inspections = 0;
    const result = await runCliUpdate(name, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      inspect: async () => (++inspections === 1 ? { problem: "missing" } : { version: "9.9.9" }),
      resolve: async () => null,
      refresh() {},
      execFileImpl(file, args, options, done) {
        calls.push({ file, args, options });
        done(null, "", "");
      },
    });
    assert.deepEqual(result, { ok: true, version: "9.9.9" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, path.win32.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    assert.deepEqual(calls[0].args, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]);
    assert.equal(calls[0].options.env.CODEX_NON_INTERACTIVE, "1");
    assert.ok(!calls[0].options.shell);
  }
});
