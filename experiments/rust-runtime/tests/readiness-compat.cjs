// Fixed private fixture supplied by the Rust unit test; no production profile.
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
    await assert.rejects(client.call("project:current"), { code: "PROJECT_NOT_READY" });
    if (mode === "busy" || mode === "save-failed") {
      if (mode === "busy") {
        await assert.rejects(client.call("project:open", [project]), { code: "HANDOVER_STORE_BUSY" });
      } else {
        await assert.rejects(client.call("project:open", [project]), (error) => ["EISDIR", "ENOTEMPTY", "EEXIST"].includes(error.code));
      }
      await assert.rejects(client.call("project:current"), { code: "PROJECT_NOT_READY" });
      assert.deepEqual((await client.call("daemon:snapshot")).projects, []);
      assert.equal(events.filter((event) => event.channel === "project:state").length, 0);
      assert.equal(fs.existsSync(path.join(project, ".milagre/runtime.lock")), true, "failed open retains its lock");
    } else {
      assert.equal(mode, "recover");
      const opened = await client.call("project:open", [project]);
      assert.equal(opened.path, project);
      const divider = opened.state.messages.find((message) => message.context?.kind === "handoff");
      assert.equal(divider.context.status, "failed");
      assert.equal(opened.state.sessions["1"].handoverPending, undefined);
      assert.equal((await client.call("project:current")).path, project);
      assert.equal((await client.call("project:snapshot", [project])).path, project);
      await client.call("state:read", [project]);
      await client.call("project:open", [project]);
      await client.call("project:forget", [project]);
      for (const [method, args] of [
        ["project:current", []],
        ["project:snapshot", [project]],
        ["state:read", [project]],
      ]) {
        await assert.rejects(client.call(method, args), { code: "PROJECT_NOT_READY" });
      }
      assert.deepEqual((await client.call("daemon:snapshot")).projects, []);
      assert.equal(fs.existsSync(path.join(project, ".milagre/runtime.lock")), false);
    }
    console.log("Readiness conformance passed");
  } finally {
    client.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
