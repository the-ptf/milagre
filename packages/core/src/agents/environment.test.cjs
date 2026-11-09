const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { installDirs, loadLoginEnvironment, mergePath, npmGlobalBin, readLoginShellEnv, refreshInstallPath, resolveExecutable } = require("./environment.cjs");

// A stand-in for spawn: `script(child, mark)` plays the shell, given the mark the command line asks it to print.
function fakeShell(script) {
  const calls = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    calls.push({ file, args, options });
    const mark = /'(__MILAGRE_ENV_[0-9a-f]+__)'/.exec(args.at(-1))[1];
    setImmediate(() => script(child, mark));
    return child;
  };
  return { spawnImpl, calls };
}

// A stand-in for the timer: the test fires the timeout itself instead of racing a real one.
function fakeTimers() {
  const timers = [];
  return {
    setTimeoutImpl: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => {
      timer.cleared = true;
    },
    fire: () => timers.filter((timer) => !timer.cleared).forEach((timer) => timer.callback()),
    timers,
  };
}

const envBlock = (vars) =>
  Object.entries(vars)
    .map(([key, value]) => `${key}=${value}\0`)
    .join("");

test("returns the first path which reports", async () => {
  const execFileImpl = (file, args, options, callback) => callback(null, "/opt/homebrew/bin/codex\n/usr/local/bin/codex\n");
  assert.equal(await resolveExecutable("codex", { execFileImpl }), "/opt/homebrew/bin/codex");
});

test("returns null when the CLI isn't installed", async () => {
  const execFileImpl = (file, args, options, callback) => callback(Object.assign(new Error("not found"), { code: 1 }), "");
  assert.equal(await resolveExecutable("codex", { execFileImpl }), null);
});

test("reads the login shell's environment between the marks, past whatever rc files print", async () => {
  const { spawnImpl, calls } = fakeShell((child, mark) => {
    child.stdout.write("Welcome back! __MILAGRE_ENV_0000__\nno newline");
    child.stdout.write(`${mark}${envBlock({ PATH: "/opt/homebrew/bin:/usr/bin", LANG: "en_US.UTF-8", NOTE: "two\nlines" })}${mark}bye\n`);
    child.emit("close", 0);
  });
  const env = await readLoginShellEnv({ shell: "/bin/zsh", env: { HOME: "/Users/x" }, spawnImpl });
  assert.deepEqual(env, { PATH: "/opt/homebrew/bin:/usr/bin", LANG: "en_US.UTF-8", NOTE: "two\nlines" });
  assert.equal(calls[0].file, "/bin/zsh");
  assert.deepEqual(calls[0].args.slice(0, 3), ["-i", "-l", "-c"]);
  assert.match(calls[0].args[3], /^\/usr\/bin\/printf '%s' '__MILAGRE_ENV_[0-9a-f]{16}__'; \/usr\/bin\/env -0; /);
  assert.deepEqual(calls[0].options, { env: { HOME: "/Users/x" }, stdio: ["ignore", "pipe", "ignore"], detached: true });
});

