// Called only by private Rust unit fixtures. Restore is enabled only in that test host.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { connect } = require("../../../apps/daemon/src/client.cjs");
async function main() {
  const [profile, project, mode] = process.argv.slice(2);
  assert.equal(path.dirname(profile), fs.realpathSync("/tmp"));
  const client = await connect({ dataDir: profile, timeoutMs: 5000 });
  const events = [];
  client.on("event", (event) => events.push(event));
  try {
    if (mode === "refused") {
      await assert.rejects(client.call("daemon:stop"), /turn runs/);
      assert.equal((await client.call("project:open", [project])).path, project, "refused quit reopens both wire and actor admission");
      await client.call("agent:interrupt", [project + "#1"]);
    }
    if (mode === "restore") {
      await client.call("project:open", [project]);
      await client.call("chat:send", [
        { projectPath: project, sessionId: 1, provider: "kiro", model: "fixture", body: "Restore then stop", clientMessageId: "restore-stop" },
      ]);
      const before = await client.call("daemon:snapshot");
      assert.ok(before.runs.runs[project + "#1"], "real restore owns a run");
      assert.equal(before.projects[0].state.messages.find((message) => message.context?.kind === "handoff").context.status, "preparing");
    }
    for (let i = 0; i < 3; i++) {
      await assert.rejects(client.call("daemon:stop"), (error) => error.code === "QUIT_PENDING");
      assert.equal(fs.existsSync(path.join(project, ".milagre/runtime.lock")), true);
      assert.equal(fs.existsSync(profile), true);
      assert.equal(
        events.some((event) => event.channel === "daemon:stopping"),
        false,
      );
    }
    if (mode === "restore") {
      assert.equal(events.filter((event) => event.payload?.chatId === project + "#1" && event.payload.event?.type === "turn-cancelled").length, 1);
      await assert.rejects(
        client.call("chat:send", [{ projectPath: project, sessionId: 1, provider: "kiro", body: "Restore then stop", clientMessageId: "restore-stop" }]),
        { code: "CLOSING" },
      );
    }
    console.log("Pending transcript stop conformance passed");
  } finally {
    client.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
