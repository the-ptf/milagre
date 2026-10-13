const { spawn: spawnProcess, execFile: execFileCallback } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const PREFIX = "/vendor/serve-sim/helper";
const UUID = /^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/;
const EMULATOR = /^emulator-[0-9]{4,5}$/;
const ORIENTATIONS = new Set(["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]);

function resolveHelperPath(packagePath = require.resolve("expo-device-hub/package.json")) {
  // Execute the whole package outside ASAR: native libraries resolve siblings.
  return path.join(path.dirname(packagePath.replace(/\.asar([/\\])/, ".asar.unpacked$1")), "dist", "server", "cli.mjs");
}
function configuredIceServers(env) {
  const urls = (env.MILAGRE_SIMULATOR_TURN_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (!urls.length) return [];
  if (urls.length > 8 || urls.some((url) => url.length > 2048 || !/^turns?:[^\s]+$/i.test(url))) throw new Error("Invalid simulator TURN configuration.");
  const username = env.MILAGRE_SIMULATOR_TURN_USERNAME;
  const credential = env.MILAGRE_SIMULATOR_TURN_CREDENTIAL;
  if (!username || !credential || username.length > 512 || credential.length > 2048) throw new Error("Simulator TURN credentials are missing or invalid.");
  return [{ urls, username, credential }];
}
function packet(event) {
  if (event.kind === "touch") {
    const [a, b] = event.points;
    return b ? [5, { type: event.phase, x1: a.x, y1: a.y, x2: b.x, y2: b.y }] : [3, { type: event.phase, x: a.x, y: a.y }];
  }
  if (event.kind === "button") return [4, { button: "home" }];
  if (event.kind === "rotate") return [7, { orientation: event.orientation.replaceAll("-", "_") }];
  if (event.kind === "key")
    return [
      6,
      {
        type: event.phase,
        usage: event.usage,
        ...(event.key === undefined ? {} : { key: event.key }),
        ...(event.shifted === undefined ? {} : { shifted: event.shifted }),
      },
    ];
  throw new Error("Invalid simulator input event.");
}

/** Private helper process. No helper address, token or general request API escapes. */
function createSimulatorHelper(options = {}) {
  const android = options.platform === "android";
  const validDevice = android ? EMULATOR : UUID;
  const prefix = android ? "/vendor/serve-emu" : PREFIX;
  const routeFor = (id, route) => (android ? `${prefix}/${route}?device=${encodeURIComponent(id)}` : `${prefix}/${encodeURIComponent(id)}/${route}`);
  const spawn = options.spawn ?? spawnProcess;
  const execFile = options.execFile ?? promisify(execFileCallback);
  const iceServers = options.iceServers ?? configuredIceServers(process.env);
  // A viewer that closes and reopens (phone backgrounded, Retry) reuses the warm helper instead of a cold start.
  const idleMs = options.idleMs ?? 60000;
  let current = null,
    starting = null,
    stopped = false,
    discovery = null,
    discoveryAt = 0,
    discoveryPromise = null;

  async function terminate(instance) {
    if (!instance || instance.terminated) return instance?.exitPromise;
    clearTimeout(instance.idle);
    instance.terminated = true;
    instance.abort.abort();
    for (const channel of instance.channels) channel.fail("Simulator helper stopped. Reopen the viewer.");
    const kill = (signal) => {
      if (!instance.child.pid || instance.exited) return;
      try {
        process.kill(-instance.child.pid, signal);
      } catch {
        try {
          instance.child.kill(signal);
        } catch {}
      }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 1000);
    timer.unref();
    await instance.exitPromise;
    clearTimeout(timer);
    if (current === instance) current = null;
  }
  async function ensure() {
    if (stopped) throw new Error("Simulator helper is closed.");
    if (current?.base && !current.exited && !current.terminated) {
      clearTimeout(current.idle);
      return current;
    }
    if (starting) return starting;
    starting = (async () => {
      let helperPath;
      try {
        helperPath = options.helperPath ?? resolveHelperPath();
      } catch {
        throw new Error("Simulator helper is unavailable. Reinstall Milagre on an Apple silicon Mac.");
      }
      const args = [
        helperPath,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--require-token",
        "--platform",
        android ? "android" : "ios",
        "--transport",
        "webrtc",
        "--video-fps",
        "30",
        "--max-dimension",
        "1280",
        "--video-bitrate",
        "2000000",
      ];
      // Pass TURN secrets in the environment, not the OS-visible command line.
      if (android) args.push("--stream-source", "scrcpy");
      const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
      if (android) {
        const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(require("node:os").homedir(), "Library/Android/sdk");
        childEnv.PATH = [path.join(sdk, "platform-tools"), path.join(sdk, "emulator"), process.env.PATH].join(path.delimiter);
        childEnv.MILAGRE_HELPER_ICE = JSON.stringify(iceServers);
        args.unshift(
          "-e",
          `const ice=JSON.parse(process.env.MILAGRE_HELPER_ICE);delete process.env.MILAGRE_HELPER_ICE;for(const s of ice){process.argv.push('--turn-url',Array.isArray(s.urls)?s.urls.join(','):s.urls,'--turn-username',s.username,'--turn-credential',s.credential)}import(require('node:url').pathToFileURL(process.argv[1]).href)`,
        );
      }
      let child;
      try {
        child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "ignore"], detached: true, env: childEnv });
      } catch {
        throw new Error("Simulator helper could not start. Reopen the viewer.");
      }
      const instance = { child, abort: new AbortController(), channels: new Set(), exited: false, terminated: false, base: null, token: null };
      current = instance;
      const emergencyKill = () => {
        if (!instance.exited && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
      };
      process.once("exit", emergencyKill);
      instance.exitPromise = new Promise((resolve) => {
        const finish = () => {
          instance.exited = true;
          process.removeListener("exit", emergencyKill);
          for (const channel of instance.channels) channel.fail("Simulator helper stopped. Reopen the viewer.");
          if (current === instance) current = null;
          resolve();
        };
        child.once("exit", finish);
        child.once("error", finish);
      });
      try {
        await new Promise((resolve, reject) => {
          let output = "";
          const finish = (error) => {
            clearTimeout(timer);
            child.stdout.removeListener("data", onData);
            child.removeListener("exit", onExit);
            child.removeListener("error", onExit);
            // Drain all later output without retaining helper URLs or credentials.
            child.stdout.resume();
            // oxlint-disable-next-line eslint/no-unused-expressions, promise/no-multiple-resolved -- flagged for review, see PR body
            error ? reject(error) : resolve();
          };
          const onExit = () => finish(new Error("Simulator helper could not start. Check Xcode, then reopen the viewer."));
          const onData = (chunk) => {
            output = (output + chunk.toString("utf8")).slice(-32768);
            const match = /http:\/\/(?:localhost|127\.0\.0\.1):(\d{1,5})\/\?token=([A-Za-z0-9_-]+)[\r\n\s]/.exec(output);
            if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) return;
            instance.base = `http://127.0.0.1:${match[1]}`;
            instance.token = match[2];
            output = "";
            finish();
          };
          const timer = setTimeout(() => finish(new Error("Simulator helper startup timed out. Reopen the viewer.")), options.startupTimeoutMs ?? 15000);
          child.stdout.on("data", onData);
          child.once("exit", onExit);
          child.once("error", onExit);
        });
        if (stopped || instance.exited) throw new Error("Simulator helper stopped. Reopen the viewer.");
        return instance;
      } catch (error) {
        await terminate(instance);
        throw error;
      }
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }
  // Once Xcode 27's Device Hub attaches to a simulator it sets this flag and the guest drops legacy HID touches.
  // Clearing it means restarting backboardd, which also restarts SpringBoard and closes running apps, so viewers
  // only report the flag and the user chooses when to repair.
  const INPUT_FLAG = "com.apple.coredevice.dtuhidd.active";
  const spawnIn = (deviceId, ...args) => execFile("/usr/bin/xcrun", ["simctl", "spawn", deviceId, ...args], { timeout: 10000, encoding: "utf8" });
  async function inputBlocked(deviceId) {
    try {
      return (await spawnIn(deviceId, "notifyutil", "-g", INPUT_FLAG)).stdout.trim() === `${INPUT_FLAG} 1`;
    } catch {
      return false; // Older runtimes do not publish the flag; input then works as before.
    }
  }
  async function request(instance, deviceId, route, body) {
    if (!validDevice.test(deviceId)) throw new Error("Invalid simulator device.");
    if (instance.exited || instance.terminated) throw new Error("Simulator helper stopped. Reopen the viewer.");
    try {
      const response = await fetch(`${instance.base}${routeFor(deviceId, route)}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${instance.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([instance.abort.signal, AbortSignal.timeout(route === "webrtc/close" ? 2000 : 20000)]),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("helper response");
      }
      if (route === "webrtc/close" && response.status === 204) return null;
      const reader = response.body.getReader();
      const chunks = [];
      let length = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 524288) {
          await reader.cancel();
          throw new Error("oversized response");
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("Simulator connection failed. Reopen the viewer to retry.");
    }
  }
  return {
    iceServers,
    async list() {
      if (discovery && Date.now() - discoveryAt < 2000) return structuredClone(discovery);
      if (discoveryPromise) return structuredClone(await discoveryPromise);
      discoveryPromise = (async () => {
        const { stdout } = await execFile("/usr/bin/xcrun", ["simctl", "list", "devices", "booted", "--json"], {
          timeout: 5000,
          maxBuffer: 2097152,
          encoding: "utf8",
        });
        const parsed = JSON.parse(stdout),
          result = [];
        for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
          const version = /\.iOS-([\d-]+)$/.exec(runtime)?.[1]?.replaceAll("-", ".");
          if (!version || !Array.isArray(devices)) continue;
          for (const device of devices)
            if (device.state === "Booted" && device.isAvailable !== false && UUID.test(device.udid))
              result.push({
                id: device.udid,
                name: String(device.name ?? "iOS Simulator").slice(0, 200),
                platform: "ios",
                version,
                ...(typeof device.deviceTypeIdentifier === "string" ? { deviceType: device.deviceTypeIdentifier.slice(0, 200) } : {}),
              });
        }
        discovery = result;
        discoveryAt = Date.now();
        return result;
      })();
      try {
        return structuredClone(await discoveryPromise);
      } finally {
        discoveryPromise = null;
      }
    },
    async connect(deviceId) {
      if (!validDevice.test(deviceId)) throw new Error("Invalid simulator device.");
      const instance = await ensure();
      const socket = new WebSocket(`${instance.base.replace("http:", "ws:")}${prefix}/ws?device=${encodeURIComponent(deviceId)}${android ? "&video=0" : ""}`, [
        `${android ? "serve-emu" : "serve-sim"}.token.${instance.token}`,
      ]);
      socket.binaryType = "arraybuffer";
      let state = { width: 0, height: 0, orientation: "portrait", ready: false },
        admitted = false,
        admissionResolved = false,
        localClosed = false;
      let pollTimer = null,
        polling = false,
        blocked = false,
        inputTimer = null;
      let rejectAdmission, resolveAdmission;
      const admission = new Promise((resolve, reject) => {
        resolveAdmission = resolve;
        rejectAdmission = reject;
      });
      const fail = (message) => {
        state = { ...state, ready: false, error: state.error ?? message };
        rejectAdmission(new Error(message));
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      };
      const send = (tag, payload) => {
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 16384) throw new Error("Simulator input socket is unavailable.");
        socket.send(android ? JSON.stringify(tag) : Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]));
      };
      const channel = {
        fail,
        status() {
          return blocked ? { ...state, inputBlocked: true } : { ...state };
        },
        send(event) {
          if (!state.ready) throw new Error("Simulator input is not ready.");
          if (!android) {
            send(...packet(event));
            return;
          }
          if (event.kind === "touch")
            event.points.forEach((point, pointerId) =>
              send({ type: "touch", action: { begin: "down", move: "move", end: "up" }[event.phase], pointerId, x: point.x, y: point.y }),
            );
          else if (event.kind === "button") send({ type: event.button });
          else if (event.kind === "rotate") {
            state = { ...state, ready: false };
            void request(instance, deviceId, "api/orientation", { orientation: event.orientation.startsWith("landscape") ? "landscape" : "portrait" }).catch(
              () => fail("Android rotation failed. Reopen the viewer."),
            );
          } else throw new Error("Use the emulator screen keyboard.");
        },
        async close() {
          if (localClosed) return;
          localClosed = true;
          clearInterval(pollTimer);
          clearInterval(inputTimer);
          state = { ...state, ready: false };
          instance.channels.delete(channel);
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000);
          if (instance.channels.size) return;
          if (idleMs <= 0) await terminate(instance);
          else {
            clearTimeout(instance.idle);
            instance.idle = setTimeout(() => {
              if (!instance.channels.size) void terminate(instance);
            }, idleMs);
            instance.idle.unref();
          }
        },
      };
      instance.channels.add(channel);
      socket.addEventListener("error", () => fail("Simulator input connection failed. Reopen the viewer."));
      socket.addEventListener("close", () => {
        if (!localClosed) fail("Simulator input disconnected. Reopen the viewer.");
      });
      if (android) {
        const refresh = async () => {
          if (polling || localClosed || state.error) return;
          polling = true;
          try {
            const health = await request(instance, deviceId, "health");
            if (localClosed || state.error) return;
            const { width, height } = health.size ?? {};
            if (
              health.status !== "streaming" ||
              !Number.isInteger(width) ||
              !Number.isInteger(height) ||
              width <= 0 ||
              height <= 0 ||
              width > 16384 ||
              height > 16384
            )
              throw new Error("Invalid Android stream dimensions");
            state = { width, height, orientation: width > height ? "landscape-left" : "portrait", ready: !health.captureRestarting };
            if (!admissionResolved) {
              admissionResolved = true;
              resolveAdmission();
            }
          } catch {
            if (!localClosed) fail("Android capture is unavailable. Check the emulator and retry.");
          } finally {
            polling = false;
          }
        };
        socket.addEventListener("open", () => {
          void refresh();
          pollTimer = setInterval(() => void refresh(), 500);
          pollTimer.unref();
        });
      }
      socket.addEventListener("message", ({ data }) => {
        if (android) {
          try {
            const reply = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString());
            if (reply.ok === false) fail("Android input failed. Reopen the viewer.");
          } catch {}
          return;
        }
        if (!(data instanceof ArrayBuffer)) return;
        const bytes = Buffer.from(data);
        if (bytes.length > 65536) {
          fail("Simulator input configuration is invalid.");
          return;
        }
        if (bytes.length === 1 && bytes[0] === 0x83) admitted = true;
        if (bytes[0] === 0x82) {
          try {
            const config = JSON.parse(bytes.subarray(1).toString("utf8"));
            if (config.inputUnavailable === true) {
              fail("Simulator input is unavailable. Reopen the viewer after other tools disconnect.");
              return;
            }
            const orientation = config.orientation?.replaceAll("_", "-") ?? "portrait";
            if (
              !Number.isInteger(config.width) ||
              !Number.isInteger(config.height) ||
              config.width <= 0 ||
              config.height <= 0 ||
              config.width > 16384 ||
              config.height > 16384 ||
              !ORIENTATIONS.has(orientation)
            )
              return;
            admitted = true;
            state = { width: config.width, height: config.height, orientation, ready: true };
          } catch {
            return;
          }
        }
        if (admitted && !state.error && !admissionResolved) {
          admissionResolved = true;
          // Admission can precede capture/config. Let open finish so offer can
          // start capture; input stays disabled until dimensions arrive.
          send(0x0e, { enabled: false });
          resolveAdmission();
        }
      });
      const timer = setTimeout(() => fail("Simulator input admission timed out. Reopen the viewer."), options.admissionTimeoutMs ?? 12000);
      try {
        await admission;
        if (!android) {
          // Device Hub can attach while a viewer is open, so the flag is read again while the channel lives.
          const checkInput = async () => {
            const value = await inputBlocked(deviceId);
            if (!localClosed) blocked = value;
          };
          await checkInput();
          inputTimer = setInterval(() => void checkInput(), options.inputCheckMs ?? 10000);
          inputTimer.unref();
        }
        return channel;
      } catch (error) {
        await channel.close();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    async offer(deviceId, sessionId, sdp) {
      const instance = current;
      if (!instance?.base) throw new Error("Simulator helper is unavailable. Reopen the viewer.");
      return request(instance, deviceId, "webrtc/offer", { type: "offer", sdp, sessionId, codec: "h264", ...(!android ? { iceServers } : {}) });
    },
    async repairInput(deviceId) {
      if (android || !UUID.test(deviceId)) throw new Error("Input repair is available only on iOS simulators.");
      try {
        await spawnIn(deviceId, "notifyutil", "-s", INPUT_FLAG, "0");
        await spawnIn(deviceId, "launchctl", "kickstart", "-k", "system/com.apple.backboardd");
      } catch {
        throw new Error("Could not restart simulator input. Check that the simulator is running.");
      }
    },
    async closeViewer(deviceId, sessionId) {
      const instance = current;
      if (instance?.base && !instance.exited && !instance.terminated) await request(instance, deviceId, "webrtc/close", { sessionId });
    },
    async stop() {
      stopped = true;
      await terminate(current);
    },
  };
}
/** Discovery stays capture-free. Backend instances isolate iOS and Android failures. */
function createSimulatorAdapter(options = {}) {
  const ios = createSimulatorHelper(options);
  const androidHelpers = new Map();
  const execFile = options.execFile ?? promisify(execFileCallback);
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(require("node:os").homedir(), "Library/Android/sdk");
  const adb = options.adbPath ?? (require("node:fs").existsSync(path.join(sdk, "platform-tools/adb")) ? path.join(sdk, "platform-tools/adb") : "adb");
  let cached = null,
    cachedAt = 0,
    discovering = null;
  const backend = (id) => {
    if (UUID.test(id)) return ios;
    if (!EMULATOR.test(id)) throw new Error("Invalid simulator device.");
    if (!androidHelpers.has(id)) androidHelpers.set(id, createSimulatorHelper({ ...options, platform: "android" }));
    return androidHelpers.get(id);
  };
  async function androidDevices() {
    const run = (args) => execFile(adb, args, { timeout: 5000, maxBuffer: 2097152, encoding: "utf8" });
    const { stdout } = await run(["devices"]);
    const ids = stdout
      .split(/\r?\n/)
      .map((line) => /^((?:emulator-)[0-9]{4,5})\s+device(?:\s|$)/.exec(line)?.[1])
      .filter(Boolean)
      .slice(0, 32);
    const devices = [];
    // Bound subprocess concurrency even if many emulators are running.
    for (const id of ids) {
      try {
        const [name, version] = await Promise.all([run(["-s", id, "emu", "avd", "name"]), run(["-s", id, "shell", "getprop", "ro.build.version.release"])]);
        devices.push({ id, name: name.stdout.split(/\r?\n/)[0].trim().slice(0, 200) || id, platform: "android", version: version.stdout.trim().slice(0, 40) });
      } catch {} // A device that disconnects during discovery is omitted.
    }
    return devices;
  }
  return {
    iceServers: ios.iceServers,
    async list() {
      if (cached && Date.now() - cachedAt < 2000) return structuredClone(cached);
      if (!discovering)
        discovering = (async () => {
          const results = await Promise.allSettled([ios.list(), androidDevices()]);
          if (results.every((r) => r.status === "rejected")) throw new Error("Device discovery failed. Check Xcode or Android SDK installation.");
          cached = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
          cachedAt = Date.now();
          return cached;
        })();
      try {
        return structuredClone(await discovering);
      } finally {
        discovering = null;
      }
    },
    async connect(id) {
      return backend(id).connect(id);
    },
    async offer(id, ...args) {
      return backend(id).offer(id, ...args);
    },
    async closeViewer(id, ...args) {
      return backend(id).closeViewer(id, ...args);
    },
    async repairInput(id) {
      return backend(id).repairInput(id);
    },
    async stop() {
      await Promise.all([ios.stop(), ...[...androidHelpers.values()].map((helper) => helper.stop())]);
      androidHelpers.clear();
    },
  };
}
module.exports = { createSimulatorHelper, createSimulatorAdapter, resolveHelperPath };