test("gives up on a shell that hangs, and kills its process group", async () => {
  const { spawnImpl } = fakeShell(() => {});
  const killed = [];
  const timers = fakeTimers();
  const promise = readLoginShellEnv({
    shell: "/bin/bash",
    spawnImpl,
    killGroup: (pid) => killed.push(pid),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  timers.fire();
  const env = await promise;
  assert.equal(env, null);
  assert.deepEqual(killed, [4242]);
});

test("a shell that exits without printing the environment gives nothing", async () => {
  const { spawnImpl } = fakeShell((child) => {
    child.stdout.write("exec'd into something else\n");
    child.emit("close", 0);
  });
  assert.equal(await readLoginShellEnv({ shell: "/opt/homebrew/bin/fish", spawnImpl }), null);
});

test("shells that can't run the command line aren't started", async () => {
  const { spawnImpl, calls } = fakeShell(() => {});
  assert.equal(await readLoginShellEnv({ shell: "/opt/homebrew/bin/nu", spawnImpl }), null);
  assert.equal(await readLoginShellEnv({ shell: "", spawnImpl }), null);
  assert.equal(calls.length, 0);
});

test("reads PATH from a real bash login shell", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-shell-"));
  fs.writeFileSync(path.join(home, ".bash_profile"), 'echo "Welcome"\nexport PATH="$HOME/from-profile:$PATH"\nexport MILAGRE_TEST_VAR="hi there"\n');
  try {
    const env = await readLoginShellEnv({ shell: "/bin/bash", env: { HOME: home, PATH: "/usr/bin:/bin" } });
    assert.equal(env.PATH.split(":")[0], path.join(home, "from-profile"));
    assert.equal(env.MILAGRE_TEST_VAR, "hi there");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("merges PATH lists in order, without duplicates or empty entries", () => {
  assert.equal(
    mergePath("/opt/homebrew/bin:/usr/bin::/bin", "/usr/bin:/bin:/usr/sbin:/sbin", ["/Users/x/.local/bin", "/opt/homebrew/bin"]),
    "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/x/.local/bin",
  );
  assert.equal(mergePath(undefined, "/usr/bin:/bin", []), "/usr/bin:/bin");
});

test("lists the install folders that exist, with nvm's default node", () => {
  const present = new Set([
    "/Users/x/.local/bin",
    "/opt/homebrew/bin",
    "/Users/x/.nvm/versions/node",
    "/Users/x/.nvm/versions/node/v24.13.0/bin",
    "/Users/x/.bun/bin",
  ]);
  const deps = (alias) => ({
    exists: (dir) => present.has(dir),
    readdir: () => ["v22.22.0", "v24.2.0", "v24.13.0", ".DS_Store"],
    readFile: () => {
      if (alias === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return `${alias}\n`;
    },
  });
  assert.deepEqual(installDirs("/Users/x", deps("24")), [
    "/Users/x/.local/bin",
    "/opt/homebrew/bin",
    "/Users/x/.nvm/versions/node/v24.13.0/bin",
    "/Users/x/.bun/bin",
  ]);
  present.add("/Users/x/.nvm/versions/node/v22.22.0/bin");
  assert.ok(installDirs("/Users/x", deps("v22.22.0")).includes("/Users/x/.nvm/versions/node/v22.22.0/bin"));
  assert.ok(installDirs("/Users/x", deps("lts/*")).includes("/Users/x/.nvm/versions/node/v24.13.0/bin"));
  assert.ok(installDirs("/Users/x", deps(null)).includes("/Users/x/.nvm/versions/node/v24.13.0/bin"));
});

test("fills in what the app lacks from the login shell, and puts the shell's PATH first", async () => {
  const target = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/x", SHELL: "/bin/zsh", TMPDIR: "/var/folders/app/" };
  const asked = [];
  const readShellEnv = async (options) => {
    asked.push(options.shell);
    return {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      HOME: "/elsewhere",
      TMPDIR: "/tmp/",
      LANG: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "key",
      PWD: "/Users/x",
      OLDPWD: "/",
      SHLVL: "2",
      _: "/usr/bin/env",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
    };
  };
  const result = await loadLoginEnvironment({
    target,
    platform: "darwin",
    home: "/Users/x",
    readShellEnv,
    dirs: () => ["/Users/x/.local/bin", "/opt/homebrew/bin"],
    npmBin: async () => null,
  });
  assert.deepEqual(result, { source: "shell" });
  assert.deepEqual(asked, ["/bin/zsh"]);
  assert.deepEqual(target, {
    PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/x/.local/bin",
    HOME: "/Users/x",
    SHELL: "/bin/zsh",
    TMPDIR: "/var/folders/app/",
    LANG: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "key",
  });
});

test("falls back to the install folders when the shell gives nothing, and fills Windows install folders", async () => {
  const target = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh" };
  const result = await loadLoginEnvironment({
    target,
    platform: "darwin",
    home: "/Users/x",
    readShellEnv: async () => null,
    dirs: () => ["/Users/x/.local/bin", "/opt/homebrew/bin"],
    npmBin: async () => null,
  });
  assert.deepEqual(result, { source: "fallback" });
  assert.equal(target.PATH, "/usr/bin:/bin:/usr/sbin:/sbin:/Users/x/.local/bin:/opt/homebrew/bin");

  const windows = { PATH: "C:\\Windows" };
  assert.deepEqual(
    await loadLoginEnvironment({ target: windows, platform: "win32", dirs: () => [], readShellEnv: async () => assert.fail("no shell on Windows") }),
    { source: "fallback" },
  );
  assert.deepEqual(windows, { PATH: "C:\\Windows" });
});

test("a shell that hangs after printing the environment is still killed at the timeout", async () => {
  const { spawnImpl } = fakeShell((child, mark) => {
    child.stdout.write(`${mark}${envBlock({ PATH: "/opt/homebrew/bin:/usr/bin" })}${mark}`);
  });
  const killed = [];
  const timers = fakeTimers();
  const env = await readLoginShellEnv({
    shell: "/bin/zsh",
    spawnImpl,
    killGroup: (pid) => killed.push(pid),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  // The environment is in, and the timer is still armed: the shell hasn't ended.
  assert.deepEqual(env, { PATH: "/opt/homebrew/bin:/usr/bin" });
  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].cleared, false);
  assert.deepEqual(killed, []);
  timers.fire();
  assert.deepEqual(killed, [4242]);
});

test("a shell that ends in time is not killed", async () => {
  const { spawnImpl } = fakeShell((child, mark) => {
    child.stdout.write(`${mark}${envBlock({ PATH: "/usr/bin" })}${mark}`);
    child.emit("close", 0);
  });
  const killed = [];
  const timers = fakeTimers();
  await readLoginShellEnv({
    shell: "/bin/zsh",
    spawnImpl,
    killGroup: (pid) => killed.push(pid),
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  // Its end disarmed the timer, so a late firing does nothing.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timers.timers[0].cleared, true);
  timers.fire();
  assert.deepEqual(killed, []);
});

test("an app started from a terminal keeps its own PATH first, and the shell's comes after", async () => {
  const target = { PATH: "/Users/x/proj/.venv/bin:/Users/x/.nvm/versions/node/v22.0.0/bin:/usr/bin:/bin", HOME: "/Users/x", SHELL: "/bin/zsh" };
  const readShellEnv = async () => ({ PATH: "/opt/homebrew/bin:/Users/x/.nvm/versions/node/v24.13.0/bin:/usr/bin:/bin" });
  await loadLoginEnvironment({ target, platform: "darwin", home: "/Users/x", readShellEnv, dirs: () => ["/Users/x/.local/bin"], npmBin: async () => null });
  assert.equal(
    target.PATH,
    "/Users/x/proj/.venv/bin:/Users/x/.nvm/versions/node/v22.0.0/bin:/usr/bin:/bin:/opt/homebrew/bin:/Users/x/.nvm/versions/node/v24.13.0/bin:/Users/x/.local/bin",
  );
  const finder = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/Users/x", SHELL: "/bin/zsh" };
  await loadLoginEnvironment({
    target: finder,
    platform: "darwin",
    home: "/Users/x",
    readShellEnv,
    dirs: () => ["/Users/x/.local/bin"],
    npmBin: async () => null,
  });
  assert.equal(finder.PATH, "/opt/homebrew/bin:/Users/x/.nvm/versions/node/v24.13.0/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/x/.local/bin");
});

test("npm's global bin folder goes last on PATH, asked for with the merged PATH", async () => {
  const target = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh" };
  const asked = [];
  await loadLoginEnvironment({
    target,
    platform: "darwin",
    home: "/Users/x",
    readShellEnv: async () => ({ PATH: "/opt/homebrew/bin:/usr/bin" }),
    dirs: () => ["/Users/x/.local/bin"],
    npmBin: async ({ env, home }) => {
      asked.push({ path: env.PATH, home });
      return "/opt/homebrew/Cellar/node/26.5.0_1/bin";
    },
  });
  assert.deepEqual(asked, [{ path: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/x/.local/bin", home: "/Users/x" }]);
  assert.equal(target.PATH, "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/x/.local/bin:/opt/homebrew/Cellar/node/26.5.0_1/bin");
});

test("npm's global bin folder is the prefix's bin, or null when npm doesn't answer", async () => {
  const calls = [];
  const answer =
    (stdout, error = null) =>
    (file, args, options, callback) => {
      calls.push({ file, args, cwd: options.cwd, path: options.env.PATH });
      callback(error, stdout);
    };
  const env = { PATH: "/opt/homebrew/bin:/usr/bin" };
  assert.equal(
    await npmGlobalBin({ env, home: "/Users/x", execFileImpl: answer("/opt/homebrew/Cellar/node/26.5.0_1\n") }),
    "/opt/homebrew/Cellar/node/26.5.0_1/bin",
  );
  assert.deepEqual(calls[0], { file: "npm", args: ["prefix", "-g"], cwd: "/Users/x", path: "/opt/homebrew/bin:/usr/bin" });
  assert.equal(await npmGlobalBin({ env, home: "/Users/x", execFileImpl: answer("", new Error("spawn npm ENOENT")) }), null);
  assert.equal(await npmGlobalBin({ env, home: "/Users/x", execFileImpl: answer("npm warn something\n") }), null);
  const throws = () => {
    throw new Error("EACCES");
  };
  assert.equal(await npmGlobalBin({ env, home: "/Users/x", execFileImpl: throws }), null);
});

test("refreshing the install folders adds ones that appeared, after the folders PATH already has", () => {
  const present = new Set(["/Users/x/.local/bin"]);
  const target = { PATH: "/opt/homebrew/bin:/usr/bin:/Users/x/.local/bin" };
  const dirs = () => ["/Users/x/.local/bin", "/Users/x/.volta/bin"].filter((dir) => present.has(dir));
  refreshInstallPath({ target, platform: "darwin", home: "/Users/x", dirs });
  assert.equal(target.PATH, "/opt/homebrew/bin:/usr/bin:/Users/x/.local/bin");
  present.add("/Users/x/.volta/bin");
  refreshInstallPath({ target, platform: "darwin", home: "/Users/x", dirs });
  assert.equal(target.PATH, "/opt/homebrew/bin:/usr/bin:/Users/x/.local/bin:/Users/x/.volta/bin");
  const windows = { PATH: "C:\\Windows" };
  refreshInstallPath({ target: windows, platform: "win32", dirs: () => [] });
  assert.equal(windows.PATH, "C:\\Windows");
});
