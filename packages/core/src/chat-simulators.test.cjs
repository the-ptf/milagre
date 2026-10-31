const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createChatSimulators, simulatorToolDefinitions } = require("./chat-simulators.cjs");
const A = { id: "ios-a", name: "iPhone A", platform: "ios", version: "27" };
const B = { id: "emulator-5554", name: "Pixel", platform: "android", version: "16" };
async function fixture(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-simulators-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const closed = [],
    inputs = [],
    opened = [];
  let running = [A, B];
  const simulators = {
    list: async () => ({ devices: running, supported: true }),
    open: async (r, o) => {
      opened.push([r, o]);
      return { viewerId: `v${opened.length}` };
    },
    closeViewer: async (r, o) => {
      closed.push([r, o]);
    },
    input: async (r) => {
      inputs.push(r);
      return { accepted: true };
    },
    disconnect: async () => {},
    close: async () => {},
  };
  const options = {
    simulators,
    file: path.join(dir, "attachments.json"),
    validateChat: async (id) => {
      if (!["chat-a", "chat-b"].includes(id)) throw Error("Unknown Chat");
    },
    ...extra,
  };
  return {
    api: createChatSimulators(options),
    reopen: () => createChatSimulators(options),
    running: (d) => {
      running = d;
    },
    closed,
    inputs,
    opened,
  };
}
test("discovery never attaches; explicit associations are isolated and survive restart", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.api.list({ chatId: "chat-a" })).devices, []);
  assert.equal((await f.api.list({ chatId: "chat-a" })).available.length, 2);
  await f.api.attach({ chatId: "chat-a", deviceId: A.id });
  await f.api.attach({ chatId: "chat-a", deviceId: A.id });
  assert.deepEqual((await f.reopen().list({ chatId: "chat-a" })).devices, [A]);
  assert.deepEqual((await f.api.list({ chatId: "chat-b" })).devices, []);
  assert.equal(f.opened.length, 0);
  await assert.rejects(f.api.attach({ chatId: "new", deviceId: A.id }), /Chat/);
  await assert.rejects(f.api.attach({ chatId: "chat-a", deviceId: "unknown" }), /device/i);
});
test("detach revokes only this Chat viewers and never powers down a device", async (t) => {
  const f = await fixture(t);
  for (const chatId of ["chat-a", "chat-b"]) await f.api.attach({ chatId, deviceId: A.id });
  const a = await f.api.open({ chatId: "chat-a", deviceId: A.id }, "owner-a");
  const b = await f.api.open({ chatId: "chat-b", deviceId: A.id }, "owner-b");
  await assert.rejects(f.api.input(a, "owner-b"), /viewer|owner/i);
  await f.api.detach({ chatId: "chat-a", deviceId: A.id });
  assert.deepEqual(f.closed, [[a, "owner-a"]]);
  await assert.rejects(f.api.input(a, "owner-a"), /viewer|attached/i);
  assert.deepEqual(await f.api.input(b, "owner-b"), { accepted: true });
  await assert.rejects(f.api.open({ chatId: "chat-a", deviceId: A.id }, "owner-a"), /attached/i);
});
test("stopped devices stay detachable and recycled Android serials do not inherit an attachment", async (t) => {
  const f = await fixture(t);
  await f.api.attach({ chatId: "chat-a", deviceId: B.id });
  f.running([{ ...B, name: "Unrelated AVD" }]);
  const list = await f.api.list({ chatId: "chat-a" });
  assert.equal(list.devices.length, 0);
  assert.deepEqual(list.attached, [B]);
  await f.api.detach({ chatId: "chat-a", deviceId: B.id });
  assert.equal((await f.api.list({ chatId: "chat-a" })).attached.length, 0);
});
test("agent tools bind mutations to their own Chat even if another Chat is supplied", async (t) => {
  const f = await fixture(t),
    tools = simulatorToolDefinitions("chat-a", f.api);
  const { runTool } = require("./linked-tools.cjs");
  const tool = tools.find((x) => x.name === "simulator_attach");
  assert.equal((await runTool(tool, { deviceId: A.id, chatId: "chat-b" })).isError, false);
  assert.equal((await f.api.list({ chatId: "chat-a" })).devices.length, 1);
  assert.equal((await f.api.list({ chatId: "chat-b" })).devices.length, 0);
});

