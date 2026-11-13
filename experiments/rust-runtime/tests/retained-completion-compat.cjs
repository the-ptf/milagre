// Real Node client, private scripted provider, deterministic Rust fold-failure gate.
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
  const ends = () => events.filter((event) => ["turn-completed", "turn-cancelled", "turn-failed"].includes(event.type));
  async function until(label, check) {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error("Timed out: " + label);
  }
  const send = (id, body, delivery) =>
    client.call("chat:send", [{ projectPath: project, sessionId: 2, provider: "kiro", body, clientMessageId: id, ...(delivery ? { delivery } : {}) }]);
  try {
    await client.call("project:open", [project]);
    await send("retained-first", "First retained-completion prompt");
    let next = once(lines, "line");
    console.log("sent");
    assert.equal((await next)[0], "stream");
    await until(
      "session and streamed text",
      () => events.some((event) => event.type === "session-started") && events.some((event) => event.type === "text-delta"),
    );
    await send("retained-queued", "Queued successor prompt", "queue");
    assert.equal((await client.call("project:snapshot", [project])).state.sessions["2"].queued.length, 1);
    next = once(lines, "line");
    console.log("queued");
    assert.equal((await next)[0], "hidden");
    assert.deepEqual((await client.call("daemon:snapshot")).projects, []);
    assert.equal(ends().length, 0);
    await client.call("project:open", [project]);
    const retry = await client.call("daemon:snapshot");
    assert.ok(retry.runs.runs[project + "#2"]);
    assert.equal(retry.projects[0].state.sessions["2"].queued.length, 1);
    assert.equal(ends().length, 0, "parked exit must not replace retained completion during another failed fold");
    next = once(lines, "line");
    console.log("retry-held");
    assert.equal((await next)[0], "release");
    await until("retained completion released", () => ends().length === 1);
    assert.equal(ends()[0].type, "turn-completed");
    await until("queued turn starts", async () => {
      const snapshot = await client.call("daemon:snapshot");
      return snapshot.runs.runs[project + "#2"] && !snapshot.projects[0].state.sessions["2"].queued?.length;
    });
    next = once(lines, "line");
    console.log("successor");
    assert.equal((await next)[0], "finish");
    await until("successor ends", () => ends().length === 2);
    assert.deepEqual(
      ends().map((event) => event.type),
      ["turn-completed", "turn-completed"],
    );
    const messages = (await client.call("chat:messages", [project, 2])).messages;
    for (const id of ["retained-first", "retained-queued"]) assert.equal(messages.filter((message) => message.clientMessageId === id).length, 1);
    const first = messages.find((message) => message.role === "assistant" && message.body === "Retained first reply");
    assert.equal(first.outcome, "completed");
    assert.equal(messages.filter((message) => message.role === "assistant" && message.body === "Queued reply").length, 1);
    assert.equal((await client.call("daemon:snapshot")).runs.runs[project + "#2"], undefined);
    await client.call("project:open", [project]);
    await send("retained-queued", "Queued successor prompt");
    assert.equal((await client.call("daemon:snapshot")).runs.runs[project + "#2"], undefined);
    assert.equal(ends().length, 2);
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
