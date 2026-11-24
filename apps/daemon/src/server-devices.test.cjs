const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { startDaemon } = require("./server.cjs");
const { connect } = require("./client.cjs");

async function waitFor(read) {
  for (let i = 0; i < 400; i++) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  throw new Error("Timed out");
}

test("devices:list and devices:remove are desktop methods over the saved devices, and never reach the phone's bridge", async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-devices-")));
  const relays = [];
  const daemon = await startDaemon({
    dataDir,
    homeDir: dataDir,
    version: "test",
    phoneOptions: {
      localPort: 0,
      lanPort: null,
      startRelay: (options) => {
        relays.push(options);
        return { close: async () => {}, status: () => "online" };
      },
    },
    runtimeOptions: {
      cwd: dataDir,
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: Object.assign(async () => ({ command: null }), { invalidate() {} }),
    },
  });
  const desktop = await connect({ dataDir });
  t.after(async () => {
    desktop.close();
    await daemon.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const methods = (await desktop.call("daemon:status")).methods;
  for (const method of ["devices:list", "devices:remove"]) assert.ok(methods.includes(method), method);
  assert.deepEqual(await desktop.call("devices:list"), []);

  await desktop.call("phone:set-enabled", [true]);
  const on = await waitFor(async () => {
    const status = await desktop.call("phone:status");
    return status.state === "on" && status;
  });
  const key = "k".repeat(43);
  await relays[0].phones.add(key, { kind: "phone", name: "Victor's iPhone" });
  const [device] = await desktop.call("devices:list");
  assert.deepEqual(
    { ...device, pairedAt: typeof device.pairedAt, lastSeen: typeof device.lastSeen },
    { key, kind: "phone", name: "Victor's iPhone", pairedAt: "number", lastSeen: "number", isNew: true, route: null },
  );

  // The phone's own bridge never manages devices, its own or another's.
  const token = new URL(on.pairingLink).searchParams.get("token");
  for (const [method, args] of [
    ["devices:list", []],
    ["devices:remove", [key]],
    ["devices:take-notices", []],
    ["devices:confirm-notices", ["n1"]],
    ["devices:acknowledge", [[key]]],
  ]) {
    const response = await fetch(on.localUrl + "/rpc", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ v: 1, method, args }),
    });
    assert.equal(response.status, 403, method);
  }
  assert.equal((await desktop.call("devices:list")).length, 1);

  assert.deepEqual(await desktop.call("devices:remove", [key]), []);
  assert.deepEqual(await desktop.call("devices:list"), []);
  await assert.rejects(desktop.call("devices:remove", ["nope"]), /device key/);
});

