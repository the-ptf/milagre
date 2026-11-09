const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const exec = promisify(execFile);
const command = path.join(__dirname, "command.cjs");

test("milagre serves a persistent default profile without a UI and can be controlled from another terminal", { timeout: 30000 }, async (t) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-box-")));
  const project = path.join(home, "project");
  await fs.mkdir(project);
  await exec("git", ["init", "-b", "main", project]);
  const env = { ...process.env, MILAGRE_DATA_DIR: path.join(home, "profile") };
  const child = spawn(process.execPath, [command, "serve", "--no-pair", "--project", project], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  let output = "",
    errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
    await fs.rm(home, { recursive: true, force: true });
  });
  for (let i = 0; !output.includes("Milagre is running") && i < 500; i++) {
    assert.equal(child.exitCode, null, errors);
    await delay(20);
  }
  assert.match(output, /Milagre is running/);
  const call = async (...args) => JSON.parse((await exec(process.execPath, [command, ...args], { env, cwd: home })).stdout);
  assert.equal((await call("status")).pid, child.pid);
  assert.equal((await call("request", "project:current")).path, project);
  assert.deepEqual(await call("devices", "list"), []);
  assert.deepEqual(await call("devices", "pending"), []);
  assert.equal((await call("project", "current")).path, project);
  assert.match((await exec(process.execPath, [command, "help", "project"], { env })).stdout, /milagre project registry/);
  assert.match((await exec(process.execPath, [command, "project", "--help"], { env })).stdout, /milagre project registry/);
  const catalogue = await call("command", "list");
  assert.ok(catalogue.some((item) => item.name === "chat:send"));
  assert.ok(catalogue.some((item) => item.name === "computers:list"));
  await call("computers", "setup-key", path.join(home, "computer.key"));
  await call("computers", "enable");
  assert.equal((await call("computers", "list")).enabled, true);
  await call("computers", "disable");
  assert.equal((await call("computers", "list")).enabled, false);
  const opened = await call("project", "current");
  const chatId = `${project}#${Object.values(opened.state.sessions)[0].id}`;
  assert.equal((await call("project", "open", "--folder", project)).path, project);
  const sessionId = Object.values(opened.state.sessions)[0].id;
  await call("chat", "patch", "--project-path", project, "--session-id", String(sessionId), "--patch", JSON.stringify({ title: "Named CLI input" }));
  assert.equal((await call("project", "current")).state.sessions[sessionId].title, "Named CLI input");
  await assert.rejects(
    exec(process.execPath, [command, "chat", "patch", "--project-path", project, "--session-id", "wrong", "--patch", "{}"], { env }),
    /session-id/,
  );
  await assert.rejects(
    exec(process.execPath, [command, "chat", "patch", "--project-path", project, "--session-id", String(sessionId), "--patch", "{}", "--typo", "true"], {
      env,
    }),
    /Unknown flag/,
  );
  await call("tasks", "set", "--chat", chatId, "--tasks", JSON.stringify([{ title: "Named scoped input", status: "pending" }]));
  assert.match((await call("tasks", "read", "--chat", chatId)).text, /Named scoped input/);
  await assert.rejects(exec(process.execPath, [command, "project", "registry", "--chat", chatId], { env }), /unavailable/);
  const tools = await call("command", "list", "--chat", chatId);
  assert.ok(tools.some((item) => item.name === "tasks_set"));
  assert.equal((await call("command", "describe", "tasks_set", "--chat", chatId)).inputSchema.type, "object");
  const plan = await call(
    "command",
    "run",
    "tasks_set",
    "--chat",
    chatId,
    "--input",
    JSON.stringify({ tasks: [{ title: "CLI task", status: "in_progress" }] }),
  );
  assert.equal(plan.isError, false);
  assert.match(plan.text, /CLI task/);
  assert.match((await call("command", "run", "tasks_read", "--chat", chatId)).text, /CLI task/);
  assert.match((await call("tasks", "read", "--chat", chatId)).text, /CLI task/);
  const session = spawn(process.execPath, [command, "session"], { env, cwd: home, stdio: ["pipe", "pipe", "pipe"] });
  let sessionOutput = "";
  session.stdout.on("data", (chunk) => {
    sessionOutput += chunk;
  });
  const sessionExit = once(session, "exit");
  session.stdin.end(JSON.stringify({ id: 1, method: "project:current", args: [] }) + "\n" + JSON.stringify({ id: 2, method: "chat:runs", args: [] }) + "\n");
  assert.equal((await sessionExit)[0], 0);
  const replies = sessionOutput
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(replies.find((item) => item.id === 1).result.path, project);
  assert.ok(replies.find((item) => item.id === 2).result);
  const missingDesktop = await exec(process.execPath, [command, "desktop", "editor", "list", "--json"], { env }).catch((error) => error);
  assert.equal(JSON.parse(missingDesktop.stdout).error.code, "CAPABILITY_UNAVAILABLE");
  await assert.rejects(
    exec(process.execPath, [command, "command", "run", "tasks_set", "--chat", chatId, "--input", '{"unknown":true}'], { env }),
    /Invalid arguments/,
  );
  await assert.rejects(exec(process.execPath, [command, "devices", "allow"], { env }), /device key/);
  await call("stop");
  assert.equal((await exited)[0], 0, errors);
  await assert.rejects(fs.stat(path.join(env.MILAGRE_DATA_DIR, "runtime.lock")), { code: "ENOENT" });
});

