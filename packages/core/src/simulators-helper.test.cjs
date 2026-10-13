const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createSimulatorHelper, createSimulatorAdapter, resolveHelperPath } = require("./simulators-helper.cjs");
const DEVICE = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for helper state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t, mode = "normal", execFile = async () => ({ stdout: "" }), extra = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "milagre-simulator-test-"));
  const log = path.join(dir, "log.jsonl"),
    address = path.join(dir, "address.json");
  const helperPath = path.join(dir, "helper.cjs");
  await writeFile(
    helperPath,
    `
const http = require('node:http');
const fs = require('node:fs');
const { WebSocketServer } = require(${JSON.stringify(require.resolve("ws"))});
const token = 'test-private-helper-token';
const mode = ${JSON.stringify(mode)};
const log = (entry) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + '\\n');
const server = http.createServer(async (req, res) => {
  let data = ''; for await (const chunk of req) data += chunk;
  const authenticated = req.headers.authorization === 'Bearer ' + token;
  log({ url: req.url, method: req.method, authenticated, body: data ? JSON.parse(data) : null });
  if (!authenticated) { res.writeHead(401).end(); return; }
  if (req.url.split('?')[0].endsWith('/webrtc/close')) { res.writeHead(204).end(); return; }
  if (req.url.includes('/health')) { res.end(JSON.stringify({status:'streaming',size:{width:640,height:1280}})); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url.split('?')[0].endsWith('/webrtc/offer') ? {type:'answer',sdp:'v=0\\r\\nanswer'} : {}));
});
const wss = new WebSocketServer({ server, handleProtocols: (protocols) => [...protocols][0] });
wss.on('connection', (socket, req) => {
  log({ url: req.url, authenticated: req.headers['sec-websocket-protocol'] === (mode === 'android' ? 'serve-emu.token.' : 'serve-sim.token.') + token });
  const config = () => socket.send(Buffer.concat([Buffer.from([0x82]), Buffer.from(JSON.stringify({width:588,height:1280,orientation:'portrait',inputUnavailable:mode==='unavailable'}))]));
  if (mode !== 'unadmitted' && mode !== 'android') {
    socket.send(Buffer.from([0x83])); if (mode !== 'admission-only') config();
    if (mode === 'unavailable') socket.send(Buffer.concat([Buffer.from([0x82]), Buffer.from(JSON.stringify({width:588,height:1280,orientation:'portrait'}))]));
  }
  socket.on('message', (bytes) => {
    if (mode === 'android') { log({gesture:JSON.parse(bytes.toString())}); return; }
    log({ tag: bytes[0], data: JSON.parse(bytes.subarray(1).toString()) });
    if(bytes[0]===7) socket.send(Buffer.concat([Buffer.from([0x82]),Buffer.from(JSON.stringify({width:588,height:1280,orientation:'landscape_left'}))]));
  });
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(${JSON.stringify(address)}, JSON.stringify({port:server.address().port,pid:process.pid}));
  if (mode === 'split-token') {
    process.stdout.write('Expo Device Hub ready\\n\\n  Local: http://localhost:' + server.address().port + '/?token=test-');
    setTimeout(() => process.stdout.write('private-helper-token\\n'), 15);
  } else console.log('Expo Device Hub ready\\n\\n  Local: http://localhost:' + server.address().port + '/?token=' + token);
});
`,
  );
  const helper = createSimulatorHelper({
    platform: mode === "android" ? "android" : "ios",
    helperPath,
    execFile,
    admissionTimeoutMs: 1000,
    startupTimeoutMs: 10000,
    idleMs: 0,
    ...extra,
  });
  t.after(async () => {
    await helper.stop();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    helper,
    helperPath,
    dir,
    address,
    async logs() {
      return (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    },
  };
}

test("unpacks the entire helper package path for native framework loading", () => {
  assert.equal(
    resolveHelperPath("/Applications/Milagre.app/Contents/Resources/app.asar/node_modules/expo-device-hub/package.json"),
    "/Applications/Milagre.app/Contents/Resources/app.asar.unpacked/node_modules/expo-device-hub/dist/server/cli.mjs",
  );
});

test("helper uses private loopback authentication, exact query socket route and bounded typed packets", async (t) => {
  const f = await fixture(t),
    channel = await f.helper.connect(DEVICE);
  await waitFor(() => channel.status().ready);
  assert.deepEqual(channel.status(), { width: 588, height: 1280, orientation: "portrait", ready: true });
  channel.send({
    kind: "touch",
    phase: "begin",
    points: [
      { x: 0.2, y: 0.3 },
      { x: 0.7, y: 0.8 },
    ],
  });
  channel.send({ kind: "rotate", orientation: "landscape-left" });
  await waitFor(() => channel.status().orientation === "landscape-left");
  assert.equal(channel.status().orientation, "landscape-left");
  assert.deepEqual(await f.helper.offer(DEVICE, "private-session", "v=0\r\n"), { type: "answer", sdp: "v=0\r\nanswer" });
  await f.helper.closeViewer(DEVICE, "private-session");
  const logs = await f.logs();
  assert.deepEqual(logs[0], { url: "/vendor/serve-sim/helper/ws?device=" + DEVICE, authenticated: true });
  assert.deepEqual(logs.find((entry) => entry.tag === 5).data, { type: "begin", x1: 0.2, y1: 0.3, x2: 0.7, y2: 0.8 });
  const offer = logs.find((entry) => entry.url?.endsWith("/webrtc/offer"));
  assert.equal(offer.url, "/vendor/serve-sim/helper/" + DEVICE + "/webrtc/offer");
  assert.equal(offer.authenticated, true);
  assert.deepEqual(offer.body, { type: "offer", sdp: "v=0\r\n", sessionId: "private-session", codec: "h264", iceServers: [] });
  assert.deepEqual(logs.find((entry) => entry.url?.endsWith("/webrtc/close")).body, { sessionId: "private-session" });
  const { port, pid } = JSON.parse(await readFile(f.address, "utf8"));
  assert.equal((await fetch("http://127.0.0.1:" + port + "/api/devices")).status, 401);
  await channel.close();
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await assert.rejects(fetch("http://127.0.0.1:" + port), /fetch failed/);
});

test("socket open without an admission/config frame never becomes ready", async (t) => {
  const f = await fixture(t, "unadmitted");
  await assert.rejects(f.helper.connect(DEVICE), /admission|ready|input/i);
});

test("native inputUnavailable is reported as unavailable even after admission", async (t) => {
  const f = await fixture(t, "unavailable");
  const channel = await f.helper.connect(DEVICE);
  await waitFor(() => !!channel.status().error);
  assert.equal(channel.status().ready, false);
  assert.match(channel.status().error, /unavailable/);
});

test("helper crash is isolated and a new connect starts a fresh child", async (t) => {
  const f = await fixture(t),
    channel = await f.helper.connect(DEVICE);
  const { pid } = JSON.parse(await readFile(f.address, "utf8"));
  process.kill(pid, "SIGKILL");
  await waitFor(() => !!channel.status().error);
  assert.equal(channel.status().ready, false);
  assert.match(channel.status().error, /Reopen the viewer/);
  await channel.close();
  const second = await f.helper.connect(DEVICE);
  await waitFor(() => second.status().ready);
  assert.equal(second.status().ready, true);
  assert.notEqual(JSON.parse(await readFile(f.address, "utf8")).pid, pid);
});

test("helper outlives its last viewer for the idle window, so reopening reuses it", async (t) => {
  const f = await fixture(t, "normal", undefined, { idleMs: 300 });
  await (await f.helper.connect(DEVICE)).close();
  const { pid } = JSON.parse(await readFile(f.address, "utf8"));
  process.kill(pid, 0);
  const second = await f.helper.connect(DEVICE);
  await waitFor(() => second.status().ready);
  assert.equal(JSON.parse(await readFile(f.address, "utf8")).pid, pid);
  await new Promise((resolve) => setTimeout(resolve, 400));
  process.kill(pid, 0);
  await second.close();
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
});

test("discovery filters running iOS devices and never spawns the helper", async (t) => {
  let calls = 0;
  const helper = createSimulatorHelper({
    execFile: async (file, args) => {
      calls++;
      assert.equal(file, "/usr/bin/xcrun");
      assert.deepEqual(args, ["simctl", "list", "devices", "booted", "--json"]);
      return {
        stdout: JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
              {
                udid: DEVICE,
                name: "My QA device",
                deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro",
                state: "Booted",
                isAvailable: true,
              },
              { udid: "off", name: "Off", state: "Shutdown", isAvailable: true },
            ],
            "com.apple.CoreSimulator.SimRuntime.watchOS-27-0": [{ udid: "watch", name: "Watch", state: "Booted", isAvailable: true }],
          },
        }),
      };
    },
    spawn: () => {
      throw new Error("Discovery started helper");
    },
  });
  t.after(() => helper.stop());
  assert.deepEqual(await helper.list(), [
    { id: DEVICE, name: "My QA device", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", platform: "ios", version: "27.0" },
  ]);
  await helper.list();
  assert.equal(calls, 1);
});

