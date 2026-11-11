// Actual Node wire client. Called only by the actor unit test with Restore explicitly enabled.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
  const request = (number, body) => ({
    projectPath: project,
    sessionId: 1,
    provider: "kiro",
    permissionMode: "ask",
    body,
    clientMessageId: "restore-" + number,
  });
  async function until(label, test) {
    const end = Date.now() + 7000;
    while (Date.now() < end) {
      if (await test()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error("Timed out: " + label);
  }
  const terminals = () => events.filter((event) => ["turn-completed", "turn-failed", "turn-cancelled"].includes(event.type));
  try {
    await client.call("project:open", [project]);
    await client.call("chat:send", [request("first", "First restore fixture prompt")]);
    await until("first completion", () => terminals().length === 1);
    assert.equal(terminals()[0].type, "turn-completed");
    fs.writeFileSync(path.join(project, "edited.txt"), "after\n");
    fs.writeFileSync(path.join(project, "fresh.txt"), "new\n");
    const second = request("second", "Second restore fixture prompt");
    await client.call("chat:send", [second]);
    const preparing = await client.call("project:snapshot", [project]);
    assert.equal(preparing.state.messages.find((message) => message.context?.kind === "handoff").context.status, "preparing");
    assert.ok((await client.call("daemon:snapshot")).runs.runs[project + "#1"]);
    assert.equal(terminals().length, 1);
    const continuation = once(lines, "line");
    console.log("preparing");
    assert.equal((await continuation)[0], "continue");
    await until("restored completion", () => terminals().length === 2);
    assert.deepEqual(
      terminals().map((event) => event.type),
      ["turn-completed", "turn-completed"],
    );
    const messages = (await client.call("chat:messages", [project, 1])).messages;
    assert.equal(messages.filter((message) => message.clientMessageId === "restore-first").length, 1);
    assert.equal(messages.filter((message) => message.clientMessageId === "restore-second").length, 1);
    assert.equal(messages.filter((message) => message.role === "assistant" && message.body === "Hello").length, 2);
    const secondIndex = messages.findIndex((message) => message.clientMessageId === "restore-second");
    assert.equal(messages.slice(secondIndex + 1).filter((message) => message.role === "assistant" && message.body === "Hello").length, 1);
    assert.equal(messages.filter((message) => message.context?.kind === "handoff").length, 1);
    assert.equal(messages.find((message) => message.context?.kind === "handoff").context.status, "done");
    assert.deepEqual(await client.call("chat:send", [second]), { sessionId: 1 });
    assert.equal((await client.call("daemon:snapshot")).runs.runs[project + "#1"], undefined);
    assert.equal(terminals().length, 2);
    const stopping = once(lines, "line");
    console.log("restored");
    assert.equal((await stopping)[0], "stop");
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
