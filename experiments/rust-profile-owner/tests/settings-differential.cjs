// CP3: production Node daemon -> Rust owner -> production Node daemon, on the SAME files.
// Invoked by settings_differential.rs, which creates the isolation marker. No installed daemon is used.
// Results, errors, JSON key order, settings bytes and command events are compared after each operation.
// Event sequence numbers are owner-local; background events unrelated to these commands are excluded.
// This does not exercise OS permission failures, crash/power-loss durability, concurrent external editors,
// provider execution, Linear connections, or network avatar fallback. project:image uses a saved icon.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const readline = require("node:readline");
const repo = path.resolve(__dirname, "../../..");
const { connect } = require(path.join(repo, "apps/daemon/src/client.cjs"));
const [rootArg, ownerBinary] = process.argv.slice(2);
const root = fs.realpathSync(rootArg);
assert.ok(fs.statSync(path.join(root, "MILAGRE-ISOLATED-COPY")).isFile());
assert.ok(path.isAbsolute(ownerBinary), "explicit test-built owner required");
const dataDir = path.join(root, "profile");
// A sibling temporary HOME avoids making the isolation overlap its own protected Milagre folders.
const home = path.join(path.dirname(root), "home");
const project = path.join(root, "project");
for (const dir of [dataDir, home, project]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
// An allowlist, not a credential-name denylist: no ambient config, auth sockets or provider environment.
const env = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: root,
  LANG: "en_US.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  MILAGRE_BACKGROUND: "1",
};
const files = [
  "done.json",
  "context-settings.json",
  "project-settings.json",
  "remote-delegation.json",
  "device-notes.json",
  "app-update.json",
  "limit-switch.json",
  "keybindings.json",
  "keybindings.seen.json",
  "linear/settings.json",
  "unrelated-sentinel.json",
];
const channels = new Set([
  "done:settings",
  "context:settings",
  "linked:remote-enabled-changed",
  "device-notes:changed",
  "app-update:auto",
  "keybindings:changed",
  "linear:enabled-changed",
]);
const children = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const common = [
  "serve",
  "--data-dir",
  dataDir,
  "--app-version",
  "0.0.0-test",
  "--cwd",
  "/",
  "--chats-home",
  path.join(root, "chats"),
  "--worktree-root",
  path.join(root, "worktrees"),
];
async function start(kind) {
  const child = spawn(kind === "node" ? process.execPath : ownerBinary, kind === "node" ? [path.join(repo, "apps/daemon/src/cli.cjs"), ...common] : common, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16000);
  });
  const exited = once(child, "exit");
  const lines = readline.createInterface({ input: child.stdout });
  let timer;
  try {
    const ready = await Promise.race([
      once(lines, "line").then(([line]) => JSON.parse(line)),
      exited.then(([code]) => {
        throw new Error(`${kind} exited ${code}: ${stderr}`);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${kind} startup timeout: ${stderr}`)), 30000);
      }),
    ]);
    assert.equal(ready.pid, child.pid);
    const client = await connect({ dataDir });
    const events = [];
    client.on("event", (event) => {
      if (channels.has(event.channel)) events.push({ channel: event.channel, payload: event.payload });
    });
    // Let startup reads and the keybindings watcher settle before measuring command events.
    await delay(180);
    events.length = 0;
    return { child, client, events, exited, stderr: () => stderr };
  } finally {
    clearTimeout(timer);
  }
}
async function stop(run) {
  await run.client.call("daemon:stop", []);
  run.client.close();
  let timer;
  try {
    const [code] = await Promise.race([
      run.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("stop timeout")), 15000);
      }),
    ]);
    assert.equal(code, 0, run.stderr());
    children.delete(run.child);
  } finally {
    clearTimeout(timer);
  }
}
function bytes() {
  return Object.fromEntries(
    files.map((name) => {
      const file = path.join(dataDir, name);
      return [name, fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : null];
    }),
  );
}
function restore(saved) {
  for (const [name, content] of Object.entries(saved)) {
    const file = path.join(dataDir, name);
    if (content === null) fs.rmSync(file, { force: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(content, "base64"));
    }
  }
}
const readCases = [
  ["done:settings:read"],
  ["context:settings:read"],
  ["main-sync:read", project],
  ["main-sync:default:read"],
  ["linked:remote-enabled:read"],
  ["device-notes:read"],
  ["app-update:auto:read"],
  ["limits:auto-switch:read"],
  ["limits:resume-at-reset:read"],
  ["keybindings:read"],
  ["linear:enabled:read"],
  ["app:version"],
  ["project:image", project],
];
function cases() {
  const result = [...readCases];
  for (const patch of [{ retentionHours: 8 }, { retentionHours: -2 }, { retentionHours: 1.5 }, { retentionHours: "12", extra: 1 }, {}, null, [], true])
    result.push(["done:settings:save", patch]);
  for (const patch of [
    {
      buttonThreshold: 94.5,
      autoThreshold: 1,
      autoCompact: true,
      followUps: "queue",
    },
    {
      buttonThreshold: 5.5,
      autoThreshold: 99,
      autoCompact: "true",
      followUps: "other",
    },
    {},
    null,
    [],
    "bad",
  ])
    result.push(["context:settings:save", patch]);
  for (const command of [
    "main-sync:default:save",
    "linked:remote-enabled:save",
    "device-notes:save",
    "app-update:auto:save",
    "limits:auto-switch:save",
    "limits:resume-at-reset:save",
    "linear:enabled:save",
    "linear:move-to-started:save",
  ]) {
    for (const value of [true, true, false, "true", 1, null, { enabled: true }]) result.push([command, value]);
  }
  for (const value of [true, false, null, "true"]) result.push(["main-sync:save", project, value]);
  for (const value of [true, true, false, "true"]) result.push(["project:set-hidden", project, value]);
  result.push(
    ["keybindings:set-command", "chat.new", [{ key: "mod+u" }]],
    ["keybindings:reset-command", "chat.new"],
    ["keybindings:reset"],
    ["keybindings:set-command", "chat.new", [{ key: "mod+u" }]],
    ["keybindings:set-command", "chat.new", [{ key: "mod+k", when: "chat" }]],
    [
      "keybindings:set-command",
      "chat.new",
      [
        {
          key: "\ufeffmod+k\ufeff",
          when: "chatView\u00a0&&\ufeff!terminalFocus",
        },
      ],
    ],
    ["keybindings:set-command", "no.such", []],
    ["keybindings:set-command", "chat.new", null],
    ["keybindings:set-command", "chat.new", [{}]],
    ["keybindings:reset-command", "no.such"],
    ["keybindings:reset-command", "chat.new"],
    ["keybindings:set-command", "chat.new", []],
    ["keybindings:reset"],
    ["fixture:edit-keybindings", '[/* hand edit */ {"key":"mod+y","command":"chat.new","when":"chatView && !terminalFocus",},]\n'],
    ["keybindings:read"],
    ["fixture:edit-keybindings", "{broken"],
    ["keybindings:read"],
    ["keybindings:reset"],
    ["keybindings:set-command", "chat.new", [{ key: "mod+u" }]],
    ["main-sync:read", path.join(root, "unknown")],
    ["main-sync:save", path.join(root, "unknown"), true],
    ["project:set-hidden", path.join(root, "unknown"), true],
    ["project:image", path.join(root, "unknown")],
    // Leave non-default values behind for the rollback/reopen check.
    ["done:settings:save", { retentionHours: 8 }],
    ["device-notes:save", true],
    ["linear:enabled:save", true],
    ["main-sync:save", project, true],
    ["project:set-hidden", project, true],
    ...readCases,
  );
  return result;
}
async function record(run, commands) {
  const output = [];
  for (const [method, ...args] of commands) {
    run.events.length = 0;
    let response;
    try {
      if (method === "fixture:edit-keybindings") {
        write("keybindings.json", args[0]);
        response = { result: true };
      } else response = { result: await run.client.call(method, args) };
    } catch (error) {
      response = { error: { code: error.code, message: error.message } };
    }
    // Responses are ordered after synchronous command events. Waiting also catches duplicate watcher emissions.
    await delay(method === "fixture:edit-keybindings" ? 400 : method.startsWith("keybindings:") ? 240 : 5);
    output.push({
      method,
      args,
      ...response,
      events: [...run.events],
      files: bytes(),
    });
  }
  return output;
}
function compare(actual, expected, label) {
  assert.equal(actual.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    const hint = `${label} case ${index}: ${expected[index].method} ${JSON.stringify(expected[index].args)}`;
    assert.deepStrictEqual(actual[index], expected[index], hint);
    assert.equal(JSON.stringify(actual[index]), JSON.stringify(expected[index]), `${hint} (key order)`);
  }
}
function write(name, value) {
  const file = path.join(dataDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}
async function main() {
  const prime = await start("node");
  await prime.client.call("project:open", [project]);
  await prime.client.call("daemon:flush", []);
  await stop(prime);
  const icon = "data:image/png;base64,YQ==";
  write("project-settings.json", {
    extra: { keep: "日本語" },
    projects: { [project]: { icon, filesToCopy: [".env"], extra: 7 } },
    defaults: { extra: 9 },
  });
  write("unrelated-sentinel.json", "do not rewrite\n");
  const initial = bytes();
  for (const scenario of ["missing", "seeded", "malformed", "jsonc", "broken-keybindings"]) {
    restore(initial);
    if (scenario === "seeded") {
      write("done.json", { retentionHours: 7, extra: 1 });
      write("context-settings.json", {
        buttonThreshold: 62.5,
        autoThreshold: 79.5,
        followUps: "queue",
        extra: 1,
      });
      write("limit-switch.json", {
        autoSwitch: true,
        resumeAtReset: true,
        extra: "keep",
      });
      write("linear/settings.json", {
        enabled: false,
        moveToStarted: false,
        extra: "keep",
      });
      write("device-notes.json", { enabled: "true", extra: 1 });
    }
    if (scenario === "malformed") {
      for (const file of [
        "done.json",
        "context-settings.json",
        "limit-switch.json",
        "linear/settings.json",
        "device-notes.json",
        "remote-delegation.json",
        "app-update.json",
      ])
        write(file, "{broken");
      // Valid JSON with invalid rules: JSON parser diagnostic text is V8-version-specific.
      write("keybindings.json", [{ command: "no.such", key: "mod+u" }, null]);
    }
    if (scenario === "jsonc") {
      write("keybindings.json", '[ // keep this hand edit\n {"key":" Command+K ","command":"chat.new","when":"chatView && !terminalFocus",},\n]\n');
      write("keybindings.seen.json", ["chat.new", "chat.find", "obsolete.command", "chat.new"]);
    }
    if (scenario === "broken-keybindings") write("keybindings.json", "{broken");
    const seed = bytes();
    const node = await start("node");
    const baseline = await record(node, cases());
    const reopenExpected = await record(node, readCases);
    await stop(node);
    restore(seed);
    const rust = await start("rust");
    const actual = await record(rust, cases());
    await stop(rust);
    compare(actual, baseline, scenario);
    const rollback = await start("node");
    compare(await record(rollback, readCases), reopenExpected, `${scenario} rollback`);
    await stop(rollback);
    console.log(
      `${scenario}: ${baseline.length} same-file command results/errors, event payloads/order and settings bytes match; ${reopenExpected.length} Node reopen reads match`,
    );
  }
}
main()
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // A failed assertion must not leave an experimental owner running.
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited.catch(() => {});
    }
  });
