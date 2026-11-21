const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFile, execFileSync, fork, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { parseArgs } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { frameStats, rates, round, summary } = require("./simulator-metrics.cjs");

const root = path.resolve(__dirname, "../..");
const PATHS = ["desktop", "lan", "relay"];
const SCENES = ["still", "animate"];
const run = promisify(execFile);
class FixtureError extends Error {}

function options() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      platform: { type: "string", default: "ios" },
      device: { type: "string" },
      paths: { type: "string", default: PATHS.join(",") },
      scenes: { type: "string", default: SCENES.join(",") },
      seconds: { type: "string", default: "20" },
      taps: { type: "string", default: "30" },
      out: { type: "string" },
      visible: { type: "boolean", default: false },
    },
  });
  const list = (value, allowed, name) => {
    const items = value.split(",").filter(Boolean);
    const unknown = items.find((item) => !allowed.includes(item));
    if (unknown) throw new Error(`Unknown ${name} ${unknown}. Use ${allowed.join(", ")}.`);
    return items;
  };
  if (!["ios", "android"].includes(values.platform)) throw new Error("--platform is ios or android.");
  return {
    positionals,
    platform: values.platform,
    device: values.device,
    paths: list(values.paths, PATHS, "path"),
    scenes: list(values.scenes, SCENES, "scene"),
    seconds: Number(values.seconds),
    taps: Number(values.taps),
    out: values.out ?? path.join(os.tmpdir(), `milagre-perf-simulator-${Date.now()}.json`),
    visible: values.visible,
  };
}

function adbPath() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), "Library/Android/sdk");
  const candidate = path.join(sdk, "platform-tools/adb");
  return fs.existsSync(candidate) ? candidate : "adb";
}

async function pickDevice(platform, wanted) {
  if (platform === "ios") {
    const { stdout } = await run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
    const booted = Object.values(JSON.parse(stdout).devices).flat();
    const device = booted.find((item) => (wanted ? item.udid === wanted : /iPhone/.test(item.name)));
    if (!device) throw new Error(wanted ? `Simulator ${wanted} is not booted.` : "No booted iPhone simulator. Boot one (simslim boot <udid>) and rerun.");
    return device.udid;
  }
  const { stdout } = await run(adbPath(), ["devices"]);
  const serials = stdout.split("\n").flatMap((line) => (/^(emulator-\d+)\s+device$/.exec(line.trim()) ? [line.trim().split(/\s+/)[0]] : []));
  const serial = wanted ? serials.find((item) => item === wanted) : serials[0];
  if (!serial) throw new Error(wanted ? `Emulator ${wanted} is not running.` : "No running Android emulator. Start one and rerun.");
  return serial;
}

