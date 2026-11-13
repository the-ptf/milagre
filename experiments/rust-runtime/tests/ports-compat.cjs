// A real task-owned loopback listener under an isolated Rust PTY, driven by the production Node runtime client.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const { connect } = require("../../../apps/daemon/src/client.cjs");
const { connectDesktopRuntime } = require("../../../apps/daemon/src/runtime-client.cjs");
const child = spawn(process.argv[2], [], { stdio: ["pipe", "pipe", "pipe"] });
const exited = once(child, "exit");
const lines = readline.createInterface({ input: child.stdout });
let stage = "startup",
  metadata,
  client,
  runtime,
  listenerPid,
  shellPid,
  stderr = "";
child.stderr.on("data", (data) => {
  stderr += data;
});
const deadline = setTimeout(() => {
  child.kill("SIGKILL");
  console.error(`Port runtime deadline exceeded at ${stage}`);
  process.exitCode = 1;
}, 25000);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, check) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
async function tcp(port) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  try {
    await once(socket, "connect");
  } finally {
    socket.destroy();
  }
}
async function run() {
  const [line] = await once(lines, "line");
  metadata = JSON.parse(line);
  assert.equal(metadata.ownedCopies, true);
  const project = path.join(metadata.profile, ".projects/alpha");
  const chatId = `${project}#1`;
  client = await connect({ dataDir: metadata.profile, timeoutMs: 5000 });
  const events = [];
  runtime = await connectDesktopRuntime({
    connect: () => connect({ dataDir: metadata.profile, timeoutMs: 5000 }),
    emit: (channel, payload) => {
      if (channel === "agent:ports") events.push(payload);
    },
  });
  await runtime.openProject(project);
  const terminal = await runtime.invoke("terminal:open", [{ chatId }]);
  let output = "",
    offset = 0;
  async function readUntil(predicate) {
    while (!predicate(output)) {
      const read = await runtime.invoke("terminal:read", [{ terminalId: terminal.id, after: offset }]);
      output += read.data;
      offset = read.offset;
      assert.equal(read.ended, false);
    }
  }
  await runtime.invoke("terminal:input", [
    { terminalId: terminal.id, data: `stty -echo\nset +m\nprintf '\\nFIXTURE_SHELL=%s\\n' "$$"\n${quote(process.argv[3])} & fixture_listener=$!\n` },
  ]);
  await readUntil((text) => /FIXTURE_LISTENER_PID=\d+ PORT=\d+\r\n/.test(text));
  shellPid = Number(/\r\nFIXTURE_SHELL=(\d+)\r\n/.exec(output)[1]);
  const listener = /FIXTURE_LISTENER_PID=(\d+) PORT=(\d+)\r\n/.exec(output);
  listenerPid = Number(listener[1]);
  const port = Number(listener[2]);
  assert.notEqual(listenerPid, shellPid);
  await tcp(port);
  stage = "actual listener discovery and scoped events";
  const ports = await until("private terminal listener", async () => {
    const value = await runtime.invoke("chat:ports", [chatId]);
    return value.ports.some((item) => item.pid === listenerPid && item.port === port) ? value : null;
  });
  assert.equal(ports.chatId, chatId);
  assert.equal(ports.ports.find((item) => item.pid === listenerPid).address, "127.0.0.1");
  const all = await runtime.invoke("agent:ports");
  assert.deepEqual(Object.keys(all), [chatId]);
  assert.deepEqual(all[chatId], ports.ports);
  await until("agent:ports event", () => events.some((value) => value[chatId]?.some((item) => item.pid === listenerPid)));
  for (const request of [
    [chatId, child.pid],
    [chatId, process.pid],
    [chatId, shellPid],
    [`${project}#2`, listenerPid],
    [chatId, "bad"],
    [chatId, 0],
    [chatId, 1],
    [chatId, -1],
    [chatId, -shellPid],
  ]) {
    assert.equal(await runtime.invoke("agent:stop-port", request), false);
  }
  process.kill(listenerPid, 0);
  process.kill(shellPid, 0);
  stage = "viewer reconnect retains listener ownership";
  await runtime.close();
  runtime = null;
  await tcp(port);
  runtime = await connectDesktopRuntime({
    connect: () => connect({ dataDir: metadata.profile, timeoutMs: 5000 }),
    emit: (channel, payload) => {
      if (channel === "agent:ports") events.push(payload);
    },
  });
  await runtime.openProject(project);
  assert.deepEqual((await runtime.invoke("chat:ports", [chatId])).ports, ports.ports);
  const snapshot = await client.call("daemon:snapshot");
  assert.deepEqual(snapshot.ports, all);
  stage = "reviewed port stop ends its owned listener while preserving the terminal shell";
  assert.equal(await runtime.invoke("agent:stop-port", [chatId, listenerPid]), true);
  await until("listener process ended", () => {
    try {
      process.kill(listenerPid, 0);
      return false;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return true;
    }
  });
  await assert.rejects(tcp(port));
  await until("listener disappears from the periodic snapshot", async () => (await runtime.invoke("chat:ports", [chatId])).ports.length === 0);
  assert.deepEqual(await runtime.invoke("chat:ports", [chatId]), { chatId, ports: [] });
  await until("listener removal event", () => events.some((value) => !value[chatId]));
  process.kill(shellPid, 0);
  await runtime.invoke("terminal:input", [{ terminalId: terminal.id, data: "printf '\\nSHELL_STILL_ALIVE=%s\\n' \"$$\"\n" }]);
  await readUntil((text) => text.includes(`SHELL_STILL_ALIVE=${shellPid}\r\n`));
  assert.equal(await runtime.invoke("agent:stop-port", [chatId, listenerPid]), false);
  await runtime.invoke("terminal:close", [{ terminalId: terminal.id }]);
  console.log(
    "Port runtime conformance passed: real loopback listener, scoped ports/events, reconnect snapshot, refused unrelated PIDs, reviewed owned-listener stop, preserved PTY",
  );
}
run()
  .catch((error) => {
    console.error(`At ${stage}:`, error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await runtime?.close();
    client?.close();
    child.stdin.end();
    const [code] = await exited;
    if (code !== 0) {
      console.error(stderr);
      process.exitCode = 1;
    }
    // A just-closed PTY may need one OS scheduling turn to reap after the runtime exits.
    for (const pid of [listenerPid, shellPid].filter(Boolean)) {
      await until("fixture process reaped", () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
          return true;
        }
      });
    }
    clearTimeout(deadline);
    lines.close();
    if (metadata && (fs.existsSync(metadata.profile) || fs.existsSync(metadata.socket))) {
      console.error("Port runtime did not clean its temporary profile/socket");
      process.exitCode = 1;
    }
  });
