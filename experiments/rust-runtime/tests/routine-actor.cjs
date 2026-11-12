// Actual timer through the socket-bound actor. No caller clock, native provider or production root.
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  { spawn } = require("node:child_process"),
  readline = require("node:readline");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const parent = fs.mkdtempSync(path.join(os.tmpdir(), "rust-routine-actor-")),
  root = path.join(parent, "data"),
  records = [];
function deadline(p, label, ms = 12000) {
  let t;
  return Promise.race([p, new Promise((_, j) => (t = setTimeout(() => j(Error("deadline " + label)), ms)))]).finally(() => clearTimeout(t));
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function launch(mode) {
  const child = spawn(path.resolve(process.argv[2]), [mode, root], { stdio: ["pipe", "pipe", "pipe"] });
  const row = { child, stderr: "" };
  records.push(row);
  row.exit = new Promise((r, j) => {
    child.once("exit", (code, signal) => r({ code, signal }));
    child.once("error", j);
  });
  child.stderr.on("data", (b) => (row.stderr = (row.stderr + b).slice(-65536)));
  const lines = readline.createInterface({ input: child.stdout });
  row.receipt = await deadline(
    new Promise((r, j) => {
      lines.once("line", (s) => {
        try {
          r(JSON.parse(s));
        } catch (e) {
          j(e);
        }
      });
      row.exit.then(() => j(Error(row.stderr)));
    }),
    "receipt",
  );
  lines.close();
  row.client = await connect({ dataDir: row.receipt.profile, timeoutMs: 3000 });
  await row.client.call("project:open", [row.receipt.actor.project]);
  return row;
}
async function stop(row) {
  const end = Date.now() + 12000;
  for (;;) {
    try {
      await row.client.call("daemon:stop");
      break;
    } catch (e) {
      if (e.code !== "QUIT_PENDING" || Date.now() > end) throw e;
      await pause(20);
    }
  }
  row.client.close();
  row.child.stdin.end();
  assert.deepEqual(await deadline(row.exit, "stop"), { code: 0, signal: null });
  if (row.expectedFailure) {
    assert.match(
      row.stderr,
      /^isolated owner transition failed: Dedicated runtime configuration changed; restart with explicit configuration\n(?:isolated owner transition failed: Owner event delivery failed; stop and restart this isolated fixture\n)?$/,
    );
  } else assert.equal(row.stderr, "");
  for (const p of [row.receipt.profile, row.receipt.socket, path.join(row.receipt.actor.project, ".milagre/runtime.lock")])
    assert.equal(fs.existsSync(p), false);
  row.stopped = true;
}
(async () => {
  const blocked = process.argv[3] === "--blocked";
  const row = await launch(blocked ? "routine-blocked-fixture-create" : "routine-fixture-create");
  if (blocked) {
    const end = Date.now() + 75000;
    for (;;) {
      const value = await row.client.call("state:read", [row.receipt.actor.project]);
      if (value.state.sessions["1"].native_session_id === "actor-routine-native") break;
      if (Date.now() > end) throw Error("native scheduled init did not arrive");
      await pause(20);
    }
    assert.ok(Object.keys((await row.client.call("daemon:snapshot")).runs.runs).length === 1);
    await stop(row);
    const saved = JSON.parse(fs.readFileSync(path.join(root, "routines/routines.json"), "utf8"));
    const runs = Object.values(saved.runs)[0];
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "failed");
    assert.equal(saved.routines[0].runCount, 1);
    fs.rmSync(parent, { recursive: true });
    console.log(JSON.stringify({ actorStopActive: true, actualNativeInit: true, cleanup: true }));
    return;
  }
  assert.deepEqual(await row.client.call("routines:enabled:read"), { enabled: true, executionSupported: true });
  let saved;
  const end = Date.now() + 75000;
  while (Date.now() < end) {
    saved = JSON.parse(fs.readFileSync(path.join(root, "routines/routines.json"), "utf8"));
    if (Object.values(saved.runs).some((runs) => runs[0]?.status === "acted")) break;
    await pause(20);
  }
  const runs = Object.values(saved.runs).find((entries) => entries[0]?.status === "acted");
  assert.ok(runs, "real actor must persist terminal before deadline");
  const run = runs[0];
  assert.equal(saved.routines[0].runCount, 1);
  assert.equal(saved.routines[0].enabled, false);
  assert.deepEqual(await row.client.call("routines:list"), { routines: [] });
  const messages = await row.client.call("chat:messages", [row.receipt.actor.project, 1]);
  assert.equal(messages.total, 2);
  assert.equal(messages.messages[0].context.kind, "routine-run");
  assert.equal(messages.messages[0].context.runId, run.id);
  assert.equal(messages.messages[1].body, "Actor timer completed");
  assert.equal(messages.messages[1].outcome, "completed");
  await stop(row);
  const reopened = await launch("routine-fixture-open");
  await pause(150);
  assert.deepEqual(await reopened.client.call("chat:messages", [reopened.receipt.actor.project, 1]), messages);
  assert.deepEqual(await reopened.client.call("routines:list"), { routines: [] });
  const after = JSON.parse(fs.readFileSync(path.join(root, "routines/routines.json"), "utf8"));
  const later = Object.values(after.runs)[0];
  assert.equal(later.length, 1);
  assert.equal(later[0].id, run.id);
  await stop(reopened);
  const fault = await launch("routine-fixture-open");
  const manifestFile = path.join(root, "rust-chat-runtime.json"),
    manifest = fs.readFileSync(manifestFile);
  const runBytes = fs.readFileSync(path.join(root, "routines/routines.json"));
  fault.expectedFailure = true;
  fs.writeFileSync(manifestFile, Buffer.concat([manifest, Buffer.from(" ")]));
  const faultDeadline = Date.now() + 3000;
  while (!fault.stderr.includes("Dedicated runtime configuration changed")) {
    if (Date.now() > faultDeadline) throw Error("actual timer did not observe manifest revocation");
    await pause(5);
  }
  await assert.rejects(fault.client.call("routines:list"), { code: "OWNER_CLOSING" });
  assert.ok(fs.existsSync(path.join(fault.receipt.actor.project, ".milagre/runtime.lock")));
  assert.deepEqual(fs.readFileSync(path.join(root, "routines/routines.json")), runBytes);
  fs.writeFileSync(manifestFile, manifest);
  await assert.rejects(fault.client.call("project:open", [fault.receipt.actor.project]), { code: "OWNER_CLOSING" });
  await stop(fault);
  const recovered = await launch("routine-fixture-open");
  assert.deepEqual(await recovered.client.call("chat:messages", [recovered.receipt.actor.project, 1]), messages);
  assert.deepEqual(await recovered.client.call("routines:list"), { routines: [] });
  await stop(recovered);

  fs.rmSync(parent, { recursive: true });
  console.log(
    JSON.stringify({
      actorTimer: true,
      ownerFaultRetainedAndRecovered: true,
      actualFixedNative: true,
      storedClaim: true,
      savedTerminal: true,
      restartNoReplay: true,
      oneWriter: true,
      cleanup: true,
    }),
  );
})()
  .catch((e) => {
    console.error(e.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const row of records) {
      row.client?.close();
      row.child.stdin?.end();
      if (!row.stopped) {
        try {
          await deadline(row.exit, "failure cleanup", 15000);
        } catch {
          row.child.kill("SIGTERM");
          await deadline(row.exit, "exact failure cleanup", 5000).catch(() => {});
        }
      }
    }
  });
