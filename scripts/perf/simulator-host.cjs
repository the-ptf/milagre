const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { execFileSync } = require("node:child_process");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { relay: { type: "string" }, device: { type: "string" }, root: { type: "string" } },
});
const cleanups = [];
const stop = async () => {
  for (const cleanup of cleanups.toReversed()) await Promise.resolve(cleanup()).catch(() => {});
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("disconnect", stop);

async function until(read, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${description}`);
}

async function relay() {
  const { startLocalRelay } = require("../../apps/daemon/src/relay-test-kit.cjs");
  const started = await startLocalRelay({ after: (cleanup) => cleanups.push(cleanup) });
  return { url: started.url };
}

async function daemon() {
  const { startDaemon } = require("../../apps/daemon/src/server.cjs");
  const { connect } = require("../../apps/daemon/src/client.cjs");
  const root = await fs.realpath(values.root);
  const dataDir = path.join(root, "profile");
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  const started = await startDaemon({
    dataDir,
    homeDir: root,
    version: "0.1.0-perf",
    runtimeOptions: { cwd: project, worktreeRoot: path.join(root, "worktrees"), environmentReady: Promise.resolve(), titleModels: {} },
    phoneOptions: { relayUrl: values.relay, localPort: 0, lanPort: 0, lanHostname: "127.0.0.1", addresses: () => ["127.0.0.1"] },
  });
  cleanups.push(() => started.close());
  const client = await connect({ dataDir });
  cleanups.push(() => client.close());
  const opened = await client.call("project:open", [project]);
  const chatId = `${opened.path}#${Object.values(opened.state.sessions)[0].id}`;
  const listed = await client.call("simulator:list", [{ chatId }]);
  const device = [...listed.available, ...listed.devices].find((item) => item.id === values.device);
  if (!device) throw new Error(`Device ${values.device} is not running. Running: ${listed.available.map((item) => item.id).join(", ") || "none"}`);
  await client.call("simulator:attach", [{ chatId, deviceId: device.id }]);
  await client.call("phone:set-enabled", [true]);
  const status = await until(async () => {
    const current = await client.call("phone:status");
    return current.state === "on" && current.relay === "online" && current;
  }, "phone access on and the relay online");
  const token = JSON.parse(await fs.readFile(path.join(dataDir, "mobile.json"), "utf8")).token;
  return { pid: process.pid, dataDir, chatId, device, localUrl: status.localUrl, token, relayUrl: values.relay };
}

const role = positionals[0];
(role === "relay" ? relay() : role === "daemon" ? daemon() : Promise.reject(new Error("Usage: simulator-host.cjs relay | daemon ...")))
  .then((ready) => process.send?.({ ready }) ?? console.log(JSON.stringify(ready)))
  .catch((error) => {
    process.send?.({ error: error.message });
    console.error(error);
    process.exitCode = 1;
    void stop();
  });
