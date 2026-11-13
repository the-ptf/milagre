// Actual Node wire client, one Rust durable routine store, two dedicated daemon lifetimes. No turn or scheduler.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rust-configured-routines-"));
const root = path.join(parent, "data");
const executable = path.resolve(process.argv[2]);
const records = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
function deadline(p, label, ms = 12000) {
  let timer;
  return Promise.race([p, new Promise((_, j) => (timer = setTimeout(() => j(Error("Timed out: " + label)), ms)))]).finally(() => clearTimeout(timer));
}
async function launch(mode) {
  const child = spawn(executable, [mode, root], { stdio: ["pipe", "pipe", "pipe"] });
  const row = { child, stderr: "", events: [] };
  records.push(row);
  child.stderr.on("data", (b) => {
    row.stderr += b;
  });
  row.exit = new Promise((r, j) => {
    child.once("exit", (code, signal) => r({ code, signal }));
    child.once("error", j);
  });
  const lines = readline.createInterface({ input: child.stdout });
  row.receipt = await deadline(new Promise((r) => lines.once("line", (l) => r(JSON.parse(l)))), "receipt");
  lines.close();
  row.project = row.receipt.actor.project;
  row.client = await connect({ dataDir: row.receipt.profile, timeoutMs: 10000 });
  row.client.on("event", (e) => row.events.push(e));
  return row;
}
async function stop(row) {
  const end = performance.now() + 12000;
  for (;;) {
    const remaining = end - performance.now();
    if (remaining <= 0) throw Error("Timed out: daemon stop remained pending");
    try {
      await deadline(row.client.call("daemon:stop"), "daemon stop", remaining);
      break;
    } catch (e) {
      if (e.code !== "QUIT_PENDING") throw e;
      await pause(20);
    }
  }
  row.client.close();
  row.child.stdin.end();
  assert.deepEqual(await deadline(row.exit, "exit"), { code: 0, signal: null });
  assert.equal(row.stderr, "");
  assert.equal(fs.existsSync(row.receipt.profile), false);
  assert.equal(fs.existsSync(row.receipt.socket), false);
  assert.equal(fs.existsSync(path.join(row.project, ".milagre/runtime.lock")), false);
  row.stopped = true;
}
function changes(row) {
  return row.events.filter((e) => e.channel === "routines:changed").length;
}
(async () => {
  const row = await launch("fixture-create");
  const call = (m, a) => row.client.call(m, a);
  const chatId = row.project + "#1";
  assert.deepEqual(await call("routines:enabled:read"), { enabled: true, executionSupported: false });
  await assert.rejects(call("routines:list"), { code: "ISOLATED_SCOPE_ONLY" });
  await call("project:open", [row.project]);
  assert.deepEqual(await call("routines:list"), { routines: [] });
  const settings = {
    name: "Paused schedule 😀",
    prompt: "Stored only",
    trigger: { kind: "schedule", cron: "*/15 * * * *", timezone: "UTC" },
    target: { kind: "chat", chatId },
    createdBy: { kind: "agent", chatId: "/forged#1" },
    enabled: false,
  };
  await assert.rejects(call("routines:create", [{ ...settings, enabled: true }]), { code: "ROUTINE_EXECUTION_UNAVAILABLE" });
  await assert.rejects(call("routines:run-now", ["missing"]), { code: "COMMAND_FAILED", message: "Unknown command: routines:run-now" });
  for (const target of [
    { kind: "chat", chatId: "/foreign#1" },
    { kind: "new-chat", projectPath: "/foreign" },
    { kind: "chat", chatId: row.project + "#999" },
  ])
    await assert.rejects(call("routines:create", [{ ...settings, target }]));
  assert.equal(fs.existsSync(path.join(root, "routines/routines.json")), false);
  const created = await call("routines:create", [settings]);
  assert.equal(created.routine.enabled, false);
  assert.deepEqual(created.routine.createdBy, { kind: "user" });
  const id = created.routine.id;
  assert.deepEqual(await call("routines:list"), { routines: [{ ...created.routine, runs: [] }] });
  const file = path.join(root, "routines/routines.json");
  const createdBytes = fs.readFileSync(file, "utf8");
  // Actual production Node target resolver/store, with the runtime's observed clock/id.
  const { routineTargets } = require("../../../packages/core/src/routines/runtime-adapter.cjs");
  const { createRoutineStore } = require("../../../packages/core/src/routines/store.cjs");
  const state = (await call("state:read", [row.project])).state;
  const target = await routineTargets({ projects: async () => [{ path: row.project }], openState: async () => state })(settings.target);
  const oracleDir = fs.mkdtempSync(path.join(parent, "node-oracle-"));
  const oracleFile = path.join(oracleDir, "routines.json");
  let now = created.routine.createdAt;
  const node = createRoutineStore({ file: oracleFile, now: () => now, id: () => id });
  const nodeCreated = node.create({ ...settings, target, createdBy: { kind: "user" } });
  const nodePaused = node.update(nodeCreated.id, { enabled: false });
  assert.deepEqual(created, { routine: nodePaused });
  assert.equal(fs.readFileSync(oracleFile, "utf8"), createdBytes);
  const before = changes(row);
  const updated = await call("routines:update", [id, { name: "Edited paused schedule" }]);
  now = updated.updatedAt;
  assert.deepEqual(updated, node.update(id, { name: "Edited paused schedule" }));
  assert.equal(fs.readFileSync(oracleFile, "utf8"), fs.readFileSync(file, "utf8"));
  const saved = fs.readFileSync(file, "utf8");
  await assert.rejects(call("routines:update", [id, { enabled: true }]), { code: "ROUTINE_EXECUTION_UNAVAILABLE" });
  await assert.rejects(call("routines:update", [id, { target: { kind: "chat", chatId: "/foreign#1" } }]));
  assert.equal(fs.readFileSync(file, "utf8"), saved);
  assert.deepEqual(await call("routines:delete", ["missing"]), { removed: false });
  await pause(30);
  assert.equal(changes(row), before + 1);
  const list = await call("routines:list");
  await stop(row);
  assert.equal(fs.readFileSync(file, "utf8"), saved);
  const next = await launch("fixture-open");
  await next.client.call("project:open", [next.project]);
  assert.notEqual(next.receipt.profile, row.receipt.profile);
  assert.deepEqual(await next.client.call("routines:list"), list);
  assert.equal(fs.readFileSync(file, "utf8"), saved);
  assert.deepEqual(await next.client.call("routines:delete", [id]), { removed: true });
  assert.deepEqual(await next.client.call("routines:list"), { routines: [] });
  await stop(next);
  console.log(JSON.stringify({ routinesCrud: true, pausedOnly: true, nodeBytes: true, restart: true, events: true, cleanup: true }));
  fs.rmSync(parent, { recursive: true, force: true });
})()
  .catch((e) => {
    console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const row of records) {
      if (!row.stopped) {
        try {
          if (row.client) await stop(row);
        } catch {}
        row.client?.close();
        row.child.stdin.end();
        try {
          await deadline(row.exit, "failure cleanup");
        } catch {
          row.child.kill("SIGKILL");
          await deadline(row.exit, "exact child killed", 5000);
        }
      }
    }
  });
