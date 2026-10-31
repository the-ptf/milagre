const { spawn: spawnProcess, execFile: execFileCallback } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const { createMjpegFrames, createSnapshotFrames, normalizeAndroidSnapshot } = require("./simulator-frames.cjs");

const PREFIX = "/vendor/serve-sim/helper";
const UUID = /^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/;
const EMULATOR = /^emulator-[0-9]{4,5}$/;
const ORIENTATIONS = new Set(["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]);
const POSES = new Set(["closed", "open", "book", "laptop", "tent"]);
// Duo's native panel IDs match Device Hub/T3: cover 1, inner 3.
// Partially folded poses can retain either active panel. Always follow native selection for those.
const DUO_SCREENS = { closed: 1, open: 3, tent: 1 };
const sameHingeAngle = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.01;

function resolveHelperPath(packagePath = require.resolve("expo-device-hub/package.json")) {
  // Execute the whole package outside ASAR: native libraries resolve siblings.
  return path.join(path.dirname(packagePath.replace(/\.asar([/\\])/, ".asar.unpacked$1")), "dist", "server", "cli.mjs");
}
function configuredIceServers(env) {
  const urls = (env.MILAGRE_SIMULATOR_TURN_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (!urls.length) return [{ urls: "stun:stun.cloudflare.com:3478" }];
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
        android ? "webrtc" : "mjpeg",
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
          `const ice=JSON.parse(process.env.MILAGRE_HELPER_ICE);delete process.env.MILAGRE_HELPER_ICE;for(const s of ice){const urls=Array.isArray(s.urls)?s.urls:[s.urls];const stun=urls.filter(u=>/^stuns?:/i.test(u)),turn=urls.filter(u=>/^turns?:/i.test(u));if(stun.length)process.argv.push('--stun-url',stun.join(','));if(turn.length)process.argv.push('--turn-url',turn.join(','),'--turn-username',s.username,'--turn-credential',s.credential)}import(require('node:url').pathToFileURL(process.argv[1]).href)`,
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
  // Device Hub's input-mode flag is a diagnostic hint, not an acknowledgement that legacy touches were dropped.
  // Resetting it restarts backboardd and closes apps, so the viewer offers a manual, confirmed reset only.
  const INPUT_FLAG = "com.apple.coredevice.dtuhidd.active";
  const spawnIn = (deviceId, ...args) => execFile("/usr/bin/xcrun", ["simctl", "spawn", deviceId, ...args], { timeout: 10000, encoding: "utf8" });
  async function deviceHubInputActive(deviceId) {
    try {
      return (await spawnIn(deviceId, "notifyutil", "-g", INPUT_FLAG)).stdout.trim() === `${INPUT_FLAG} 1`;
    } catch {
      return false; // Missing or unreadable flags give no diagnostic hint.
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
        hubInputActive = false,
        inputTimer = null,
        media = null,
        snapshotSize = null,
        nativeConfig = null,
        displayChange = null;
      const clearDisplayChange = () => {
        clearTimeout(displayChange?.timer);
        displayChange = null;
      };
      const checkDisplayChange = () => {
        const change = displayChange;
        if (!change?.acknowledged || !nativeConfig) return;
        const observed = nativeConfig.observedDeviceState;
        if (
          !sameHingeAngle(state.hingeAngle, change.angle) ||
          (change.pose && state.hingePose !== change.pose) ||
          (observed &&
            (!sameHingeAngle(observed.hingeAngle, change.angle) ||
              (change.physical && observed.physicalOrientation?.replaceAll("_", "-") !== change.physical))) ||
          (change.screenId !== undefined && nativeConfig.screenId !== change.screenId)
        ) {
          change.confirmed = false;
          change.observedAt = change.geometry = null;
          return;
        }
        change.confirmed = true;
        change.observedAt ??= Date.now();
        const geometry = `${nativeConfig.screenId}:${state.width}:${state.height}:${state.orientation}`;
        if (change.geometry !== geometry) {
          change.geometry = geometry;
          change.geometryAt = Date.now();
          // Discard cached pixels only after native observation and panel geometry agree.
          change.after = media?.discard() ?? 0;
        }
      };
      let rejectAdmission, resolveAdmission;
      let hingeRequestId = 0;
      const hingeRequests = new Map();
      const rejectHingeRequests = (message) => {
        for (const settle of Array.from(hingeRequests.values())) settle(new Error(message));
      };
      const admission = new Promise((resolve, reject) => {
        resolveAdmission = resolve;
        rejectAdmission = reject;
      });
      const fail = (message) => {
        state = { ...state, ready: false, error: state.error ?? message };
        clearDisplayChange();
        media?.close();
        rejectHingeRequests(message);
        rejectAdmission(new Error(message));
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
      };
      const send = (tag, payload) => {
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 16384) throw new Error("Simulator input socket is unavailable.");
        socket.send(android ? JSON.stringify(tag) : Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))]));
      };
      const channel = {
        fail,
        async frame(after, signal) {
          if (!media) {
            if (android) {
              const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(require("node:os").homedir(), "Library/Android/sdk");
              const adb =
                options.adbPath ?? (require("node:fs").existsSync(path.join(sdk, "platform-tools/adb")) ? path.join(sdk, "platform-tools/adb") : "adb");
              media = createSnapshotFrames(async (captureSignal) => {
                const { stdout } = await execFile(adb, ["-s", deviceId, "exec-out", "screencap", "-p"], {
                  encoding: null,
                  timeout: 5000,
                  maxBuffer: 32 * 1024 * 1024,
                  signal: captureSignal,
                });
                if (!Buffer.isBuffer(stdout) || stdout.length < 24 || !stdout.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
                  throw new Error("Invalid Android screenshot.");
                const width = stdout.readUInt32BE(16),
                  height = stdout.readUInt32BE(20);
                if (!width || !height || width > 16384 || height > 16384 || width * height > 16 * 1024 * 1024)
                  throw new Error("Invalid Android screenshot dimensions.");
                snapshotSize = { width, height };
                state = { ...state, width, height, orientation: width > height ? "landscape-left" : "portrait" };
                return normalizeAndroidSnapshot(stdout, { execFile, signal: captureSignal });
              });
            } else {
              media = createMjpegFrames((captureSignal) =>
                fetch(`${instance.base}${routeFor(deviceId, "stream.mjpeg")}`, {
                  headers: { authorization: `Bearer ${instance.token}` },
                  signal: AbortSignal.any([instance.abort.signal, captureSignal]),
                  redirect: "error",
                }),
              );
            }
          }
          try {
            const frame = await media.read(after, signal);
            if (
              frame &&
              displayChange?.confirmed &&
              frame.sequence > displayChange.after &&
              Date.now() - displayChange.observedAt >= displayChange.settleMs &&
              Date.now() - displayChange.geometryAt >= (options.displayQuietMs ?? 350)
            )
              clearDisplayChange();
            return frame;
          } catch (error) {
            fail("Simulator frame stream failed. Reopen the viewer to reconnect.");
            throw error;
          }
        },
        status() {
          return { ...state, ready: state.ready && !displayChange, ...(hubInputActive ? { deviceHubInputActive: true } : {}) };
        },
        send(event) {
          if (!state.ready || displayChange) throw new Error("Simulator input is not ready.");
          if (event.kind === "pose" || event.kind === "hinge") {
            if (android || !state.supportsHingeAngle) throw new Error("This simulator does not support hinge controls.");
            if (event.kind === "pose" ? !POSES.has(event.pose) : !Number.isFinite(event.angle) || event.angle < 0 || event.angle > 180)
              throw new Error("Invalid simulator hinge command.");
            if (hingeRequests.size) throw new Error("A simulator pose change is already pending.");
            const physical = event.kind === "pose" ? (event.pose === "tent" ? "facedown" : event.pose === "laptop" ? "landscape-left" : "portrait") : null;
            const angle = event.kind === "hinge" ? event.angle : { closed: 0, open: 180, book: 90, laptop: 90, tent: 80 }[event.pose];
            const oldPhysical = nativeConfig?.physicalOrientation?.replaceAll("_", "-");
            // Partial folds can retain the cover even after leaving Tent. Native selection is
            // authoritative; only fully closed/open and Tent promise a particular panel.
            const screenId = event.kind === "pose" ? DUO_SCREENS[event.pose] : angle === 0 ? 1 : angle === 180 ? 3 : undefined;
            const unchanged =
              sameHingeAngle(state.hingeAngle, angle) &&
              (screenId === undefined || screenId === nativeConfig?.screenId) &&
              (!physical || (physical === oldPhysical && state.hingePose === event.pose));
            displayChange = {
              angle,
              pose: event.kind === "pose" ? event.pose : null,
              physical,
              screenId,
              // Rotation may follow panel activation, and its final orientation is not fixed by
              // the physical pose. Require stable native geometry and a fresh frame after settling.
              settleMs: unchanged ? 0 : (options.displaySettleMs ?? 1500),
              timer: setTimeout(() => fail("Simulator display did not settle. Reopen the viewer to retry."), options.displayTimeoutMs ?? 7000),
            };
            media?.discard();
            return new Promise((resolve, reject) => {
              const requestId = ++hingeRequestId;
              const settle = (error) => {
                clearTimeout(timeout);
                hingeRequests.delete(requestId);
                if (error) {
                  clearDisplayChange();
                  if (!localClosed && !state.error) fail("Simulator pose change failed. Reopen the viewer to reconnect.");
                  reject(error);
                } else {
                  if (displayChange) displayChange.acknowledged = true;
                  checkDisplayChange();
                  resolve();
                }
              };
              const timeout = setTimeout(() => settle(new Error("Simulator pose change timed out.")), options.hingeTimeoutMs ?? 5000);
              hingeRequests.set(requestId, settle);
              try {
                send(16, { requestId, command: event.kind === "pose" ? { control: "pose", value: event.pose } : { control: "angle", value: event.angle } });
              } catch (error) {
                settle(error);
              }
            });
          }
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
          clearDisplayChange();
          rejectHingeRequests("Simulator viewer closed.");
          media?.close();
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
            // Snapshots can be larger than the helper's capped H.264 stream. Input geometry must not oscillate between them.
            const { width, height } = snapshotSize ?? health.size ?? {};
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
        if (localClosed || state.error) return;
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
        if (bytes[0] === 0x90) {
          try {
            const reply = JSON.parse(bytes.subarray(1).toString("utf8"));
            hingeRequests.get(reply.requestId)?.(reply.ok === true ? null : new Error("Simulator could not change the device pose."));
          } catch {}
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
            const previousGeometry = `${nativeConfig?.screenId}:${state.width}:${state.height}:${state.orientation}`;
            state = {
              width: config.width,
              height: config.height,
              orientation,
              ready: true,
              ...(config.supportsHingeAngle === true
                ? {
                    supportsHingeAngle: true,
                    ...(Number.isFinite(config.hingeAngle) && config.hingeAngle >= 0 && config.hingeAngle <= 180 ? { hingeAngle: config.hingeAngle } : {}),
                    ...(POSES.has(config.hingePose) ? { hingePose: config.hingePose } : {}),
                  }
                : {}),
            };
            if (previousGeometry !== `${config.screenId}:${state.width}:${state.height}:${state.orientation}`) media?.discard();
            nativeConfig = config;
            checkDisplayChange();
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
            const value = await deviceHubInputActive(deviceId);
            if (!localClosed) hubInputActive = value;
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
module.exports = { createSimulatorHelper, createSimulatorAdapter, resolveHelperPath, packet };
