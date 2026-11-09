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
const cli = path.join(__dirname, "cli.cjs");

test("standalone CLI serves, reads saved state and stops without leaving its socket or locks", { timeout: 30000 }, async (t) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-cli-")));
  const dataDir = path.join(dir, "profile");
  const project = path.join(dir, "project");
  await fs.mkdir(project);
  await exec("git", ["init", "-b", "main", project]);
  const child = spawn(process.execPath, [cli, "serve", "--data-dir", dataDir], { cwd: project, stdio: ["ignore", "pipe", "pipe"] });
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
    await fs.rm(dir, { recursive: true, force: true });
  });
  // A Windows start runs its ACL checks first, which can take several seconds.
  for (let i = 0; !output.includes("\n") && i < 1000; i++) {
    assert.equal(child.exitCode, null, errors);
    await delay(20);
  }
  const ready = JSON.parse(output.trim());
  const call = async (...args) => JSON.parse((await exec(process.execPath, [cli, ...args, "--data-dir", dataDir], { cwd: project })).stdout);
  assert.equal((await call("status")).pid, child.pid);
  const opened = await call("request", "project:open", JSON.stringify([project]));
  const session = Object.values(opened.state.sessions)[0];
  await call("request", "chat:patch", JSON.stringify([project, session.id, { title: "CLI saved Chat" }]));
  const read = await call("request", "project:current");
  assert.equal(read.state.sessions[session.id].title, "CLI saved Chat");
  await call("stop");
  assert.equal((await exited)[0], 0, errors);
  for (const file of [ready.socketPath, path.join(dataDir, "runtime.lock"), path.join(project, ".milagre/runtime.lock")]) {
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
  }
  assert.equal(JSON.parse(await fs.readFile(path.join(project, ".milagre/coordination.json"))).sessions[session.id].title, "CLI saved Chat");
});

test("CLI requires an explicit absolute data directory", async () => {
  await assert.rejects(exec(process.execPath, [cli, "serve"]), (error) => /absolute --data-dir/.test(error.stderr));
  await assert.rejects(exec(process.execPath, [cli, "serve", "--data-dir", "relative"]), (error) => /absolute --data-dir/.test(error.stderr));
});