function serveFixture() {
  const page = fs.readFileSync(path.join(__dirname, "simulator-fixture.html"));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(page);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function showFixture(platform, device, port, scene) {
  const url = `http://127.0.0.1:${port}/?mode=${scene}&at=${Date.now()}`;
  if (platform === "ios") await run("xcrun", ["simctl", "openurl", device, url]);
  else {
    await run(adbPath(), ["-s", device, "reverse", `tcp:${port}`, `tcp:${port}`]);
    await run(adbPath(), ["-s", device, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'${url}'`]);
  }
}

function startHost(args, env) {
  const child = fork(path.join(__dirname, "simulator-host.cjs"), args, {
    execPath: process.env.SIM_BENCH_NODE || "node",
    env,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const ready = new Promise((resolve, reject) => {
    child.once("message", (message) => (message.error ? reject(new Error(message.error)) : resolve(message.ready)));
    child.once("exit", (code) => reject(new Error(`Host ${args[0]} exited with ${code}.`)));
  });
  return { child, ready };
}

async function stopHost(host) {
  if (!host || host.child.exitCode !== null) return;
  const exited = new Promise((resolve) => host.child.once("exit", resolve));
  host.child.kill("SIGTERM");
  await Promise.race([exited, delay(8000)]);
  if (host.child.exitCode === null) host.child.kill("SIGKILL");
}

function processTable() {
  const rows = execFileSync("ps", ["-Ao", "pid=,ppid=,time=,command="], { encoding: "utf8", maxBuffer: 1e8 }).split("\n");
  return rows.flatMap((row) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?\s+(.*)$/.exec(row);
    if (!match) return [];
    const [, pid, ppid, days, hours, minutes, seconds, fraction, command] = match;
    const cpu = Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(`${seconds}.${fraction ?? 0}`);
    return [{ pid: Number(pid), ppid: Number(ppid), cpu, command }];
  });
}

function descendants(rows, pid) {
  const found = [];
  const queue = [pid];
  while (queue.length) {
    const parent = queue.shift();
    for (const row of rows) {
      if (row.ppid !== parent) continue;
      found.push(row);
      queue.push(row.pid);
    }
  }
  return found;
}

function cpuSample(daemonPid, relayPid) {
  const rows = processTable();
  const sum = (items) => items.reduce((total, row) => total + row.cpu, 0);
  const daemon = rows.filter((row) => row.pid === daemonPid);
  const helper = descendants(rows, daemonPid);
  const hosts = new Set([...daemon, ...helper, ...rows.filter((row) => row.pid === relayPid)].map((row) => row.pid));
  const viewer = [...rows.filter((row) => row.pid === process.pid), ...descendants(rows, process.pid)].filter((row) => !hosts.has(row.pid));
  return { daemon: sum(daemon), helper: sum(helper), viewer: sum(viewer) };
}

async function until(read, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await delay(50);
  }
}

async function measure({ electron, host, relayUrl, relayPid, route, scene, seconds, taps, visible, work }) {
  const { BrowserWindow, ipcMain } = electron;
  const { openTransport, viewerHtml } = require("./simulator-viewer.cjs");
  const transport = await openTransport({ path: route, host, relayUrl });
  let frameType = null;
  ipcMain.removeHandler("simulator");
  ipcMain.handle("simulator", async (_event, method, request) => {
    const result = await transport.call(method, request);
    if (method === "frame" && result?.mimeType) frameType = result.mimeType;
    return result;
  });
  const page = path.join(work, `viewer-${route}-${scene}.html`);
  fs.writeFileSync(page, await viewerHtml({ device: host.device, chatId: host.chatId }));
  const window = new BrowserWindow({
    width: 460,
    height: 860,
    show: visible,
    webPreferences: {
      preload: path.join(__dirname, "simulator-preload.cjs"),
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      offscreen: !visible,
    },
  });
  if (!visible) window.webContents.setFrameRate(60);
  const frames = [];
  let startedAt = null;
  let colour = -1;
  let tapping = false;
  let tapsSeen = 0;
  const receiver = () => window.webContents.mainFrame.frames[0];
  const take = async () => {
    const taken = await receiver().executeJavaScript("window.benchTake()");
    startedAt ??= taken.startedAt;
    colour = taken.colour;
    tapping = taken.tapping;
    tapsSeen = taken.taps;
    frames.push(...taken.frames);
  };
  try {
    await window.loadFile(page);
    await until(async () => receiver() && (await receiver().executeJavaScript("typeof window.benchTake === 'function'")), "the receiver page", 10000);
    await until(async () => (await take(), frames.length > 0), "the first frame", 45000);
    const ttffMs = frames[0].paintedAt - startedAt;
    await until(async () => (await window.webContents.executeJavaScript("window.simState")) === "live", "control of the simulator", 30000);
    await until(async () => (await take(), colour >= 0), "the fixture page on the device", 20000).catch(() => {
      throw new FixtureError("The fixture page isn't on the device's screen. Unlock it and dismiss any first-run browser screens, then rerun.");
    });
    if (scene === "animate")
      await until(async () => (await take(), new Set(frames.slice(-6).map((frame) => frame.hash)).size >= 4), "the fixture to animate", 10000).catch(() => {
        throw new FixtureError("The fixture page isn't animating on the device.");
      });
    await delay(2000);
    await take();
    const previousHash = frames.at(-1)?.hash ?? null;
    const cpuBefore = cpuSample(host.pid, relayPid);
    const countBefore = { ...transport.counters };
    const from = Date.now();
    await delay(seconds * 1000);
    const to = Date.now();
    const cpuAfter = cpuSample(host.pid, relayPid);
    const countAfter = { ...transport.counters };
    await take();
    const passive = frameStats(frames, { from, to, moving: scene === "animate", previousHash });
    const tapResults = [];
    let misses = 0;
    for (let index = 0; index < taps; index++) {
      const target = await receiver().executeJavaScript("window.benchTarget()");
      const seen = tapsSeen;
      window.webContents.sendInputEvent({ type: "mouseDown", x: target.x, y: target.y, button: "left", clickCount: 1 });
      await delay(40);
      window.webContents.sendInputEvent({ type: "mouseUp", x: target.x, y: target.y, button: "left", clickCount: 1 });
      const answered = await until(async () => (await take(), tapsSeen > seen && !tapping), "tap", 3000).catch(() => false);
      const [tap] = await receiver().executeJavaScript("window.benchTaps()");
      if (answered && tap?.paintedAt) tapResults.push(tap);
      else {
        misses++;
        await delay(1000);
        await take();
      }
      await delay(300 + Math.random() * 400);
    }
    const wall = (to - from) / 1000;
    const counts = rates(countBefore, countAfter, wall);
    const last = frames.at(-1);
    return {
      frameType,
      paintedBy: last?.kind ?? null,
      frameSize: last ? `${last.width}x${last.height}` : null,
      ttffMs: round(ttffMs),
      tapToPhotonMs: summary(tapResults.map((tap) => tap.paintedAt - tap.at)),
      tapToDecodeMs: summary(tapResults.map((tap) => tap.decodedAt - tap.at)),
      tapMisses: misses,
      ...passive,
      viewerMessagesPerSec: counts.messages,
      viewerBytesPerSec: counts.bytes,
      wireBytesPerSec: route === "desktop" ? null : counts.wire,
      cpuPercent: Object.fromEntries(Object.entries(cpuAfter).map(([key, used]) => [key, round(((used - cpuBefore[key]) / wall) * 100)])),
    };
  } finally {
    await receiver()
      ?.executeJavaScript("window.simulatorDispose?.()")
      .catch(() => {});
    await delay(300);
    window.destroy();
    transport.close();
  }
}

async function bench(electron, settings) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-perf-simulator-")));
  const device = await pickDevice(settings.platform, settings.device);
  const fixture = await serveFixture();
  const env = { ...process.env, MILAGRE_BACKGROUND: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIM_BENCH;
  let relay;
  let host;
  const results = {};
  let deviceInfo;
  try {
    relay = startHost(["relay"], env);
    const { url: relayUrl } = await relay.ready;
    for (const route of settings.paths) {
      const hostRoot = path.join(work, route);
      fs.mkdirSync(hostRoot);
      const hostEnv = {
        ...env,
        MILAGRE_USER_DATA_DIR: path.join(hostRoot, "user-data"),
        MILAGRE_WORKTREE_ROOT: path.join(hostRoot, "worktrees"),
        MILAGRE_CHATS_HOME: path.join(hostRoot, "chats"),
      };
      host = startHost(["daemon", "--relay", relayUrl, "--device", device, "--root", hostRoot], hostEnv);
      const ready = await host.ready;
      deviceInfo = ready.device;
      for (const [index, scene] of settings.scenes.entries()) {
        const key = `${route}.${scene}`;
        for (let attempt = 1; ; attempt++) {
          await showFixture(settings.platform, device, fixture.address().port, scene);
          await delay(2500);
          console.log(`Measuring ${key}${attempt > 1 ? " again" : ""}...`);
          try {
            const measured = await measure({ electron, host: ready, relayUrl, relayPid: relay.child.pid, route, scene, ...settings, work });
            results[key] = { ...measured, cold: index === 0 && attempt === 1 };
            console.log(JSON.stringify({ [key]: summaryLine(results[key]) }));
            break;
          } catch (error) {
            if (attempt < 2 && error instanceof FixtureError) continue;
            results[key] = { error: error.message };
            console.error(`${key}: ${error.message}`);
            break;
          }
        }
      }
      await stopHost(host);
      host = null;
    }
  } finally {
    await stopHost(host);
    await stopHost(relay);
    if (settings.platform === "android") {
      await run(adbPath(), ["-s", device, "reverse", "--remove", `tcp:${fixture.address().port}`]).catch(() => {});
      await run(adbPath(), ["-s", device, "shell", "input", "keyevent", "KEYCODE_HOME"]).catch(() => {});
    }
    fixture.close();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
  return {
    scenario: "simulator",
    date: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    loadAverage: round(os.loadavg()[0]),
    platform: settings.platform,
    device: deviceInfo ? { name: deviceInfo.name, version: deviceInfo.version } : null,
    seconds: settings.seconds,
    taps: settings.taps,
    results,
  };
}

function summaryLine(result) {
  return {
    tapP50: result.tapToPhotonMs?.p50 ?? null,
    tapP95: result.tapToPhotonMs?.p95 ?? null,
    misses: result.tapMisses,
    ttffMs: result.ttffMs,
    paintedFps: result.paintedFps,
    changedFps: result.changedFps,
    freezesPerMin: result.freezesPerMinute,
    kBps: result.viewerBytesPerSec === null ? null : round(result.viewerBytesPerSec / 1024),
    cpu: result.cpuPercent,
  };
}

function table(result) {
  const rows = Object.entries(result.results).map(([key, value]) => {
    if (value.error) return { run: key, error: value.error };
    const { cpu, ...line } = summaryLine(value);
    return { run: key, ...line, ...Object.fromEntries(Object.entries(cpu).map(([kind, percent]) => [`${kind}Cpu`, percent])) };
  });
  console.table(rows);
}

async function electronMain() {
  const electron = require("electron");
  const settings = JSON.parse(process.env.SIM_BENCH);
  electron.app.dock?.hide();
  electron.app.on("window-all-closed", () => {});
  try {
    await electron.app.whenReady();
    const result = await bench(electron, settings);
    fs.writeFileSync(settings.out, `${JSON.stringify(result, null, 2)}\n`);
    table(result);
    console.log(`Saved ${settings.out}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    electron.app.quit();
  }
}

function main() {
  const settings = options();
  const [command, ...files] = settings.positionals;
  if (command === "compare" && files.length === 2) return require("./run.cjs").compare(...files);
  if (command)
    throw new Error(
      "Usage: simulator.cjs [--platform ios|android] [--device id] [--paths desktop,lan,relay] [--scenes still,animate] [--seconds n] [--taps n] [--out file] [--visible], or simulator.cjs compare before.json after.json",
    );
  const { electronPath } = require("./run.cjs");
  const env = { ...process.env, SIM_BENCH: JSON.stringify(settings), SIM_BENCH_NODE: process.execPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath(), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

if (process.versions.electron) void electronMain();
else if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
