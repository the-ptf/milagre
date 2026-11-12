// The crashed process owns the launcher stdin writer. The outer harness keeps a waitable runtime Child.
// Only dedicated fixture roots and the fixed runtime-fake-claude are used.
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const executable = path.resolve(process.argv[2]);
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rust-launcher-loss-"));
const root = path.join(parent, "data");
const records = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deadline(promise, label, ms = 8000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), ms)))]).finally(() =>
    clearTimeout(timer),
  );
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function waitFor(check, label, ms = 8000) {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() >= end) throw Error(`Timed out: ${label}`);
    await pause(5);
  }
}
async function launch(mode, stdin) {
  const child = spawn(executable, [mode, root], { stdio: [stdin ?? "pipe", "pipe", "pipe"] });
  const record = { child, stderr: "", client: null };
  records.push(record);
  record.exit = new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
  child.stderr.on("data", (b) => (record.stderr = (record.stderr + b).slice(-65536)));
  const lines = readline.createInterface({ input: child.stdout });
  record.receipt = await deadline(
    Promise.race([
      new Promise((resolve) => lines.once("line", (line) => resolve(JSON.parse(line)))),
      record.exit.then(() => {
        throw Error(record.stderr);
      }),
    ]),
    "receipt",
  );
  lines.close();
  record.client = await connect({ dataDir: record.receipt.profile, timeoutMs: 3000 });
  await record.client.call("project:open", [record.receipt.actor.project]);
  return record;
}
let controller;
let controllerExit;
let nativePid;
(async () => {
  // No stdout bytes are written: the pipe is a lifetime grant, not an RPC request.
  controller = spawn(process.execPath, ["-e", "process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore", "ipc"] });
  controllerExit = new Promise((resolve, reject) => {
    controller.once("exit", (code, signal) => resolve({ code, signal }));
    controller.once("error", reject);
  });
  await deadline(new Promise((resolve) => controller.once("message", resolve)), "controller ready");
  const record = await launch("fixture-create", controller.stdout);
  const { receipt } = record;
  let client = record.client;
  const project = receipt.actor.project;
  const chat = project + "#1";
  const scriptPath = path.join(receipt.profile, "fixed-child.json");
  const original = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
  // Keep the real fixture's launch/initialize controls, then hold an actual native turn until stdin EOF.
  fs.writeFileSync(
    scriptPath,
    JSON.stringify([
      ...original.slice(0, 5),
      { expect: { type: "user" } },
      { emit: { type: "system", subtype: "init", session_id: "launcher-loss-native" } },
      { wait_eof: true },
    ]),
  );
  const events = [];
  client.on("event", (event) => events.push(event));
  await client.call("chat:send", [
    {
      projectPath: project,
      sessionId: 1,
      worktreeId: 1,
      provider: "claude",
      model: "sonnet",
      permissionMode: "ask",
      body: "Controller crash during native turn",
      clientMessageId: "launcher-loss-1",
    },
  ]);
  await waitFor(() => events.some((e) => e.channel === "agent:event" && e.payload.event.type === "session-started"), "native started");
  const pids = execFileSync("/usr/bin/pgrep", ["-P", String(record.child.pid)], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map(Number);
  assert.equal(pids.length, 1);
  nativePid = pids[0];
  assert.ok(Number.isSafeInteger(nativePid) && nativePid > 0 && alive(nativePid));
  assert.ok((await client.call("daemon:snapshot")).runs.runs[chat], "the owner must still have an active run");
  client.close();
  client = record.client = await connect({ dataDir: receipt.profile, timeoutMs: 3000 });
  await client.call("project:open", [project]);
  assert.ok((await client.call("daemon:snapshot")).runs.runs[chat], "viewer reconnect must not cancel the owned turn");
  assert.ok(alive(nativePid));
  assert.equal(record.child.exitCode, null);
  const closedStderr = process.env.CLOSE_RUNTIME_STDERR === "1";
  if (closedStderr) record.child.stderr.destroy();
  const started = performance.now();
  assert.equal(controller.kill("SIGKILL"), true);
  assert.deepEqual(await deadline(controllerExit, "exact controller crash"), { code: null, signal: "SIGKILL" });
  const exited = await deadline(record.exit, "launcher-loss runtime cleanup", 6000);
  assert.deepEqual(exited, { code: 0, signal: null }, record.stderr);
  const retainedNotice = "QUIT_PENDING: launcher-loss cleanup exceeded one second; retaining the isolated owner until actual cleanup completes\n";
  assert.ok(record.stderr === "" || record.stderr === retainedNotice, record.stderr);
  assert.equal(alive(nativePid), false, "runtime must reap its captured native child before exiting");
  assert.equal(fs.existsSync(receipt.profile), false);
  assert.equal(fs.existsSync(receipt.socket), false);
  assert.equal(fs.existsSync(path.join(project, ".milagre/runtime.lock")), false);
  assert.equal(fs.existsSync(path.join(root, "rust-chat-runtime.json")), true, "dedicated data survives launcher loss");
  client.close();
  // A second real lifetime proves both root admission and saved terminal state, without another turn.
  const reopened = await launch("fixture-open");
  const messages = (await reopened.client.call("chat:messages", [project, 1])).messages;
  assert.equal(messages.filter((m) => m.clientMessageId === "launcher-loss-1").length, 1);
  const reply = messages.filter((m) => m.role === "assistant").at(-1);
  assert.equal(reply.outcome, "failed");
  assert.match(reply.body, /Milagre quit before the turn ended/);
  assert.deepEqual((await reopened.client.call("daemon:snapshot")).runs.runs, {});
  await reopened.client.call("daemon:stop");
  reopened.client.close();
  reopened.child.stdin.end();
  assert.deepEqual(await deadline(reopened.exit, "reopened runtime exit"), { code: 0, signal: null });
  assert.equal(reopened.stderr, "");
  assert.equal(fs.existsSync(reopened.receipt.profile), false);
  console.log(
    JSON.stringify({
      controllerKind: "separate stdin lifetime writer",
      controllerSignal: "SIGKILL",
      nativeReaped: true,
      viewerReconnectRetainedTurn: true,
      dataRetained: true,
      reopen: true,
      cleanup: true,
      elapsedMs: Math.round(performance.now() - started),
      pendingNotice: record.stderr === retainedNotice,
      closedStderr,
    }),
  );
})()
  .catch((error) => {
    console.error(error.stack);
    for (const record of records)
      console.error(
        JSON.stringify({
          runtimePid: record.child.pid,
          nativePid,
          exitCode: record.child.exitCode,
          signal: record.child.signalCode,
          runtimeStderr: record.stderr,
          receipt: record.receipt,
        }),
      );
    process.exitCode = 1;
  })
  .finally(async () => {
    if (controller && controller.exitCode === null && controller.signalCode === null) {
      controller.kill("SIGKILL");
      await deadline(controllerExit, "controller failure cleanup");
    }
    for (const record of records) {
      record.client?.close();
      if (record.child.exitCode === null && record.child.signalCode === null) {
        // Exact test-owned Child only. The fixed child exits on pipe EOF even on this failing-test path.
        record.child.kill("SIGTERM");
        await deadline(record.exit, "exact runtime failure cleanup");
      }
      if (nativePid) await waitFor(() => !alive(nativePid), "fixed child failure cleanup");
      if (record.receipt && !alive(record.child.pid) && (!nativePid || !alive(nativePid))) fs.rmSync(record.receipt.profile, { recursive: true, force: true });
    }
    if (!nativePid || !alive(nativePid)) fs.rmSync(parent, { recursive: true, force: true });
  });
