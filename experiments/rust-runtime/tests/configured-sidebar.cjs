// Actual Node wire client, one Rust durable routine store, two dedicated daemon lifetimes. No turn or scheduler.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rust-configured-sidebar-"));
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

(async () => {
  const row = await launch("fixture-create");
  const call = (m, a) => row.client.call(m, a);
  await call("project:open", [row.project]);
  const read = async () => (await call("state:read", [row.project])).state;
  const patch = (p) => call("chat:patch", [row.project, 1, p]);
  const file = path.join(row.project, ".milagre/coordination.json");
  const durable = () => JSON.parse(fs.readFileSync(file, "utf8")).sessions["1"];
  const original = await read();
  const operations = [];
  async function edit(p) {
    assert.equal(await patch(p), null);
    const state = await read();
    operations.push({ id: 1, now: state.sessions["1"].done_at || 1000, patch: p });
    for (const k of ["title", "unread", "pinned", "pin_order", "done_at"]) assert.deepEqual(durable()[k], state.sessions["1"][k], k + " saved before reply");
    return state;
  }
  const routine = await call("routines:create", [
    {
      name: "Finish on Done",
      prompt: "Stored only",
      trigger: { kind: "schedule", cron: "*/15 * * * *", timezone: "UTC" },
      target: { kind: "chat", chatId: row.project + "#1" },
      enabled: false,
    },
  ]);
  await edit({ title: "Renamed 😀" });
  await edit({ pinned: true, pin_order: -1.5 });
  await edit({ done: true, unread: false });
  assert.deepEqual(await call("routines:list"), { routines: [] });
  const completed = JSON.parse(fs.readFileSync(path.join(root, "routines/routines.json"), "utf8")).routines.find((r) => r.id === routine.routine.id);
  assert.equal(completed.completedReason, "chat done");
  assert.ok(completed.completedAt > 0);
  await edit({ done: false });
  await edit({ archived: false });
  await edit({ pinned: false, pin_order: 0 });
  // Actual Node handler oracle, including host-stamped done_at and hidden-Run semantics.
  const { spawnSync } = require("node:child_process");
  const oracle = spawnSync(process.execPath, [path.join(__dirname, "../fixtures/chat-patch-node.cjs")], {
    input: JSON.stringify({ scope: row.project, state: original, operations }),
    encoding: "utf8",
  });
  assert.equal(oracle.status, 0, oracle.stderr);
  assert.deepEqual(await read(), JSON.parse(oracle.stdout).observations.at(-1).state);
  const beforeInvalid = fs.readFileSync(file, "utf8");
  for (const p of [{ archived: true }, { done_at: 42 }, { title: null }, { model: "foreign" }, { done: true, accountId: "forged" }])
    await assert.rejects(patch(p), { code: "INVALID_CHAT_PATCH" });
  await assert.rejects(call("chat:patch", [row.project, 999, { title: "missing" }]), { code: "CHAT_NOT_FOUND" });
  await assert.rejects(call("chat:patch", [row.project + "/foreign", 1, { done: true }]), { code: "CHAT_RUNTIME_CONFIG" });
  assert.equal(fs.readFileSync(file, "utf8"), beforeInvalid);
  // Successful send reopens a Done Chat before reply. Metadata while busy does not stop the native turn.
  await edit({ done: true });
  await call("chat:send", [
    {
      projectPath: row.project,
      sessionId: 1,
      provider: "claude",
      model: "sonnet",
      permissionMode: "ask",
      clientMessageId: "sidebar-first",
      body: "Metadata while busy",
    },
  ]);
  assert.equal((await read()).sessions["1"].done_at, undefined);
  async function event(type) {
    const until = performance.now() + 12000;
    for (;;) {
      const e = row.events.find((notice) => notice.channel === "agent:event" && notice.payload.event.type === type);
      if (e) return e.payload.event;
      if (performance.now() > until) throw Error("Timed out: " + type);
      await pause(5);
    }
  }
  const permission = await event("permission-request");
  const runsBefore = await call("chat:runs");
  await edit({ title: "Busy renamed", done: true });
  assert.deepEqual(await call("chat:runs"), runsBefore);
  assert.ok((await read()).sessions["1"].done_at > 0);
  await edit({ done: false });
  await call("agent:respond-permission", [{ chatId: row.project + "#1", requestId: permission.requestId, decision: "allow" }]);
  await event("turn-completed");
  const catalog = await call("artifact:list", [{ chatId: row.project + "#1" }]);
  assert.equal(catalog.length, 2);
  const transcript = await call("chat:messages", [row.project, 1]);
  assert.equal(transcript.messages.length, 2);
  const terminal = await call("terminal:open", [{ chatId: row.project + "#1", cols: 80, rows: 24 }]);
  await edit({ done: true });
  const keptTerminal = (await call("terminal:list", [{ chatId: row.project + "#1" }])).terminals;
  assert.equal(keptTerminal.length, 1);
  for (const k of ["id", "cwd", "cols", "rows"]) assert.deepEqual(keptTerminal[0][k], terminal[k], "Done keeps daemon PTY " + k);
  await call("terminal:input", [{ terminalId: terminal.id, data: "printf sidebar-terminal-ok\\n\n" }]);
  assert.equal((await call("terminal:read", [{ terminalId: terminal.id, after: 0 }])).ended, false);
  await call("terminal:close", [{ terminalId: terminal.id }]);
  assert.deepEqual(await call("artifact:list", [{ chatId: row.project + "#1" }]), catalog, "Done does not revoke content membership");
  await edit({ archived: false });
  const saved = durable();
  await stop(row);
  const next = await launch("fixture-open");
  await next.client.call("project:open", [next.project]);
  const reopened = (await next.client.call("state:read", [next.project])).state.sessions["1"];
  for (const k of ["title", "unread", "pinned", "pin_order", "done_at"]) assert.deepEqual(reopened[k], saved[k]);
  assert.deepEqual(await next.client.call("chat:messages", [next.project, 1]), transcript);
  assert.deepEqual(await next.client.call("artifact:list", [{ chatId: next.project + "#1" }]), catalog);
  assert.deepEqual(await next.client.call("routines:list"), { routines: [] });
  await stop(next);
  console.log(
    JSON.stringify({
      sidebar: true,
      nodeParity: true,
      busy: true,
      routineDone: true,
      sendReopens: true,
      restart: true,
      contentMembership: true,
      cleanup: true,
    }),
  );
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
