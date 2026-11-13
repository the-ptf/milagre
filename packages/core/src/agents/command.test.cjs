const assert = require("node:assert/strict");
const test = require("node:test");
const { agentEnvironment, launchOptions, spawnCommand, execCommand } = require("./command.cjs");
const { HOST_ONLY } = require("../host-env.cjs");

// What the host runs with: Electron in Node mode plus the shell that started it.
const HOST_ENV = {
  ELECTRON_RUN_AS_NODE: "1",
  ELECTRON_NO_ATTACH_CONSOLE: "1",
  MILAGRE_BUNDLED_BIN_DIR: "/Applications/Milagre.app/Contents/Resources/bin",
  PWD: "/",
  OLDPWD: "/tmp",
  SHLVL: "2",
  _: "/usr/bin/env",
  PATH: "/opt/homebrew/bin:/usr/bin:/bin",
  HOME: "/Users/someone",
  CLAUDE_CONFIG_DIR: "/Users/someone/.claude-work",
};

function withHostEnv(run) {
  const saved = Object.fromEntries(Object.keys(HOST_ENV).map((key) => [key, process.env[key]]));
  Object.assign(process.env, HOST_ENV);
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function assertNoHostVariables(env) {
  for (const key of HOST_ONLY) assert.equal(env[key], undefined, `${key} reached the agent`);
}

test("an agent CLI never inherits the host's ELECTRON_RUN_AS_NODE or shell variables", () => {
  const spawned = [];
  const spawnImpl = (file, args, options) => {
    spawned.push({ file, args, options });
    return { pid: 1 };
  };
  spawnCommand("/usr/local/bin/claude", ["--version"], { cwd: "/tmp", env: HOST_ENV, stdio: "pipe" }, spawnImpl);
  const { options } = spawned[0];
  assertNoHostVariables(options.env);
  assert.equal(options.env.PATH, HOST_ENV.PATH);
  assert.equal(options.env.CLAUDE_CONFIG_DIR, HOST_ENV.CLAUDE_CONFIG_DIR);
  assert.equal(options.cwd, "/tmp");
  assert.equal(options.stdio, "pipe");
  // The caller's object is left alone.
  assert.equal(HOST_ENV.ELECTRON_RUN_AS_NODE, "1");
});

test("without an env of its own, an agent CLI gets the host's environment minus the host's variables", () => {
  withHostEnv(() => {
    const spawned = [];
    spawnCommand("/usr/local/bin/codex", ["app-server"], { stdio: "pipe" }, (file, args, options) => {
      spawned.push(options);
      return { pid: 1 };
    });
    assertNoHostVariables(spawned[0].env);
    assert.equal(spawned[0].env.HOME, HOST_ENV.HOME);

    const executed = [];
    execCommand(
      "/usr/local/bin/claude",
      ["auth", "status"],
      { encoding: "utf8" },
      () => {},
      (file, args, options) => executed.push(options),
    );
    assertNoHostVariables(executed[0].env);
    assert.equal(executed[0].encoding, "utf8");

    // Claude Code launched by the SDK itself (models, MCP checks, titles) gets the same environment.
    assertNoHostVariables(agentEnvironment());
    assertNoHostVariables(agentEnvironment(HOST_ENV));
    assert.equal(agentEnvironment(HOST_ENV).PATH, HOST_ENV.PATH);
  });
});

test("Electron's own binary running a CLI's JS entry keeps Node mode", () => {
  // npm's Windows wrapper resolved to a JS entry with no node.exe beside it: the CLI runs on this Electron as Node.
  const options = launchOptions({ env: HOST_ENV, cwd: "C:\\work" }, true);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(options.env.PWD, undefined);
  assert.equal(options.env.MILAGRE_BUNDLED_BIN_DIR, undefined);
  assert.equal(options.cwd, "C:\\work");
  assert.equal(launchOptions({ env: HOST_ENV }, false).env.ELECTRON_RUN_AS_NODE, undefined);
});
