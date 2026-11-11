// Production clients, synthetic provider only. The live profile and real provider CLIs are never addressed.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { DatabaseSync } = require("node:sqlite");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const { connectDesktopRuntime } = require("../../../apps/daemon/src/runtime-client.cjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, check) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(20);
  }
  throw Error("Timed out: " + label);
}
async function fixture(test) {
  const child = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  let client, runtime, metadata;
  try {
    metadata = JSON.parse((await once(lines, "line"))[0]);
    assert.equal(metadata.actor.scriptedProvider, true);
    assert.equal(path.dirname(metadata.profile), fs.realpathSync("/tmp"));
    client = await connect({ dataDir: metadata.profile, timeoutMs: 5000 });
    const events = [];
    client.on("event", (event) => events.push(event));
    runtime = await connectDesktopRuntime({ connect: () => connect({ dataDir: metadata.profile, timeoutMs: 5000 }) });
    const project = metadata.actor.project;
    await client.call("project:open", [project]);
    await runtime.openProject(project);
    const send = (sessionId, body, clientMessageId) =>
      client.call("chat:send", [{ projectPath: project, sessionId, body, clientMessageId, provider: "kiro", model: "scripted" }]);
    const disk = () => {
      const db = new DatabaseSync(path.join(project, ".milagre/chats.db"), { readOnly: true });
      try {
        return db
          .prepare("SELECT payload FROM messages ORDER BY position,id")
          .all()
          .map((row) => JSON.parse(row.payload));
      } finally {
        db.close();
      }
    };
    await test({ child, client, runtime, project, events, send, disk, metadata });
  } finally {
    runtime?.close();
    client?.close();
    child.stdin.end();
    const [code] = await exited;
    clearTimeout(timer);
    lines.close();
    assert.equal(code, 0, stderr);
    assert.equal(fs.existsSync(metadata.profile), false, "only fixture profile is removed at successful shutdown");
  }
}
async function run() {
  await fixture(async ({ client, runtime, project, events, send, disk }) => {
    await assert.rejects(client.call("chat:send", [{ projectPath: project, sessionId: 1, provider: "codex", body: "never" }]), { code: "ISOLATED_SCOPE_ONLY" });
    await assert.rejects(client.call("project:open", [process.cwd()]), { code: "ISOLATED_SCOPE_ONLY" });
    await send(1, "hello", "actor-first");
    // No further RPC: periodic provider pumping and persistence must progress by themselves.
    await until("saved reply without reads", () => disk().some((row) => row.role === "assistant" && row.body === "Scripted isolated reply"));
    assert.equal(disk().filter((row) => row.clientMessageId === "actor-first").length, 1);
    await until("idle unload without reads", () =>
      events.some(({ channel, payload }) => channel === "project:state" && payload.state && payload.state.messages?.length === 0),
    );
    const sequences = events.map((event) => event.seq);
    assert.deepEqual(
      sequences,
      [...sequences].sort((a, b) => a - b),
    );
    assert.equal(new Set(sequences).size, sequences.length);
    const types = new Set(events.filter((event) => event.channel === "agent:event").map((event) => event.payload.event.type));
    assert.ok(types.has("text-delta"));
    assert.ok(types.has("turn-completed"));
    const messages = await client.call("chat:messages", [project, 1]);
    assert.ok(messages.messages.some((message) => message.body === "Scripted isolated reply"));
    // An untimed synthetic start cannot block another Chat or interrupt.
    await send(1, "fixture:blocked-start", "actor-blocked");
    const start = Date.now();
    await send(2, "second chat", "actor-second");
    assert.ok(Date.now() - start < 2000);
    await until("second Chat finishes", () =>
      events.some((event) => event.payload?.chatId === project + "#2" && event.payload.event?.type === "turn-completed"),
    );
    // Snapshot captures the ongoing first Chat. A new viewer does not own or restart it.
    const snapshot = await client.call("daemon:snapshot");
    assert.ok(snapshot.runs.runs[project + "#1"]);
    await runtime.close();
    const viewer = await connect({ dataDir: path.dirname(project), timeoutMs: 5000 });
    try {
      await assert.rejects(viewer.call("agent:interrupt", [project + "#1"]), { code: "ISOLATED_SCOPE_ONLY" });
      await viewer.call("project:open", [project]);
      await viewer.call("agent:interrupt", [project + "#1"]);
    } finally {
      viewer.close();
    }
    await until("blocked start cancelled", () =>
      events.some((event) => event.payload?.chatId === project + "#1" && event.payload.event?.type === "turn-cancelled"),
    );
    // Repeated snapshot and command transitions exercise the publication lock ordering.
    await Promise.all(Array.from({ length: 20 }, () => client.call("daemon:snapshot")));
    await client.call("daemon:stop");
  });
  await fixture(async ({ client, events, send }) => {
    await send(1, "fixture:delayed-stop", "actor-delayed-stop");
    await assert.rejects(client.call("daemon:stop"), /turn runs/);
    await until("cancellation arrives while admission is closed", () => events.some((event) => event.payload?.event?.type === "turn-cancelled"));
    await client.call("daemon:stop");
  });
  await fixture(async ({ client, project, events, send }) => {
    await send(1, "dirty close", "actor-close-failure");
    const state = path.join(project, ".milagre/coordination.json");
    const backup = state + ".fixture-backup";
    fs.renameSync(state, backup);
    fs.mkdirSync(state);
    try {
      await until("turn ended before failed close", () => events.some((event) => event.payload?.event?.type === "turn-completed"));
      await assert.rejects(client.call("daemon:stop"));
      assert.equal(fs.existsSync(path.join(project, ".milagre/runtime.lock/owner.json")), true, "failed close retains ownership");
      await assert.rejects(client.call("chat:send", [{ projectPath: project, sessionId: 2, provider: "kiro", body: "refused" }]), { code: "CLOSING" });
    } finally {
      fs.rmdirSync(state);
      fs.renameSync(backup, state);
    }
    await client.call("daemon:stop");
  });
  console.log(
    "Actor runtime conformance passed: periodic save/unload, bounded scripted starts, publication/snapshot order, reconnect, interrupt and failed-close retry",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
