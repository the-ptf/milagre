const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveExecutable, refreshInstallPath, loadLoginEnvironment } = require("./agents/environment.cjs");

test("Windows real Git worktrees preserve persisted Chat and provider session identities", { skip: process.platform !== "win32" }, async (t) => {
  const { execFileSync } = require("node:child_process");
  const { createGit } = require("./git/client.cjs");
  const { reconcileState, emptyState } = require("./project-state.cjs");
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "milagre git identity ")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  execFileSync("git", ["init", "-b", "main", directory], { stdio: "ignore" });
  const saved = {
    ...emptyState("shop"),
    next_id: 4,
    worktrees: { 1: { id: 1, project_id: 1, path: directory, name: "main" } },
    sessions: { 2: { id: 2, worktree_id: 1, title: "Saved chat", agent_name: "main", native_session_id: "existing-provider-session" } },
    messages: [{ id: 3, session_id: 2, body: "Existing conversation survives" }],
  };
  const raw = execFileSync("git", ["-C", directory, "worktree", "list", "--porcelain", "-z"], { encoding: "utf8" });
  const gitPath = raw
    .split("\0")
    .find((field) => field.startsWith("worktree "))
    ?.slice(9);
  assert.ok(gitPath, JSON.stringify({ directory, raw }));
  assert.equal(fs.realpathSync.native(gitPath), directory, JSON.stringify({ directory, gitPath, raw }));
  const listed = await createGit().worktreeList(directory);
  assert.equal(listed[0].path, directory, JSON.stringify({ directory, gitPath, listed, raw }));
  const reloaded = reconcileState(saved, "shop", listed);
  assert.equal(reloaded, saved);
  saved.worktrees[1].path = directory.replaceAll("\\", "/");
  const migrated = reconcileState(saved, "shop", listed);
  assert.deepEqual(migrated.sessions, saved.sessions);
  assert.deepEqual(migrated.messages, saved.messages);
  assert.equal(migrated.worktrees[1].path, directory);
  assert.equal(migrated.next_id, 4);
});

test("Windows PowerShell helpers use only OS modules while preserving other environment variables", () => {
  const { powershell, powershellEnvironment } = require("./private-files.cjs");
  const original = { pSmOdUlEpAtH: "C:\\Program Files\\PowerShell\\7\\Modules", PSModulePath: "C:\\project\\modules", Path: "C:\\tools", CUSTOM: "kept" };
  const environment = powershellEnvironment(original);
  assert.equal(environment.PSModulePath, path.win32.join(path.win32.dirname(powershell()), "Modules"));
  assert.equal(environment.pSmOdUlEpAtH, undefined);
  assert.equal(environment.Path, original.Path);
  assert.equal(environment.CUSTOM, "kept");
  assert.equal(original.PSModulePath, "C:\\project\\modules");
});

test("Windows job keeper isolates PowerShell modules and restores the target environment before launch", () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const { powershellEnvironment } = require("./private-files.cjs");
  const { spawnWindowsJob } = require("./agents/windows-job.cjs");
  const keeper = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const env = { psmodulepath: "C:\\Program Files\\PowerShell\\7\\Modules", CUSTOM: "agent-value" };
  spawnWindowsJob("C:\\node.exe", [], { env }, (_file, _args, options) => {
    assert.deepEqual(options.env.PSModulePath, powershellEnvironment(env).PSModulePath);
    assert.equal(options.env.psmodulepath, undefined);
    assert.equal(options.env.CUSTOM, "agent-value");
    const payload = JSON.parse(Buffer.from(options.env.MILAGRE_WINDOWS_JOB_SPEC, "base64"));
    assert.equal(payload.targetPSModulePath, env.psmodulepath);
    return keeper;
  });
  assert.equal(env.PSModulePath, undefined);
});

test(
  "Windows native helpers survive inherited PowerShell 7 modules and preserve the application module path",
  { skip: process.platform !== "win32", timeout: 45000 },
  async (t) => {
    const { once } = require("node:events");
    const { windowsAcl } = require("./private-files.cjs");
    const { spawnCommand } = require("./agents/command.cjs");
    const { killTree } = require("./agents/process-tree.cjs");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-ps7-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const pollution = path.win32.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "Modules");
    if (process.env.CI)
      assert.ok(fs.existsSync(path.win32.join(pollution, "Microsoft.PowerShell.Security")), "CI fixture must use actual PowerShell 7 modules");
    const before = process.env.PSModulePath;
    process.env.PSModulePath = pollution;
    try {
      windowsAcl(directory, { mode: "protect" });
      windowsAcl(directory);
      const child = spawnCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env.PSModulePath))"], {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      t.after(() => killTree(child));
      const output = [];
      child.stdout.on("data", (chunk) => output.push(chunk));
      await once(child, "close");
      assert.equal(child.exitCode, 0);
      assert.equal(JSON.parse(Buffer.concat(output)), pollution);
    } finally {
      if (before === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = before;
    }
  },
);