test("milagre help and version work without starting a daemon, and invalid commands fail", async () => {
  const help = (await exec(process.execPath, [command, "--help"])).stdout;
  assert.match(help, /milagre serve/);
  assert.equal((await exec(process.execPath, [command, "help"])).stdout, help);
  for (const heading of ["DESCRIPTION", "USAGE", "COMMANDS", "GLOBAL FLAGS", "EXAMPLES"]) assert.ok(help.includes(heading), heading);
  for (const name of ["serve", "pair", "status", "stop", "devices", "request", "help"]) assert.match(help, new RegExp(`\\n  ${name} +\\S`));
  assert.ok(!help.includes("\u001b["), "Piped help must not contain terminal color codes");
  const metadata = require("../package.json");
  assert.equal((await exec(process.execPath, [command, "--version"])).stdout.trim(), metadata.cliVersion ?? metadata.version);
  await assert.rejects(exec(process.execPath, [command, "serve", "--data-dir", "relative"]), /absolute/);
  await assert.rejects(exec(process.execPath, [command, "serv"]), /Unknown command/);
});

test("command help describes its flags and arguments without connecting to a daemon", async () => {
  const run = async (...args) => (await exec(process.execPath, [command, ...args], { env: { ...process.env, MILAGRE_DATA_DIR: "relative" } })).stdout;
  const serve = await run("help", "serve");
  assert.equal(await run("serve", "--help"), serve);
  assert.match(serve, /milagre serve/);
  assert.match(serve, /--project/);
  assert.match(serve, /--no-pair/);
  assert.match(serve, /FLAGS/);
  assert.doesNotMatch(serve, /COMMANDS/);
  const devices = await run("help", "devices");
  for (const action of ["list", "pending", "allow", "deny", "remove"]) assert.match(devices, new RegExp(`\\n  ${action}[^\\n]+`));
  assert.doesNotMatch(devices, /--project/);
  const request = await run("request", "--help");
  assert.match(request, /ARGUMENTS/);
  assert.match(request, /JSON_ARGS/);
  await assert.rejects(run("help", "unknown"), /Unknown command/);
});

test("terminal pairing opens a timed window and computers wait for an explicit allow or deny", { timeout: 30000 }, async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-box-pair-")));
  const { startDaemon } = require("./server.cjs");
  let relay;
  const daemon = await startDaemon({
    dataDir,
    version: "test",
    phoneOptions: {
      localPort: 0,
      lanPort: null,
      startRelay: (options) => {
        relay = options;
        return { close: async () => {}, status: () => "online" };
      },
    },
    runtimeOptions: {
      cwd: dataDir,
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: Object.assign(async () => ({ command: null }), { invalidate() {} }),
    },
  });
  t.after(async () => {
    await daemon.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const run = async (...args) => (await exec(process.execPath, [command, ...args, "--data-dir", dataDir], { cwd: dataDir })).stdout;
  const pairing = await run("pair", "--no-qr");
  const link = pairing.match(/milagre:\/\/pair\?\S+/)?.[0];
  assert.ok(link, pairing);
  assert.equal(new URL(link).searchParams.get("relay"), "wss://relay.milagre.cloud");
  assert.match(new URL(link).searchParams.get("token"), /^[a-f0-9]{64}$/);
  const status = JSON.parse(await run("request", "phone:status"));
  assert.ok(status.pairingUntil > Date.now());
  const key = "s".repeat(43);
  const waiting = relay.allowComputer({ key, name: "Studio", signal: new AbortController().signal });
  assert.equal(JSON.parse(await run("devices", "pending"))[0].key, key);
  assert.deepEqual(JSON.parse(await run("devices", "list")), []);
  await run("devices", "allow", key);
  assert.equal(await waiting, "allowed");
  const denied = relay.allowComputer({ key, name: "Studio", signal: new AbortController().signal });
  await run("devices", "deny", key);
  assert.equal(await denied, "denied");
  await assert.rejects(run("devices", "allow", key), /no longer waiting/);
  await relay.phones.add(key, { kind: "computer", name: "Studio" });
  assert.equal(JSON.parse(await run("devices", "list"))[0].name, "Studio");
  assert.deepEqual(JSON.parse(await run("devices", "remove", key)), []);
});

test("generated command help works on a box before a daemon starts", async () => {
  const env = { ...process.env, MILAGRE_DATA_DIR: path.join(os.tmpdir(), "milagre-missing-parity-profile") };
  const { stdout } = await exec(process.execPath, [command, "help", "chat", "patch"], { env });
  assert.match(stdout, /--project-path string/);
  assert.match(stdout, /--session-id number/);
  assert.match(stdout, /--patch object/);
});

test("an unknown global flag without a command fails instead of displaying help", async () => {
  await assert.rejects(exec(process.execPath, [command, "--typo"]), /Unknown flag: --typo/);
});