test("Device Hub's input flag is reported, never repaired on connect, and repair runs only on request", async (t) => {
  for (const shadowed of [true, false]) {
    const calls = [];
    const f = await fixture(t, "normal", async (file, args) => {
      calls.push([file, ...args].join(" "));
      return { stdout: args.includes("-g") ? `com.apple.coredevice.dtuhidd.active ${shadowed ? 1 : 0}\n` : "" };
    });
    const channel = await f.helper.connect(DEVICE);
    await waitFor(() => channel.status().ready);
    assert.equal(channel.status().inputBlocked, shadowed || undefined);
    const spawn = `/usr/bin/xcrun simctl spawn ${DEVICE}`;
    assert.deepEqual(calls, [`${spawn} notifyutil -g com.apple.coredevice.dtuhidd.active`]);
    await f.helper.repairInput(DEVICE);
    assert.deepEqual(calls.slice(1), [
      `${spawn} notifyutil -s com.apple.coredevice.dtuhidd.active 0`,
      `${spawn} launchctl kickstart -k system/com.apple.backboardd`,
    ]);
    await channel.close();
  }
});

test("the input flag is read again while a viewer stays open", async (t) => {
  let shadowed = false;
  const f = await fixture(
    t,
    "normal",
    async (_file, args) => ({ stdout: `com.apple.coredevice.dtuhidd.active ${shadowed && args.includes("-g") ? 1 : 0}\n` }),
    {
      inputCheckMs: 20,
    },
  );
  const channel = await f.helper.connect(DEVICE);
  await waitFor(() => channel.status().ready);
  assert.equal(channel.status().inputBlocked, undefined);
  shadowed = true;
  await waitFor(() => channel.status().inputBlocked === true);
  await channel.close();
});