test("Windows private directories can be protected repeatedly without elevated privileges", { skip: process.platform !== "win32" }, (t) => {
  const { preparePrivateDirectory, assertPrivate, windowsAcl } = require("./private-files.cjs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-private-repeat-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  for (let attempt = 0; attempt < 3; attempt++) {
    preparePrivateDirectory(directory);
    assertPrivate(directory);
  }
  const file = path.join(directory, "token");
  fs.writeFileSync(file, "fixture");
  for (let attempt = 0; attempt < 3; attempt++) {
    windowsAcl(file, { mode: "protect" });
    assertPrivate(file);
  }
  assert.equal(fs.readFileSync(file, "utf8"), "fixture");
});

test("Windows executable lookup searches only absolute PATH directories and prefers PATHEXT launchers", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "codex"), "#!/bin/sh");
  fs.writeFileSync(path.join(root, "codex.cmd"), "npm Windows shim");
  const env = { Path: `${root};.;relative`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
  assert.equal(await resolveExecutable("codex", { platform: "win32", env }), path.join(root, "codex.cmd"));
  fs.unlinkSync(path.join(root, "codex.cmd"));
  assert.equal(await resolveExecutable("codex", { platform: "win32", env }), null);
});

test("Windows executable lookup excludes Project cwd and malicious extensionless npm twins", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-untrusted-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const trusted = path.join(root, "trusted");
  fs.mkdirSync(project);
  fs.mkdirSync(trusted);
  fs.writeFileSync(path.join(project, "codex.cmd"), "untrusted");
  fs.writeFileSync(path.join(trusted, "codex"), "#!/bin/sh");
  assert.equal(await resolveExecutable("codex", { platform: "win32", env: { PATH: `;.;${trusted}`, PATHEXT: ".EXE;.CMD" }, cwd: project }), null);
});

test("Windows PATH preserves Path casing and semicolon separators", async () => {
  const target = { Path: "C:\\Windows;C:\\npm" };
  refreshInstallPath({ target, platform: "win32", dirs: () => ["C:\\npm", "C:\\Users\\me\\.local\\bin"] });
  assert.equal(target.Path, "C:\\Windows;C:\\npm;C:\\Users\\me\\.local\\bin");
  assert.equal(target.PATH, undefined);
  await loadLoginEnvironment({ target, platform: "win32", dirs: () => ["C:\\tools"] });
  assert.ok(target.Path.endsWith(";C:\\tools"));
});

test("Linux without SHELL falls back to /bin/sh", async () => {
  let shell;
  await loadLoginEnvironment({
    target: {},
    platform: "linux",
    userShell: () => null,
    readShellEnv: async (options) => {
      shell = options.shell;
      return null;
    },
    dirs: () => [],
  });
  assert.equal(shell, "/bin/sh");
});

