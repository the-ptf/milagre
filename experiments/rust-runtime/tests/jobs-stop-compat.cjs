// Called only by the private Rust unit fixture after explicit forced cancellation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { connect } = require("../../../apps/daemon/src/client.cjs");
async function main() {
  const [profile, project] = process.argv.slice(2);
  assert.equal(path.dirname(profile), fs.realpathSync("/tmp"));
  const client = await connect({ dataDir: profile, timeoutMs: 5000 });
  const events = [];
  client.on("event", (event) => events.push(event));
  try {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(client.call("daemon:stop"), (error) => error.code === "QUIT_PENDING");
      assert.equal(fs.existsSync(path.join(project, ".milagre/runtime.lock")), true);
      assert.equal(fs.existsSync(profile), true);
      assert.equal(
        events.some((event) => event.channel === "daemon:stopping"),
        false,
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
