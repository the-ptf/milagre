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
let fixtureNumber = 0;
async function fixture(test) {
  const scenario = ++fixtureNumber;
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
    const call = client.call.bind(client);
    client.call = async (...args) => {
      try {
        return await call(...args);
      } catch (error) {
        error.message = `Fixture ${scenario}, ${args[0]}: ${error.message}`;
        throw error;
      }
    };
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
        // A real SQLite reader can meet the owner's brief commit lock. Wait for
        // that transaction instead of treating a healthy write as a test failure.
        db.exec("PRAGMA busy_timeout = 1000");
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
    if (runtime) {
      await runtime.close().catch((error) => {
        // The fixture scenarios explicitly stop the server before cleanup.
        if (!["DAEMON_CLOSED", "CLOSING"].includes(error.code)) throw error;
      });
    }
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
  await fixture(async ({ client, project, events, send }) => {
    await send(1, "fixture:ignore-stop", "actor-lost-end");
    await client.call("agent:interrupt", [project + "#1"]);
    await until("interrupt watchdog forces a missing end", () => events.some((event) => event.payload?.event?.type === "turn-failed"));
    assert.equal((await client.call("daemon:snapshot")).runs.runs[project + "#1"], undefined);
    await client.call("daemon:stop");
  });
  for (const mode of ["idle", "new-turn", "forgotten"]) {
    await fixture(async ({ client, project, events, send, disk }) => {
      await send(1, "fixture:late-events", "late-" + mode);
      await until("first synthetic turn ends", () => events.some((event) => event.payload?.event?.type === "turn-completed"));
      if (mode === "new-turn") await send(1, "fixture:blocked-start", "new-generation");
      if (mode === "forgotten") await client.call("project:forget", [project]);
      await delay(400);
      const ends = events.filter((event) => event.payload?.event?.type === "turn-completed");
      assert.equal(ends.length, 1, "idle duplicate completion is ignored");
      assert.ok(!events.some((event) => event.payload?.event?.text === "late text must not appear"));
      const snapshot = await client.call("daemon:snapshot");
      if (mode === "new-turn") {
        assert.ok(snapshot.runs.runs[project + "#1"], "old exit cannot fail a new turn");
        await client.call("agent:interrupt", [project + "#1"]);
      } else assert.equal(snapshot.runs.runs[project + "#1"], undefined);
      if (mode === "forgotten") {
        assert.equal(fs.existsSync(path.join(project, ".milagre/runtime.lock")), false, "late events cannot reopen a forgotten Project");
        assert.equal(snapshot.projects.length, 0);
      }
      assert.equal(disk().filter((row) => row.role === "assistant").length, 1);
      await client.call("daemon:stop");
    });
  }
  console.log(
    "Actor runtime conformance passed: periodic save/unload, bounded scripted starts, publication/snapshot order, reconnect, generations, interrupt watchdog, forgotten Projects and failed-close retry",
  );
}
run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