test("npm cmd shims run their JavaScript entry directly with literal arguments", () => {
  const { commandInvocation } = require("./agents/command.cjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-shim-"));
  try {
    const shim = path.join(root, "codex.cmd");
    const entry = path.join(root, "node_modules/codex/bin/codex.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "");
    fs.writeFileSync(shim, '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\codex\\bin\\codex.js" %*\r\n');
    const args = ["a & echo injected", "%PATH%", '"quoted"'];
    const invocation = commandInvocation(shim, args, { platform: "win32" });
    assert.equal(invocation.file, process.execPath);
    assert.deepEqual(invocation.args, [entry, ...args]);
    fs.writeFileSync(shim, "@echo dangerous %*");
    assert.throws(() => commandInvocation(shim, args, { platform: "win32" }), /Unsupported Windows command wrapper/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows ACL operations encode paths and fail closed on command errors", () => {
  const { windowsAcl } = require("./private-files.cjs");
  let script;
  windowsAcl("C:\\test'; whoami\\profile", {
    mode: "protect",
    execFileSyncImpl(file, args, options) {
      assert.match(file, /powershell\.exe$/i);
      assert.deepEqual(options.env, require("./private-files.cjs").powershellEnvironment());
      assert.ok(args.includes("-EncodedCommand"));
      script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      return "";
    },
  });
  assert.ok(script.includes("SetAccessRuleProtection"));
  assert.ok(script.includes("S-1-5-18"));
  assert.ok(!script.includes("C:\\test'; whoami"));
  assert.throws(
    () =>
      windowsAcl("C:\\private", {
        execFileSyncImpl() {
          throw new Error("ACL denied");
        },
      }),
    /ACL denied/,
  );
});

test("Windows process creation times preserve PID reuse protection and unknown owners stay live", () => {
  const { processStartTime } = require("./ownership.cjs");
  let script;
  assert.equal(
    processStartTime(123, {
      platform: "win32",
      execFileSyncImpl(_file, args, options) {
        assert.deepEqual(options.env, require("./private-files.cjs").powershellEnvironment());
        script = Buffer.from(args.at(-1), "base64").toString("utf16le");
        return "2026-01-02T03:04:05.1230000Z";
      },
    }),
    Date.parse("2026-01-02T03:04:05.123Z"),
  );
  assert.ok(script.includes("Get-Process -Id 123"));
  assert.equal(
    processStartTime(123, {
      platform: "win32",
      execFileSyncImpl() {
        throw new Error("access denied");
      },
    }),
    null,
  );
  assert.equal(processStartTime("123; exit", { platform: "win32" }), null);
});

test("Windows shutdown refuses an exited or already killed child before looking up its PID", async () => {
  const { killTree } = require("./agents/process-tree.cjs");
  for (const child of [
    { pid: 321, exitCode: 0 },
    { pid: 321, exitCode: null, killed: true },
  ]) {
    await killTree(child, {
      platform: "win32",
      execFileImpl() {
        assert.fail("An obsolete child must not cause a PID lookup");
      },
    });
  }
});

test("Windows shutdown pins validated process handles before termination", async () => {
  const { killTree } = require("./agents/process-tree.cjs");
  let script;
  await killTree(
    { pid: 321, exitCode: null, killed: false },
    {
      platform: "win32",
      execFileImpl(file, args, options, callback) {
        assert.match(file, /powershell.exe$/i);
        assert.deepEqual(options.env, require("./private-files.cjs").powershellEnvironment());
        script = Buffer.from(args.at(-1), "base64").toString("utf16le");
        callback(null, "");
      },
    },
  );
  assert.ok(script.includes("CreationDate"));
  assert.ok(script.includes(".Handle"));
  assert.ok(script.includes("$current.CreationDate"));
  assert.ok(script.includes(".Kill()"));
  assert.ok(script.includes("[Console]::ReadLine()"));
  assert.ok(!script.includes("Stop-Process"));
});

test("Linux and Windows editor detection uses installed CLIs instead of app bundles", async () => {
  const { detectEditors } = require("./editors.cjs");
  for (const platform of ["linux", "win32"]) {
    const checked = [];
    const result = await detectEditors({
      platform,
      fs: {
        async access(file) {
          checked.push(file);
        },
      },
      which: async (name) => (name === "code" ? "/cli/code" : null),
    });
    assert.deepEqual(result, [{ id: "vscode", name: "Visual Studio Code", appPath: null, cli: "/cli/code" }]);
    assert.deepEqual(checked, []);
  }
});

test("Windows tracked port processes are forgotten when their PID is reused", async () => {
  const { PortWatcher } = require("./agents/ports.cjs");
  let rows = "10 1 10 @100 root.exe\n20 10 20 @200 node.exe";
  let roots = new Map([["chat", { pid: 10 }]]);
  const watcher = new PortWatcher({
    platform: "win32",
    roots: () => roots,
    publish() {},
    exec: async (command) => (command === "ps" ? rows : "p20\ncnode\nn127.0.0.1:3000"),
  });
  try {
    await watcher.poll();
    assert.equal(watcher.snapshot().chat[0].pid, 20);
    roots = new Map();
    rows = "20 1 20 @999 unrelated.exe";
    await watcher.poll({ fresh: true });
    assert.deepEqual(watcher.snapshot(), {});
  } finally {
    watcher.close();
  }
});

test("Windows native port detection stops only a current Chat listener", { skip: process.platform !== "win32" }, async (t) => {
  const { spawn } = require("node:child_process");
  const { killTree } = require("./agents/process-tree.cjs");
  const { PortWatcher } = require("./agents/ports.cjs");
  const grandchild =
    'const net=require("node:net");const server=net.createServer();server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({pid:process.pid,port:server.address().port})))';
  const parent = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','pipe','inherit']});c.stdout.pipe(process.stdout);setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, ["-e", parent], { stdio: ["ignore", "pipe", "inherit"] });
  const listener = JSON.parse(String(await new Promise((resolve) => child.stdout.once("data", resolve))));
  const watcher = new PortWatcher({ roots: () => new Map([["chat", { pid: child.pid }]]), publish() {} });
  t.after(async () => {
    watcher.close();
    await killTree(child);
  });
  await watcher.poll({ fresh: true });
  assert.ok(watcher.snapshot().chat?.some((port) => port.port === listener.port && port.pid === listener.pid));
  assert.equal(await watcher.stopPort("other-chat", listener.pid), false);
  assert.equal(await watcher.stopPort("chat", listener.pid), true);
  assert.ok(!watcher.snapshot().chat?.some((port) => port.pid === listener.pid));
  assert.doesNotThrow(() => process.kill(child.pid, 0));
});

test("Windows port stop kills the current owned command ancestor and excludes the agent", async () => {
  const { PortWatcher } = require("./agents/ports.cjs");
  const killed = [];
  const rows = "10 1 10 @100 agent.exe\n20 10 20 @200 cmd.exe\n30 20 30 @300 watcher.exe\n40 30 40 @400 server.exe";
  const watcher = new PortWatcher({
    platform: "win32",
    roots: () => new Map([["chat", { pid: 10 }]]),
    publish() {},
    exec: async (command) => (command === "ps" ? rows : "p40\ncserver\nn127.0.0.1:3000"),
    stopWindowsTree: async (pid, _exec, options) => {
      killed.push({ pid, options });
      return true;
    },
  });
  try {
    await watcher.poll();
    assert.equal(await watcher.stopPort("chat", 40), true);
    assert.equal(killed[0].pid, 20);
    assert.equal(killed[0].options.expectedStartTime, "200");
    assert.equal(await watcher.stopPort("other", 40), false);
    assert.equal(killed.length, 1);
  } finally {
    watcher.close();
  }
});

test("Windows CLI updates resolve absolute PATH commands and keep arguments out of the shell", async () => {
  const { runCliUpdate } = require("./agents/cli-update.cjs");
  const calls = [];
  let inspections = 0;
  const result = await runCliUpdate("claude", {
    platform: "win32",
    inspect: async () => (++inspections === 1 ? { problem: "old version" } : { version: "2.1.288" }),
    resolve: async (name) => `/trusted/${name}.exe`,
    execFileImpl(file, args, options, done) {
      calls.push({ file, args, options });
      done(null, "", "");
    },
    execImpl() {
      assert.fail("Updates must not call a Windows command shell");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls[0].file, "/trusted/claude.exe");
  assert.deepEqual(calls[0].args, ["install", "--force", "latest"]);
  assert.ok(!calls[0].options.shell);
});

test("providers do not advertise retained PIDs after the child exits or is killed", () => {
  const { CodexSession } = require("./agents/codex-provider.cjs");
  const { ClaudeSession } = require("./agents/claude-provider.cjs");
  const codex = new CodexSession({ cwd: os.tmpdir(), emit() {} });
  const claude = new ClaudeSession({ cwd: os.tmpdir(), emit() {} });
  for (const child of [
    { pid: 123, exitCode: 0 },
    { pid: 123, exitCode: null, signalCode: "SIGTERM" },
    { pid: 123, exitCode: null, killed: true },
  ]) {
    codex.rpc = { child };
    claude.child = child;
    assert.equal(codex.pid, null);
    assert.equal(claude.pid, null);
  }
});

test("Windows stops are aborted if the original child exits while handles are being pinned", async () => {
  const { EventEmitter } = require("node:events");
  const { killTree } = require("./agents/process-tree.cjs");
  const child = { pid: 123, exitCode: null, killed: false };
  let approval;
  const stopped = await killTree(child, {
    platform: "win32",
    execFileImpl(_file, _args, _options, done) {
      const stdout = new EventEmitter();
      const stdin = new EventEmitter();
      stdin.end = (value) => {
        approval = value;
        done(null, "PINNED\n");
      };
      queueMicrotask(() => {
        child.exitCode = 0;
        stdout.emit("data", Buffer.from("PINNED\n"));
      });
      return { stdin, stdout };
    },
  });
  assert.equal(approval, "ABORT\n");
  assert.equal(stopped, false);
});

test("Windows native termination rejects a mismatched creation identity", { skip: process.platform !== "win32" }, async (t) => {
  const { spawn } = require("node:child_process");
  const { once } = require("node:events");
  const { killTree, killWindowsTree } = require("./agents/process-tree.cjs");
  const child = spawn(process.execPath, ["-e", 'console.log("ready"); setInterval(()=>{},1000)'], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => killTree(child));
  await once(child.stdout, "data");
  assert.equal(await killWindowsTree(child.pid, undefined, { expectedStartTime: "1" }), false);
  assert.doesNotThrow(() => process.kill(child.pid, 0));
});

test("Windows job facade preserves large output, strips control frames and closes retained orphan jobs", async () => {
  const { EventEmitter, once } = require("node:events");
  const { PassThrough } = require("node:stream");
  const { spawnWindowsJob, closeWindowsJob } = require("./agents/windows-job.cjs");
  const keeper = new EventEmitter();
  Object.assign(keeper, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  let payload;
  let killed = false;
  keeper.kill = () => {
    killed = true;
    keeper.signalCode = "SIGKILL";
    keeper.emit("exit", null, "SIGKILL");
    keeper.emit("close", null, "SIGKILL");
    return true;
  };
  const child = spawnWindowsJob("C:\\node.exe", ["-e", "script"], {}, (_file, _args, options) => {
    payload = JSON.parse(Buffer.from(options.env.MILAGRE_WINDOWS_JOB_SPEC, "base64"));
    return keeper;
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  const ended = once(child, "exit");
  const closed = once(child, "close");
  keeper.stderr.write(payload.marker + "PID:123\n");
  const body = Buffer.alloc(4 * 1024 * 1024, "x");
  keeper.stdout.write(body);
  keeper.stderr.write(payload.marker + "EXIT:0\n");
  await ended;
  assert.equal(child.pid, 123);
  assert.equal(child.exitCode, 0);
  assert.equal(killed, false);
  keeper.stdout.write(payload.marker.slice(0, 7));
  keeper.stdout.write(payload.marker.slice(7) + "DRAIN:0\n");
  await closed;
  assert.deepEqual(Buffer.concat(chunks), body);
  await closeWindowsJob(child);
  assert.equal(killed, true);
});

test("Windows native job handles literal arguments and releases an empty job", { skip: process.platform !== "win32" }, async () => {
  const { once } = require("node:events");
  const { spawnCommand } = require("./agents/command.cjs");
  const { isWindowsJobActive } = require("./agents/windows-job.cjs");
  const args = ["with space", 'quote"', "C:\\path with space\\", "& echo injected", "%PATH%", "é"];
  const child = spawnCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  await once(child, "close");
  assert.deepEqual(JSON.parse(Buffer.concat(chunks)), args);
  for (let i = 0; i < 100 && isWindowsJobActive(child); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(isWindowsJobActive(child), false);
});

test("Windows job verbatim cmd arguments preserve embedded command quotes", () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const { spawnWindowsJob } = require("./agents/windows-job.cjs");
  let payload;
  const keeper = new EventEmitter();
  Object.assign(keeper, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const command = '"C:\\node with spaces\\node.exe" -e "console.log(\'a & b\')"';
  spawnWindowsJob("C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", `"${command}"`], { windowsVerbatimArguments: true }, (_file, _args, options) => {
    payload = JSON.parse(Buffer.from(options.env.MILAGRE_WINDOWS_JOB_SPEC, "base64"));
    return keeper;
  });
  assert.equal(payload.commandLine, `C:\\Windows\\System32\\cmd.exe /d /s /c "${command}"`);
  assert.ok(!payload.commandLine.includes('\\"console.log'));
});

test("Windows native setup preserves Node quotes, spaced paths and command metacharacters", { skip: process.platform !== "win32" }, async (t) => {
  const fsp = require("node:fs/promises");
  const { runSetupCommand } = require("./worktree-setup.cjs");
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "milagre setup & "));
  // The empty Windows job keeper finishes its final accounting poll after the
  // application's close event and briefly retains its working directory.
  t.after(() => fsp.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const result = await runSetupCommand({
    cwd,
    timeoutMs: 30000,
    command: `"${process.execPath}" -e "process.stdout.write('a & b'); require('node:fs').writeFileSync('file with spaces & symbols.txt','ok')"`,
  });
  assert.equal(result.status, "done", result.output || result.error);
  assert.equal(result.output, "a & b");
  assert.equal(await fsp.readFile(path.join(cwd, "file with spaces & symbols.txt"), "utf8"), "ok");
});

test("Windows native launch binds its kill-on-close job atomically at CreateProcess", () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const { spawnWindowsJob } = require("./agents/windows-job.cjs");
  const keeper = new EventEmitter();
  Object.assign(keeper, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let source;
  spawnWindowsJob("C:\\node.exe", [], {}, (_file, args) => {
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    source = Buffer.from(/FromBase64String\('([^']+)'\)/.exec(script)[1], "base64").toString("utf8");
    return keeper;
  });
  assert.ok(source.includes("InitializeProcThreadAttributeList"));
  assert.ok(source.includes("UpdateProcThreadAttribute"));
  assert.ok(source.includes("0x0002000D"));
  assert.ok(source.includes("0x08080004"));
  assert.ok(!source.includes("AssignProcessToJobObject"));
});

test("fixture startup waits report early launcher failure and timeout stderr", async () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const { waitForOutput } = require("./agents/test-helpers.cjs");
  const fixture = () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
  const failed = fixture();
  const failure = waitForOutput(failed, { timeoutMs: 50 });
  failed.stderr.write("native launch diagnostic");
  failed.emit("close", 1, null);
  await assert.rejects(failure, /Fixture exited before output.*native launch diagnostic/s);
  const stalled = fixture();
  const timeout = waitForOutput(stalled, { timeoutMs: 10 });
  stalled.stderr.write("startup stalled");
  await assert.rejects(timeout, /Fixture startup timed out.*startup stalled/s);
});

test("Windows job keeper stays attached when callers request a detached application", () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const { spawnWindowsJob } = require("./agents/windows-job.cjs");
  const keeper = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let launch;
  spawnWindowsJob("C:\\node.exe", [], { detached: true }, (_file, _args, options) => {
    launch = options;
    return keeper;
  });
  assert.equal(launch.detached, false);
});

test("Windows TCP listener output accepts PowerShell CRLF line endings", () => {
  const { parseLsof, parsePs } = require("./agents/ports.cjs");
  assert.deepEqual(parseLsof("p20\r\ncnode\r\nn127.0.0.1:3000\r\n"), [{ pid: 20, command: "node", port: 3000, address: "127.0.0.1" }]);
  assert.deepEqual(parsePs("10 1 10 @100 node.exe\r\n20 10 20 @200 node.exe\r\n"), [
    { pid: 10, ppid: 1, pgid: 10, startedAt: "100", command: "node.exe" },
    { pid: 20, ppid: 10, pgid: 20, startedAt: "200", command: "node.exe" },
  ]);
});

test("Windows keeper suppresses PowerShell progress serialization before compiling native code", () => {
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const { spawnWindowsJob } = require("./agents/windows-job.cjs");
  const keeper = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let script;
  let invocation;
  spawnWindowsJob("C:\\node.exe", [], {}, (_file, args) => {
    invocation = args;
    script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    return keeper;
  });
  assert.ok(script.indexOf("$ProgressPreference='SilentlyContinue'") >= 0);
  assert.ok(script.indexOf("$ProgressPreference='SilentlyContinue'") < script.indexOf("Add-Type"));
  assert.equal(invocation[invocation.indexOf("-OutputFormat") + 1], "Text");
});

test("Windows job reports native missing executable errors through ENOENT", { timeout: 100 }, async () => {
  const { EventEmitter, once } = require("node:events");
  const { PassThrough } = require("node:stream");
  const { spawnWindowsJob } = require("./agents/windows-job.cjs");
  const keeper = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  let payload;
  const child = spawnWindowsJob("C:\\missing-cli.exe", [], {}, (_file, _args, options) => {
    payload = JSON.parse(Buffer.from(options.env.MILAGRE_WINDOWS_JOB_SPEC, "base64"));
    return keeper;
  });
  const error = once(child, "error");
  keeper.stderr.write(payload.marker + "ERROR:ENOENT\n");
  assert.equal((await error)[0].code, "ENOENT");
});

test("Windows native missing executable keeps the install/PATH diagnosis", { skip: process.platform !== "win32", timeout: 30000 }, async (t) => {
  const { once } = require("node:events");
  const { spawnCommand } = require("./agents/command.cjs");
  const { killTree } = require("./agents/process-tree.cjs");
  const child = spawnCommand(path.join(os.tmpdir(), "milagre-missing-cli-" + Date.now() + ".exe"), [], { detached: true });
  t.after(() => killTree(child));
  assert.equal((await once(child, "error"))[0].code, "ENOENT");
});