test("detach revokes every viewer even when an older viewer has already expired", async (t) => {
  const { createSimulators } = require("./simulators.cjs");
  let time = 0;
  const events = [];
  const underlying = createSimulators({
    supported: true,
    now: () => time,
    adapter: {
      list: async () => [A],
      connect: async () => ({
        status: () => ({ width: 100, height: 200, orientation: "portrait", ready: true }),
        send: (e) => events.push(e),
        close: async () => {},
      }),
      closeViewer: async () => {},
      stop: async () => {},
    },
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-sim-expired-"));
  const api = createChatSimulators({ simulators: underlying, file: path.join(dir, "attachments.json"), validateChat: async () => {} });
  t.after(async () => {
    await api.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await api.attach({ chatId: "a", deviceId: A.id });
  await api.open({ chatId: "a", deviceId: A.id }, "old");
  time = 20000;
  const live = await api.open({ chatId: "a", deviceId: A.id }, "live");
  time = 31000;
  const status = await api.control({ ...live, takeOver: false }, "live");
  await api.detach({ chatId: "a", deviceId: A.id });
  await assert.rejects(
    api.input({ ...live, generation: status.generation, sequence: 1, event: { kind: "button", button: "home" } }, "live"),
    /viewer|detached/,
  );
  assert.equal(events.length, 0);
});

test("shutdown stops the underlying helper while an open is still pending", async (t) => {
  const f = await fixture(t);
  let release, entered;
  const opening = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let stopped = false;
  const api = createChatSimulators({
    file: path.join(os.tmpdir(), `unused-${Date.now()}.json`),
    validateChat: async () => {},
    simulators: {
      list: async () => {
        entered();
        return opening;
      },
      close: async () => {
        stopped = true;
        release({ devices: [], supported: true });
      },
    },
  });
  const pending = api.list({ chatId: "a" });
  await started;
  const closed = api.close();
  assert.equal(stopped, true);
  await closed;
  await pending;
  await f.api.close();
});

test("a Chat with nothing attached is answered without listing devices when it asks only for attached ones", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-simulators-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let listed = 0;
  let supported = true;
  const api = createChatSimulators({
    file: path.join(dir, "attachments.json"),
    validateChat: async (id) => {
      if (!["chat-a", "chat-b"].includes(id)) throw Error("Unknown Chat");
    },
    simulators: {
      list: async () => {
        listed++;
        return { devices: supported ? [A, B] : [], supported };
      },
      closeViewer: async () => {},
      disconnect: async () => {},
      close: async () => {},
    },
  });
  t.after(() => api.close());
  assert.deepEqual(await api.list({ chatId: "chat-a", attachedOnly: true }), { chatId: "chat-a", attached: [], devices: [], available: [], supported: true });
  assert.equal(listed, 0, "no device list for a Chat with nothing attached");
  await assert.rejects(api.list({ chatId: "unknown", attachedOnly: true }), /Chat/, "the Chat is still checked");
  // The agent's simulator_list and a plain list still see every running device.
  const [tool] = simulatorToolDefinitions("chat-a", api);
  assert.equal(JSON.parse(await tool.run({})).available.length, 2);
  assert.equal((await api.list({ chatId: "chat-a" })).available.length, 2);
  assert.equal(listed, 2);
  // Once something is attached, the Chat's list names its running devices again.
  await api.attach({ chatId: "chat-a", deviceId: A.id });
  const attached = await api.list({ chatId: "chat-a", attachedOnly: true });
  assert.deepEqual([attached.devices, attached.available.length], [[A], 1]);
  assert.equal(listed, 5, "attach lists twice, then this list once");
  // A host that can't show simulators says so, as its last list did.
  supported = false;
  await api.list({ chatId: "chat-b" });
  assert.equal((await api.list({ chatId: "chat-b", attachedOnly: true })).supported, false);
  assert.equal(listed, 6);
});
test("a leased device that ended leaves the Chat, while a stopped local device stays", async (t) => {
  const LEASE = { id: "simlock:l1", name: "iPhone 17 (Simlock)", platform: "ios", version: "27.0" };
  const f = await fixture(t, { ended: (device) => device.id.startsWith("simlock:") });
  f.running([A, LEASE]);
  await f.api.attach({ chatId: "chat-a", deviceId: A.id });
  await f.api.attach({ chatId: "chat-a", deviceId: LEASE.id });
  f.running([]);
  const list = await f.api.list({ chatId: "chat-a" });
  assert.deepEqual(list.attached, [A]);
  assert.deepEqual((await f.reopen().list({ chatId: "chat-a" })).attached, [A]);
});