/** A daemon whose relay host is a stand-in that only records its options, and this Mac's window connected to it. */
async function withRelays(t) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-devices-")));
  const relays = [];
  const daemon = await startDaemon({
    dataDir,
    homeDir: dataDir,
    version: "test",
    phoneOptions: {
      localPort: 0,
      lanPort: null,
      startRelay: (options) => {
        relays.push(options);
        return { close: async () => {}, status: () => "online" };
      },
    },
    runtimeOptions: {
      cwd: dataDir,
      environmentReady: Promise.resolve(),
      titleModels: {},
      agentCli: Object.assign(async () => ({ command: null }), { invalidate() {} }),
    },
  });
  const desktop = await connect({ dataDir });
  t.after(async () => {
    desktop.close();
    await daemon.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { desktop, relays };
}

test("a computer waiting for Allow reaches this Mac's window as devices:pending, answered by devices:allow and devices:deny", async (t) => {
  const { desktop, relays } = await withRelays(t);
  const heard = [];
  desktop.on("event", ({ channel, payload }) => {
    if (channel === "devices:pending") heard.push(payload.requests);
  });
  const methods = (await desktop.call("daemon:status")).methods;
  for (const method of ["devices:pending", "devices:allow", "devices:deny"]) assert.ok(methods.includes(method), method);
  assert.deepEqual(await desktop.call("devices:pending"), []);
  await desktop.call("phone:set-enabled", [true]);
  await waitFor(async () => (await desktop.call("phone:status")).state === "on");
  const ask = (key, name) => relays[0].allowComputer({ key, name, signal: new AbortController().signal, waiting() {} });
  const studio = ask("s".repeat(43), "studio");
  const lab = ask("l".repeat(43), "lab");
  await waitFor(() => heard.at(-1)?.length === 2);
  assert.deepEqual(
    (await desktop.call("devices:pending")).map((request) => request.name),
    ["studio", "lab"],
  );
  assert.deepEqual(
    (await desktop.call("devices:allow", ["s".repeat(43)])).map((request) => request.name),
    ["lab"],
  );
  assert.equal(await studio, "allowed");
  assert.deepEqual(await desktop.call("devices:deny", ["l".repeat(43)]), []);
  assert.equal(await lab, "denied");
  await waitFor(() => heard.at(-1)?.length === 0);
  await assert.rejects(desktop.call("devices:allow", ["s".repeat(43)]), /no longer waiting/);
});

test("a phone that pairs while no window is connected is announced once to the next window, even after a daemon restart", async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-devices-")));
  const relays = [];
  const start = () =>
    startDaemon({
      dataDir,
      homeDir: dataDir,
      version: "test",
      phoneOptions: {
        localPort: 0,
        lanPort: null,
        startRelay: (options) => {
          relays.push(options);
          return { close: async () => {}, status: () => "online" };
        },
      },
      runtimeOptions: {
        cwd: dataDir,
        environmentReady: Promise.resolve(),
        titleModels: {},
        agentCli: Object.assign(async () => ({ command: null }), { invalidate() {} }),
      },
    });
  let daemon = await start();
  const open = [];
  t.after(async () => {
    for (const client of open) client.close();
    await daemon.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const window = async () => {
    const client = await connect({ dataDir });
    open.push(client);
    return client;
  };
  const owner = await window();
  for (const method of ["devices:take-notices", "devices:confirm-notices", "devices:acknowledge"])
    assert.ok((await owner.call("daemon:status")).methods.includes(method), method);
  await owner.call("phone:set-enabled", [true]);
  await waitFor(async () => (await owner.call("phone:status")).state === "on");
  owner.close();

  // The phone pairs with no window connected, and the daemon restarts before one comes back.
  const key = "n".repeat(43);
  await relays.at(-1).phones.add(key, { kind: "phone", name: "Victor's iPhone" });
  await daemon.close();
  daemon = await start();

  // A window takes it and its connection drops before it can show it (the reply was lost): nothing is lost.
  const lost = await window();
  assert.deepEqual(
    (await lost.call("devices:take-notices")).devices.map((device) => device.key),
    [key],
  );
  lost.close();

  // Two windows ask at once: only one of them shows it, and confirms it.
  const [first, second] = await Promise.all([window(), window()]);
  let taken = [];
  for (let n = 0; n < 200 && !taken.some((reply) => reply.claim); n++) {
    taken = await Promise.all([first.call("devices:take-notices"), second.call("devices:take-notices")]);
    if (!taken.some((reply) => reply.claim)) await delay(10); // the dropped connection's close is still on its way
  }
  assert.deepEqual(
    taken.flatMap((reply) => reply.devices).map((device) => [device.key, device.name]),
    [[key, "Victor's iPhone"]],
  );
  const shower = taken[0].claim ? first : second;
  assert.equal(await shower.call("devices:confirm-notices", [taken.find((reply) => reply.claim).claim]), 1);
  assert.deepEqual(await first.call("devices:take-notices"), { claim: null, devices: [] });
  await assert.rejects(first.call("devices:confirm-notices", [42]), /notice claim/);

  // Settings › Phone & sharing shows it as New until the window says the owner saw it.
  assert.equal((await first.call("devices:list"))[0].isNew, true);
  const [after] = await first.call("devices:acknowledge", [[key]]);
  assert.equal(after.isNew, false);
  assert.equal((await second.call("devices:list"))[0].isNew, false);
  await assert.rejects(first.call("devices:acknowledge", ["nope"]), /device keys/);
  await assert.rejects(first.call("devices:acknowledge", [["nope"]]), /device keys/);
});
