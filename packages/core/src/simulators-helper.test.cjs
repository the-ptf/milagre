const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createSimulatorHelper, createSimulatorAdapter, resolveHelperPath } = require("./simulators-helper.cjs");
const DEVICE = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
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
  if (req.url.split('?')[0].endsWith('/stream.mjpeg')) {
    res.writeHead(200, {'content-type':'multipart/x-mixed-replace; boundary=frame'});
    const part=Buffer.concat([Buffer.from('--frame\\r\\nContent-Type: image/jpeg\\r\\nContent-Length: 6\\r\\n\\r\\n'),Buffer.from([255,216,1,2,255,217]),Buffer.from('\\r\\n')]);
    res.write(part); const interval=setInterval(()=>res.write(part),100);res.on('close',()=>clearInterval(interval));return;
  }
  if (req.url.split('?')[0].endsWith('/webrtc/close')) { res.writeHead(204).end(); return; }
  if (req.url.includes('/health')) { res.end(JSON.stringify({status:'streaming',size:{width:640,height:1280}})); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url.split('?')[0].endsWith('/webrtc/offer') ? {type:'answer',sdp:'v=0\\r\\nanswer'} : {}));
});
const wss = new WebSocketServer({ server, handleProtocols: (protocols) => [...protocols][0] });
wss.on('connection', (socket, req) => {
  log({ url: req.url, authenticated: req.headers['sec-websocket-protocol'] === (mode === 'android' ? 'serve-emu.token.' : 'serve-sim.token.') + token });
  const duo = mode.startsWith('duo');
  let hinge = {supportsHingeAngle:true,hingeAngle:0,hingePose:'closed'};
  let panel = {screenId:1,orientation:'portrait',physicalOrientation:'portrait',tableMode:false,observedDeviceState:{hingeAngle:0,physicalOrientation:'portrait'}};
  const config = () => socket.send(Buffer.concat([Buffer.from([0x82]), Buffer.from(JSON.stringify({width:588,height:1280,orientation:'portrait',inputUnavailable:mode==='unavailable',...(duo?{...hinge,...panel}:{})}))]));
  if (mode !== 'unadmitted' && mode !== 'android') {
    socket.send(Buffer.from([0x83])); if (mode !== 'admission-only') config();
    if (mode === 'unavailable') socket.send(Buffer.concat([Buffer.from([0x82]), Buffer.from(JSON.stringify({width:588,height:1280,orientation:'portrait'}))]));
  }
  socket.on('message', (bytes) => {
    if (mode === 'android') { log({gesture:JSON.parse(bytes.toString())}); return; }
    log({ tag: bytes[0], data: JSON.parse(bytes.subarray(1).toString()) });
    if(bytes[0]===16 && duo && mode!=='duo-timeout') {
      const {requestId,command}=JSON.parse(bytes.subarray(1).toString());
      setTimeout(()=>{
        const ok=mode==='duo'||mode==='duo-late-screen';
        if(ok) {
          hinge=command.control==='pose'?{supportsHingeAngle:true,hingeAngle:({closed:0,open:180,book:90,laptop:90,tent:80})[command.value],hingePose:command.value}:{supportsHingeAngle:true,hingeAngle:command.value};
          panel={...panel,tableMode:command.control==='pose'&&command.value==='tent',physicalOrientation:command.control==='angle'?panel.physicalOrientation:command.value==='tent'?'facedown':command.value==='laptop'?'landscape-left':'portrait'};
          config();
        }
        socket.send(Buffer.concat([Buffer.from([144]),Buffer.from(JSON.stringify({requestId,ok,error:'Pose failed'}))]));
        if(ok) {
          setTimeout(()=>{panel={...panel,observedDeviceState:{hingeAngle:Math.fround(hinge.hingeAngle),physicalOrientation:panel.physicalOrientation}};config();},0);
          setTimeout(()=>{
            const pose=command.control==='pose'?command.value:null;
            const screenId=pose?(pose==='closed'||pose==='tent'?1:3):hinge.hingeAngle===0?1:hinge.hingeAngle===180?3:panel.physicalOrientation==='facedown'?panel.screenId:3;
            const orientation=pose?(pose==='open'||pose==='book'?'landscape-left':'portrait'):screenId===panel.screenId||panel.physicalOrientation!=='portrait'?panel.orientation:screenId===3?'landscape-left':'portrait';
            panel={...panel,screenId,orientation};config();
          },mode==='duo-late-screen'?250:0);
        }
      },30);
    }
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
    displaySettleMs: 50,
    displayQuietMs: 20,
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

test("Duo hinge commands wait for matching acknowledgement and expose reported pose state", async (t) => {
  const f = await fixture(t, "duo"),
    channel = await f.helper.connect(DEVICE);
  await waitFor(() => channel.status().ready);
  assert.equal(channel.status().supportsHingeAngle, true);
  assert.equal(channel.status().hingePose, "closed");
  await channel.send({ kind: "pose", pose: "book" });
  assert.equal(channel.status().hingePose, "book");
  assert.equal(channel.status().hingeAngle, 90);
  await waitFor(async () => {
    await channel.frame(0);
    return channel.status().ready;
  });
  await channel.send({ kind: "hinge", angle: 123.4 });
  assert.equal(channel.status().hingeAngle, 123.4);
  await waitFor(async () => {
    await channel.frame(0);
    return channel.status().ready;
  });
  const commands = (await f.logs()).filter((entry) => entry.tag === 16).map((entry) => entry.data);
  assert.deepEqual(
    commands.map((entry) => entry.command),
    [
      { control: "pose", value: "book" },
      { control: "angle", value: 123.4 },
    ],
  );
  assert.notEqual(commands[0].requestId, commands[1].requestId);
  await assert.rejects(async () => channel.send({ kind: "hinge", angle: Infinity }), /invalid/i);
});

test("a Duo ACK leaves input disabled until native panel observation and fresh pixels arrive", async (t) => {
  const f = await fixture(t, "duo-late-screen", undefined, { displaySettleMs: 350, displayQuietMs: 60 }),
    channel = await f.helper.connect(DEVICE);
  await waitFor(() => channel.status().ready);
  const before = await channel.frame(0);
  await channel.send({ kind: "pose", pose: "open" });
  assert.equal(channel.status().ready, false, "the ACK still describes the old cover panel");
  assert.throws(() => channel.send({ kind: "button", button: "home" }), /not ready/i);
  const provisional = await channel.frame(before.sequence);
  assert.equal(channel.status().ready, false, "pixels arriving before the panel switches do not release input");
  await waitFor(async () => {
    await channel.frame(provisional.sequence);
    return channel.status().ready;
  });
  let after = provisional.sequence;
  for (const event of [
    { kind: "pose", pose: "laptop" },
    { kind: "pose", pose: "closed" },
  ]) {
    await channel.send(event);
    assert.equal(channel.status().ready, false);
    const pending = await channel.frame(after);
    after = pending.sequence;
    assert.equal(channel.status().ready, false, "native observation before the panel/rotation update is insufficient");
    await waitFor(async () => {
      const frame = await channel.frame(after);
      if (frame) after = frame.sequence;
      return channel.status().ready;
    });
  }
  await channel.send({ kind: "pose", pose: "tent" });
  await waitFor(async () => {
    const frame = await channel.frame(after);
    if (frame) after = frame.sequence;
    return channel.status().ready;
  });
  // Partial angles while held face-down retain the cover, even though the helper clears its table-mode hint.
  await channel.send({ kind: "hinge", angle: 90 });
  await waitFor(async () => {
    const frame = await channel.frame(after);
    if (frame) after = frame.sequence;
    return channel.status().ready;
  });
  // A flat angle selects the inner panel; its old portrait orientation is valid until Book rotates it.
  await channel.send({ kind: "hinge", angle: 180 });
  const flatFrame = await channel.frame(after);
  assert.equal(channel.status().ready, false);
  await waitFor(async () => {
    const frame = await channel.frame(flatFrame.sequence);
    if (frame) after = frame.sequence;
    return channel.status().ready;
  });
  await channel.send({ kind: "pose", pose: "book" });
  const bookFrame = await channel.frame(after);
  assert.equal(channel.status().ready, false, "the new inner panel alone does not prove its rotation has settled");
  await waitFor(async () => {
    const frame = await channel.frame(bookFrame.sequence);
    if (frame) after = frame.sequence;
    return channel.status().ready;
  });
  await channel.send({ kind: "pose", pose: "book" });
  assert.equal(channel.status().ready, false);
  await waitFor(async () => {
    await channel.frame(after);
    return channel.status().ready;
  });
  channel.send({ kind: "button", button: "home" });
});

for (const mode of ["duo-failure", "duo-timeout"])
  test(`${mode} does not acknowledge a successful pose`, async (t) => {
    const f = await fixture(t, mode, undefined, { hingeTimeoutMs: 100 }),
      channel = await f.helper.connect(DEVICE);
    await waitFor(() => channel.status().ready);
    await assert.rejects(channel.send({ kind: "pose", pose: "open" }), /pose|timed out/i);
    assert.equal(channel.status().hingePose, "closed");
    assert.equal(channel.status().ready, false);
    assert.match(channel.status().error, /pose change failed/i);
    assert.throws(() => channel.send({ kind: "button", button: "home" }), /not ready/i, "reconnect cannot reuse uncertain input geometry");
  });

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
  assert.deepEqual(offer.body, {
    type: "offer",
    sdp: "v=0\r\n",
    sessionId: "private-session",
    codec: "h264",
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
  });
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
    assert.equal(channel.status().deviceHubInputActive, shadowed || undefined);
    assert.equal(channel.status().inputBlocked, undefined, "the flag does not establish that touches are blocked");
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
  assert.equal(channel.status().deviceHubInputActive, undefined);
  shadowed = true;
  await waitFor(() => channel.status().deviceHubInputActive === true);
  shadowed = false;
  await waitFor(() => !channel.status().deviceHubInputActive);
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

test("unconfigured iOS video offers include STUN so peers can discover public candidates", async (t) => {
  const f = await fixture(t);
  await f.helper.connect(DEVICE);
  await f.helper.offer(DEVICE, "remote-viewer", "v=0\r\n");
  const offer = (await f.logs()).find((entry) => entry.url?.endsWith("/webrtc/offer"));
  assert.ok(offer.body.iceServers.some((server) => [server.urls].flat().some((url) => url.startsWith("stun:"))));
});

test("iOS frames are fetched privately from the helper stream and cancelled with capture", async (t) => {
  const f = await fixture(t);
  const channel = await f.helper.connect(DEVICE);
  const frame = await channel.frame(0, new AbortController().signal);
  assert.equal(frame.mimeType, "image/jpeg");
  assert.equal(frame.data, Buffer.from([255, 216, 1, 2, 255, 217]).toString("base64"));
  assert.ok((await f.logs()).some((entry) => entry.url?.endsWith("/stream.mjpeg") && entry.authenticated));
  await channel.close();
});

test("Android relay frames use a bounded screenshot command for the exact emulator", async (t) => {
  const commands = [];
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4u0AAAAASUVORK5CYII=", "base64");
  const f = await fixture(t, "android", async (file, args, options) => {
    commands.push({ file, args, options });
    return { stdout: args.includes("screencap") ? png : "" };
  });
  const channel = await f.helper.connect("emulator-5554");
  const frame = await channel.frame(0, new AbortController().signal);
  assert.equal(frame.mimeType, "image/png");
  assert.equal(frame.data, png.toString("base64"));
  const capture = commands.find((entry) => entry.args.includes("screencap"));
  assert.deepEqual(capture.args, ["-s", "emulator-5554", "exec-out", "screencap", "-p"]);
  assert.equal(capture.options.maxBuffer, 32 * 1024 * 1024);
  const healthCount = (await f.logs()).filter((entry) => entry.url?.includes("/health")).length;
  await waitFor(async () => (await f.logs()).filter((entry) => entry.url?.includes("/health")).length > healthCount);
  assert.equal(channel.status().width, 1, "encoded stream health must not replace snapshot geometry");
  assert.equal(channel.status().height, 1);
  await channel.close();
});

test("an Android capture failure makes the shared channel replaceable on reconnect", async (t) => {
  let captures = 0;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4u0AAAAASUVORK5CYII=", "base64");
  const f = await fixture(t, "android", async (_file, args) => {
    if (args.includes("screencap")) {
      if (++captures === 1) throw new Error("adb timed out");
      return { stdout: png };
    }
    return { stdout: "" };
  });
  const { createSimulators } = require("./simulators.cjs");
  const service = createSimulators({
    supported: true,
    adapter: { ...f.helper, list: async () => [{ id: "emulator-5554", platform: "android" }] },
  });
  t.after(() => service.close());
  const first = await service.open({ deviceId: "emulator-5554" }, "one");
  const second = await service.open({ deviceId: "emulator-5554" }, "two");
  await assert.rejects(service.frame({ viewerId: first.viewerId, after: 0 }, "one"), /frame|stream/i);
  const reopened = await service.open({ deviceId: "emulator-5554" }, "three");
  const frame = await service.frame({ viewerId: reopened.viewerId, after: 0 }, "three");
  assert.equal(frame.data, png.toString("base64"));
  await assert.rejects(service.status({ viewerId: second.viewerId }, "two"), /unknown/i, "a failed shared capture is not retained by another viewer");
});
