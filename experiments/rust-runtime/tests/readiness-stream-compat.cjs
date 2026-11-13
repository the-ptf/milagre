// Fixed private owner and scripted provider. Pipe handshakes control the readiness fault, not time delays.
const assert = require("node:assert/strict");
const readline = require("node:readline");
const { once } = require("node:events");
const { connect } = require("../../../apps/daemon/src/client.cjs");
async function main() {
  const [profile, project] = process.argv.slice(2);
  const lines = readline.createInterface({ input: process.stdin });
  const client = await connect({ dataDir: profile, timeoutMs: 5000 });
  const events = [];
  client.on("event", (event) => {
    if (event.channel === "agent:event") events.push(event.payload.event);
  });
  const terminal = () => events.filter((event) => ["turn-completed", "turn-cancelled", "turn-failed"].includes(event.type));
  async function until(label, check) {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error("Timed out: " + label);
  }
  try {
    await client.call("project:open", [project]);
    const request = { projectPath: project, sessionId: 2, provider: "kiro", body: "Stream then lose readiness", clientMessageId: "readiness-stream" };
    await client.call("chat:send", [request]);
    let next = once(lines, "line");
    console.log("sent");
    assert.equal((await next)[0], "stream");
    await until(
      "initial stream and permission",
      () => events.some((event) => event.type === "text-delta" && event.text === "before ") && events.some((event) => event.type === "permission-request"),
    );
    next = once(lines, "line");
    console.log("streaming");
    assert.equal((await next)[0], "answer");
    let answerCount = 0;
    const answer = client.call("agent:respond-permission", [{ chatId: project + "#2", requestId: "held", decision: "allow" }]).then((value) => {
      answerCount++;
      return value;
    });
    // Attach rejection handling immediately, even if a broken implementation settles before the next handshake.
    answer.catch(() => {});
    next = once(lines, "line");
    console.log("answer-pending");
    const held = (await next)[0];
    assert.ok(held.startsWith("hidden "));
    const watermark = Number(held.slice(7));
    const snapshot = await client.call("daemon:snapshot");
    assert.deepEqual(snapshot.projects, []);
    assert.deepEqual(snapshot.runs.runs, {});
    assert.equal(snapshot.runs.seq, watermark);
    assert.equal(answerCount, 0);
    assert.equal(terminal().length, 0);
    assert.equal(events.filter((event) => event.type === "text-delta" && event.text === "partial").length, 0);
    await assert.rejects(client.call("project:current"), { code: "PROJECT_NOT_READY" });
    await assert.rejects(client.call("chat:queue-remove", [project + "#2", "missing"]), { code: "PROJECT_NOT_READY" });
    assert.equal((await client.call("daemon:snapshot")).runs.seq, watermark);
    assert.equal(answerCount, 0);
    next = once(lines, "line");
    console.log("held");
    assert.equal((await next)[0], "reopen");
    await client.call("project:open", [project]);
    assert.equal(await answer, true);
    await until("held end replayed", () => terminal().length === 1);
    assert.equal(terminal()[0].type, "turn-completed");
    assert.equal(answerCount, 1);
    assert.equal(events.filter((event) => event.type === "text-delta" && event.text === "partial").length, 1);
    const ready = await client.call("daemon:snapshot");
    assert.equal(ready.projects[0].path, project);
    assert.equal(ready.runs.runs[project + "#2"], undefined);
    assert.ok(ready.runs.seq > watermark);
    const messages = (await client.call("chat:messages", [project, 2])).messages;
    assert.equal(messages.filter((message) => message.clientMessageId === "readiness-stream").length, 1);
    assert.equal(messages.filter((message) => message.body === "before partial" && message.role === "assistant").length, 1);
    await client.call("project:open", [project]);
    await client.call("chat:send", [request]);
    assert.equal((await client.call("daemon:snapshot")).runs.runs[project + "#2"], undefined);
    assert.equal(terminal().length, 1);
    assert.equal(answerCount, 1);
    await client.call("daemon:stop");
    console.log("completed");
  } finally {
    client.close();
    lines.close();
    process.stdin.destroy();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