test("admission alone allows open so offer can start capture, but input waits for config", async (t) => {
  const f = await fixture(t, "admission-only");
  const channel = await f.helper.connect(DEVICE);
  assert.equal(channel.status().ready, false);
  assert.throws(() => channel.send({ kind: "button", button: "home" }), /ready/);
});

test("startup parsing waits for the whole token when stdout splits mid-line", async (t) => {
  const f = await fixture(t, "split-token");
  const channel = await f.helper.connect(DEVICE);
  const entries = await f.logs();
  assert.equal(entries[0].authenticated, true);
  await channel.close();
});

// Catches iOS-only routing, lost pointer identities and client-controlled Android ICE.
test("Android helper uses authenticated input-only JSON socket and host-configured signaling", async (t) => {
  const f = await fixture(t, "android");
  const channel = await f.helper.connect("emulator-5554");
  await waitFor(() => channel.status().ready);
  assert.equal(channel.status().width, 640);
  channel.send({
    kind: "touch",
    phase: "begin",
    points: [
      { x: 0.2, y: 0.3 },
      { x: 0.7, y: 0.8 },
    ],
  });
  channel.send({ kind: "button", button: "back" });
  await f.helper.offer("emulator-5554", "private-session", "v=0\r\n");
  const logs = await f.logs();
  assert.ok(logs.some((x) => x.url === "/vendor/serve-emu/ws?device=emulator-5554&video=0" && x.authenticated));
  assert.deepEqual(
    logs.filter((x) => x.gesture).map((x) => x.gesture),
    [{ type: "touch", action: "down", pointerId: 0, x: 0.2, y: 0.3 }, { type: "touch", action: "down", pointerId: 1, x: 0.7, y: 0.8 }, { type: "back" }],
  );
  const offer = logs.find((x) => x.url?.includes("/webrtc/offer"));
  assert.equal(offer.url, "/vendor/serve-emu/webrtc/offer?device=emulator-5554");
  assert.equal("iceServers" in offer.body, false);
  await channel.close();
});
test("fleet discovers only ready emulators and tolerates unavailable Xcode", async (t) => {
  const adapter = createSimulatorAdapter({
    execFile: async (file, args) => {
      if (file === "/usr/bin/xcrun") throw new Error("no Xcode");
      if (args[0] === "devices") return { stdout: "List of devices attached\nemulator-5554 device\nemulator-5556 offline\nphysical-device device\n" };
      if (args.includes("emu")) return { stdout: "Pixel_Test\nOK\n" };
      return { stdout: "16\n" };
    },
    spawn: () => {
      throw new Error("Discovery must not start capture");
    },
  });
  t.after(() => adapter.stop());
  assert.deepEqual(await adapter.list(), [{ id: "emulator-5554", name: "Pixel_Test", platform: "android", version: "16" }]);
  await assert.rejects(adapter.connect("physical-device"), /device/i);
});

test("closing one Android device ends its capture while another remains connected", async (t) => {
  const f = await fixture(t, "android");
  const adapter = createSimulatorAdapter({ helperPath: f.helperPath, idleMs: 0 });
  t.after(() => adapter.stop());
  const first = await adapter.connect("emulator-5554");
  const a = JSON.parse(await readFile(f.address, "utf8"));
  const second = await adapter.connect("emulator-5556");
  const b = JSON.parse(await readFile(f.address, "utf8"));
  assert.notEqual(a.pid, b.pid);
  await first.close();
  assert.throws(() => process.kill(a.pid, 0), /ESRCH/);
  assert.doesNotThrow(() => process.kill(b.pid, 0));
  assert.equal(second.status().ready, true);
  await second.close();
});
