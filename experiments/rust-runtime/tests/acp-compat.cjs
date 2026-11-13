// Production Node clients against the opt-in, one-process-per-turn ACP fake adapter.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const readline = require("node:readline");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const { connectDesktopRuntime } = require("../../../apps/daemon/src/runtime-client.cjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, test) {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    if (await test()) return;
    await delay(5);
  }
  throw Error("Timed out: " + label);
}
async function scenario(name) {
  const child = spawn(process.argv[2], [name], { stdio: ["pipe", "pipe", "pipe"] });
  const exit = once(child, "exit");
  const lines = readline.createInterface({ input: child.stdout });
  let stderr = "",
    client,
    runtime,
    metadata,
    reaped;
  child.stderr.on("data", (chunk) => (stderr += chunk));
  lines.on("line", (line) => {
    const v = JSON.parse(line);
    if (v.reaped) reaped = v.reaped;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    metadata = JSON.parse((await once(lines, "line"))[0]);
    assert.equal(metadata.fakeAcp, true);
    client = await connect({ dataDir: metadata.profile, timeoutMs: 5000 });
    runtime = await connectDesktopRuntime({ connect: () => connect({ dataDir: metadata.profile, timeoutMs: 5000 }) });
    const project = metadata.actor.project,
      chatId = project + "#1",
      events = [];
    client.on("event", (e) => {
      if (e.channel === "agent:event") events.push(e.payload.event);
    });
    await client.call("project:open", [project]);
    await runtime.openProject(project);
    const send = (body, delivery) =>
      client.call("chat:send", [
        { projectPath: project, sessionId: 1, body, clientMessageId: body, provider: "kiro", permissionMode: "ask", ...(delivery ? { delivery } : {}) },
      ]);
    const ends = () => events.filter((e) => ["turn-completed", "turn-failed", "turn-cancelled"].includes(e.type));
    await send("first ACP fixture prompt");
    if (name === "permission") {
      await until("first permission", () => events.some((e) => e.type === "permission-request"));
      await send("queued ACP fixture prompt", "queue");
      const queued = await client.call("project:snapshot", [project]);
      assert.equal(queued.state.sessions["1"].queued.length, 1);
      const first = events.find((e) => e.type === "permission-request");
      assert.equal(first.allowForChat, false);
      assert.equal(await client.call("agent:respond-permission", [{ chatId, requestId: first.requestId, decision: "allow" }]), true);
      await until("held queue after missing session handoff", async () => {
        const snapshot = await client.call("project:snapshot", [project]);
        return snapshot.state.sessions["1"].queueHeld === true;
      });
      assert.equal(events.filter((event) => event.type === "permission-request").length, 1);
      await assert.rejects(send("unsupported successor"), /handoff restore/);
      // A fresh Chat has no lost native context. Its independent process can still run.
      await client.call("chat:send", [
        { projectPath: project, sessionId: 2, body: "independent ACP prompt", clientMessageId: "independent", provider: "kiro", permissionMode: "ask" },
      ]);
      await until("independent permission", () => events.filter((e) => e.type === "permission-request").length === 2);
      const second = events.filter((e) => e.type === "permission-request")[1];
      assert.notEqual(second.requestId, first.requestId);
      assert.equal(await client.call("agent:respond-permission", [{ chatId: project + "#2", requestId: first.requestId, decision: "allow" }]), false);
      assert.equal(await client.call("agent:respond-permission", [{ chatId: project + "#2", requestId: second.requestId, decision: "deny" }]), true);
    }
    if (name === "stop") {
      await until("working", () => events.some((e) => e.text === "Working"));
      await client.call("agent:interrupt", [chatId]);
    }
    await until("first terminal", () => ends().length > 0);

    const count = name === "permission" ? 2 : 1;
    await until("all terminals", () => ends().length === count);
    assert.equal((await client.call("daemon:snapshot")).runs.runs[chatId], undefined);
    const messages = (await client.call("chat:messages", [project, 1])).messages;
    assert.ok(messages.some((m) => m.body === "first ACP fixture prompt"));
    if (name === "reply") assert.ok(messages.some((m) => m.body === "Hello"));
    if (name === "permission") {
      const queued = await client.call("project:snapshot", [project]);
      assert.equal(queued.state.sessions["1"].queued[0].body, "queued ACP fixture prompt");
      assert.ok(!messages.some((m) => m.body === "queued ACP fixture prompt"));
      assert.ok(messages.some((m) => m.body === "picked:allow"));
      const peer = await client.call("chat:messages", [project, 2]);
      assert.ok(peer.messages.some((m) => m.body === "picked:deny"));
    }
    if (name === "startfail") assert.equal(ends()[0].type, "turn-failed");
    if (name === "late") {
      assert.equal(messages.filter((m) => m.body === "live").length, 1);
      assert.ok(!JSON.stringify(messages).includes("late after response"));
    }
    assert.ok(!events.some((e) => e.type === "session-started"), "no resumable native ID is persisted");
    await client.call("daemon:stop");
    runtime.close();
    client.close();
    child.stdin.end();
    const [code, signal] = await exit;
    assert.equal(signal, null, stderr);
    assert.equal(code, 0, stderr);
    assert.equal(reaped.length, name === "startfail" ? 0 : count);
    assert.equal(new Set(reaped.map(([, pid]) => pid)).size, reaped.length);
    for (const [, pid] of reaped) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(fs.existsSync(metadata.profile), false);
    assert.equal(fs.existsSync(project), false);
  } finally {
    clearTimeout(timer);
    runtime?.close();
    client?.close();
    lines.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}
(async () => {
  for (const name of ["reply", "permission", "stop", "startfail", "late"]) await scenario(name);
  console.log("ACP owner Node client conformance passed (5 scenarios)");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
