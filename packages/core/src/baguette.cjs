const { spawn: spawnProcess, execFile: execFileCallback } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { createAvccRelay, TAG } = require("./simlock-channel.cjs");

const PREFIX = "baguette:";
const MIN_VERSION = "0.3.0";
const UDID = /^[A-Za-z0-9-]{8,64}$/;
const SEARCH = ["/opt/homebrew/bin", "/usr/local/bin"];
const EDGE = { bottom: 0.93, top: 0.07 };
const EDGE_MOVE = 0.02;
const CAPABILITIES = ["touch", "home"];
const reason = (error) => {
  const text = /"NSLocalizedDescription":\s*"([^"]{1,200})"/.exec(error)?.[1] ?? error.slice(0, 200);
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

const atLeast = (a, b) => {
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0);
  return true;
};

async function executable(file) {
  try {
    await fs.access(file, fs.constants.X_OK);
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Parses `baguette list`: one JSON object per line, simulators first, then phones on a cable. */
function cabledPhones(output) {
  const phones = [];
  for (const line of String(output).split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.reality !== "physical" || entry.state !== "ready" || !UDID.test(entry.udid ?? "")) continue;
    if (!/^(iPhone|iPad)/.test(entry.model ?? "")) continue;
    phones.push({ udid: entry.udid, name: String(entry.name || entry.model).slice(0, 200), model: String(entry.model).slice(0, 100) });
  }
  return phones;
}

/** One phone's screen and touches over `baguette serve`'s stream socket, as a simulator channel. */
function createBaguetteChannel(base, udid, { fetch: fetchImpl = globalThis.fetch, WebSocket = require("ws"), frameWaitMs = 20000, onClose = () => {} } = {}) {
  const abort = new AbortController();
  const relay = createAvccRelay();
  const state = { width: 0, height: 0, open: false, described: false, error: null };
  let socket = null,
    closed = false,
    touch = null,
    pending = null;

  const fail = (message) => {
    if (closed || state.error) return;
    state.error = message;
    relay.close();
  };
  void (async () => {
    try {
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]);
      const response = await fetchImpl(`${base}/devices/${encodeURIComponent(udid)}/definition.json`, { signal });
      const rect = response.ok ? (await response.json())?.screen?.rect : null;
      if (Number.isFinite(rect?.width) && rect.width > 0 && Number.isFinite(rect?.height) && rect.height > 0)
        Object.assign(state, { width: rect.width, height: rect.height });
    } catch {}
  })();

  try {
    socket = new WebSocket(`${base.replace(/^http/, "ws")}/devices/${encodeURIComponent(udid)}/stream?format=avcc`, {
      handshakeTimeout: 15000,
      maxPayload: 8 * 1024 * 1024,
    });
    socket.binaryType = "nodebuffer";
    socket.on("open", () => {
      state.open = true;
      for (const control of [
        { type: "set_scale", scale: 2 },
        { type: "set_fps", fps: 30 },
        { type: "set_bitrate", bps: 3_000_000 },
      ])
        socket.send(JSON.stringify(control));
    });
    socket.on("message", (data, isBinary) => {
      const bytes = Buffer.from(data);
      if (!isBinary) {
        try {
          const reply = JSON.parse(bytes.toString("utf8"));
          if (reply?.ok === false && typeof reply.error === "string")
            fail(`Baguette could not stream this iPhone: ${reason(reply.error)} Unlock it, keep it on its cable, and retry.`);
        } catch {}
        return;
      }
      const tag = bytes[0];
      if (tag !== TAG.description && tag !== TAG.keyframe && tag !== TAG.delta) return;
      if (tag === TAG.description) state.described = true;
      const head = Buffer.alloc(4);
      head.writeUInt32BE(bytes.length, 0);
      relay.push(tag, Buffer.concat([head, bytes]));
    });
    socket.on("unexpected-response", (_request, response) => {
      fail(`Baguette refused the stream (HTTP ${response.statusCode}).`);
      response.resume();
    });
    socket.on("error", () => fail("The connection to Baguette failed. Retry to reconnect."));
    socket.on("close", () => {
      if (!closed) fail("The iPhone's stream stopped. Check its cable and retry.");
    });
  } catch {
    fail("The connection to Baguette failed. Retry to reconnect.");
  }

  const size = () => ({ width: state.width || 390, height: state.height || 844 });
  const write = (message) => {
    if (!socket || socket.readyState !== 1 || socket.bufferedAmount > 65536) throw new Error("The iPhone's input is not connected.");
    socket.send(JSON.stringify(message));
  };
  const one = (phase, point, edge) => {
    const { width, height } = size();
    write({ type: `touch1-${phase}`, x: point.x * width, y: point.y * height, width, height, ...(edge ? { edge } : {}) });
  };
  const two = (phase, [a, b]) => {
    const { width, height } = size();
    write({ type: `touch2-${phase}`, x1: a.x * width, y1: a.y * height, x2: b.x * width, y2: b.y * height, width, height });
  };
  const edgeOf = (point) => (point.y >= EDGE.bottom ? "bottom" : point.y <= EDGE.top ? "top" : null);
  // A press in an edge band waits for its first real move: a drag in from the edge is a system gesture, a tap stays a tap.
  function sendTouch(event) {
    const [point] = event.points;
    if (event.points.length === 2) {
      two(event.phase === "begin" ? "down" : event.phase === "end" ? "up" : "move", event.points);
      return;
    }
    if (event.phase === "begin") {
      const edge = edgeOf(point);
      touch = { edge: null, start: point };
      if (edge) pending = { edge, start: point };
      else one("down", point);
      return;
    }
    if (pending) {
      if (event.phase === "end") {
        one("down", pending.start);
        one("up", point);
        pending = touch = null;
        return;
      }
      if (Math.hypot(point.x - pending.start.x, point.y - pending.start.y) < EDGE_MOVE) return;
      touch.edge = pending.edge;
      one("down", pending.start, touch.edge);
      pending = null;
    }
    one(event.phase === "end" ? "up" : "move", point, touch?.edge);
    if (event.phase === "end") touch = null;
  }
  async function home() {
    const steps = [0.99, 0.9, 0.78, 0.66, 0.55];
    one("down", { x: 0.5, y: steps[0] }, "bottom");
    for (const y of steps.slice(1)) {
      await new Promise((resolve) => setTimeout(resolve, 16));
      one("move", { x: 0.5, y }, "bottom");
    }
    one("up", { x: 0.5, y: steps.at(-1) }, "bottom");
  }

  return {
    async frame(after, signal) {
      const deadline = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(frameWaitMs)].filter(Boolean));
      for (;;) {
        if (state.error) throw new Error(state.error);
        const batch = relay.read(after);
        if (batch) return { sequence: batch.sequence, mimeType: "video/avcc", data: batch.data, ...(batch.reset ? { reset: true } : {}) };
        if (deadline.aborted) return null;
        await relay.wait(deadline);
      }
    },
    status() {
      const { width, height } = size();
      return {
        width,
        height,
        orientation: "portrait",
        ready: state.open && state.described && !state.error,
        capabilities: [...CAPABILITIES],
        ...(state.error ? { error: state.error } : {}),
      };
    },
    async send(event) {
      if (state.error) throw new Error(state.error);
      if (event.kind === "touch") return sendTouch(event);
      if (event.kind === "button" && event.button === "home") return home();
      throw new Error("An iPhone on a cable takes touches only. Turn it and type on it by hand.");
    },
    async close() {
      if (closed) return;
      closed = true;
      abort.abort();
      relay.close();
      try {
        socket?.close();
      } catch {}
      onClose();
    },
  };
}

/** Finds the optional `baguette` CLI and runs one `baguette serve` on loopback while an iPhone on a cable is viewed. */
function createBaguette(options = {}) {
  const execFile = options.execFile ?? promisify(execFileCallback);
  const spawn = options.spawn ?? spawnProcess;
  const env = options.env ?? process.env;
  const isExecutable = options.executable ?? executable;
  const pickPort = options.freePort ?? freePort;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const idleMs = options.idleMs ?? 30000;
  const now = options.now ?? Date.now;
  const channelOptions = { fetch: fetchImpl, WebSocket: options.WebSocket, frameWaitMs: options.frameWaitMs };
  const versions = new Map();
  let detected = null,
    detectedAt = -Infinity,
    detecting = null,
    listed = null,
    listedAt = -Infinity,
    listing = null,
    server = null,
    starting = null,
    stopped = false;

  async function locate() {
    const dirs = [...String(env.PATH ?? "").split(path.delimiter), ...SEARCH].filter((dir) => path.isAbsolute(dir));
    for (const dir of new Set(dirs)) {
      const file = path.join(dir, "baguette");
      if (await isExecutable(file)) return file;
    }
    return null;
  }
  async function detect() {
    if (now() - detectedAt < 30000 && detected) return detected;
    detecting ??= (async () => {
      const found = await locate();
      let result = { found: false, supported: false, minVersion: MIN_VERSION };
      if (found) {
        let version = "";
        try {
          version = /\d+\.\d+\.\d+/.exec((await execFile(found, ["--version"], { timeout: 5000, encoding: "utf8" })).stdout)?.[0] ?? "";
        } catch {}
        result = { found: true, path: found, ...(version ? { version } : {}), supported: !!version && atLeast(version, MIN_VERSION), minVersion: MIN_VERSION };
      }
      detected = result;
      detectedAt = now();
      return result;
    })().finally(() => {
      detecting = null;
    });
    return detecting;
  }
  async function list() {
    if (stopped) return [];
    if (now() - listedAt < 3000 && listed) return listed;
    listing ??= (async () => {
      const found = await detect();
      let phones = [];
      if (found.supported) {
        try {
          phones = cabledPhones((await execFile(found.path, ["list"], { timeout: 10000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })).stdout);
        } catch {}
      }
      listed = phones.map((phone) => ({
        id: PREFIX + phone.udid,
        name: phone.name,
        platform: "ios",
        version: versions.get(phone.udid) ?? "",
        deviceType: phone.model,
        capabilities: [...CAPABILITIES],
      }));
      listedAt = now();
      return listed;
    })().finally(() => {
      listing = null;
    });
    return listing;
  }

  async function terminate(instance) {
    if (!instance || instance.terminated) return instance?.exited;
    instance.terminated = true;
    clearTimeout(instance.idle);
    const kill = (signal) => {
      if (instance.done) return;
      try {
        if (instance.child.pid) process.kill(-instance.child.pid, signal);
        else instance.child.kill(signal);
      } catch {
        try {
          instance.child.kill(signal);
        } catch {}
      }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 1000);
    timer.unref();
    await instance.exited;
    clearTimeout(timer);
    if (server === instance) server = null;
  }
  async function readVersions(instance) {
    const response = await fetchImpl(`${instance.base}/devices.json`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error("not ready");
    const body = await response.json();
    for (const device of body?.devices ?? [])
      if (device?.kind?.reality === "physical" && typeof device.kind.os === "string" && UDID.test(device.id ?? ""))
        versions.set(device.id, device.kind.os.replace(/^iOS\s*/, "").slice(0, 20));
  }
  async function launch(binary) {
    const port = await pickPort();
    const child = spawn(binary, ["serve", "--host", "127.0.0.1", "--port", String(port), "--no-plugins"], { stdio: "ignore", detached: true, env });
    const instance = { child, base: `http://127.0.0.1:${port}`, channels: 0, idle: null, done: false, terminated: false };
    const emergencyKill = () => {
      if (!instance.done && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    };
    process.once("exit", emergencyKill);
    instance.exited = new Promise((resolve) => {
      const finish = () => {
        instance.done = true;
        process.removeListener("exit", emergencyKill);
        if (server === instance) server = null;
        resolve();
      };
      child.once("exit", finish);
      child.once("error", finish);
    });
    const deadline = now() + (options.startupTimeoutMs ?? 15000);
    while (!instance.done) {
      try {
        await readVersions(instance);
        return instance;
      } catch {}
      if (now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 200));
    }
    await terminate(instance);
    return null;
  }
  async function serve() {
    if (stopped) throw new Error("Baguette is stopped.");
    if (server && !server.done && !server.terminated) return server;
    starting ??= (async () => {
      const found = await detect();
      if (!found.supported)
        throw new Error(
          found.found
            ? `Update Baguette to ${MIN_VERSION} or later (brew upgrade baguette).`
            : "Install Baguette to view an iPhone on a cable (brew install baguette).",
        );
      for (let attempt = 0; attempt < 2; attempt++) {
        const instance = await launch(found.path);
        if (stopped) {
          await terminate(instance);
          throw new Error("Baguette is stopped.");
        }
        if (instance) return (server = instance);
      }
      throw new Error("Baguette could not start. Run `baguette serve` in a terminal to see why.");
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  return {
    detect: async () => ({ ...(await detect()), serving: !!server && !server.done }),
    list,
    isDevice: (id) => typeof id === "string" && id.startsWith(PREFIX),
    async connect(id) {
      const udid = id.slice(PREFIX.length);
      if (!UDID.test(udid)) throw new Error("Invalid iPhone id.");
      const instance = await serve();
      clearTimeout(instance.idle);
      instance.channels++;
      return createBaguetteChannel(instance.base, udid, {
        ...channelOptions,
        onClose: () => {
          instance.channels--;
          if (instance.channels > 0 || instance.terminated) return;
          instance.idle = setTimeout(() => void terminate(instance), idleMs);
          instance.idle.unref?.();
        },
      });
    },
    async stop() {
      stopped = true;
      await starting?.catch(() => {});
      await terminate(server);
    },
  };
}

/** Adds the host's iPhones on a cable to a simulator adapter. They stream through Milagre only. */
function withBaguette(local, host) {
  return {
    iceServers: local.iceServers,
    async list() {
      const [simulators, phones] = await Promise.allSettled([local.list(), host.list()]);
      const cabled = phones.status === "fulfilled" ? phones.value : [];
      if (simulators.status === "rejected") {
        if (cabled.length) return cabled;
        throw simulators.reason;
      }
      return [...simulators.value, ...cabled];
    },
    connect: (id) => (host.isDevice(id) ? host.connect(id) : local.connect(id)),
    async offer(id, ...args) {
      if (host.isDevice(id)) throw new Error("iPhones on a cable stream through Milagre only.");
      return local.offer(id, ...args);
    },
    async closeViewer(id, ...args) {
      if (!host.isDevice(id)) return local.closeViewer(id, ...args);
    },
    async repairInput(id) {
      if (host.isDevice(id)) throw new Error("Input repair is not available for an iPhone on a cable.");
      return local.repairInput(id);
    },
    async stop() {
      await Promise.all([local.stop(), host.stop()]);
    },
  };
}

module.exports = { createBaguette, createBaguetteChannel, withBaguette, cabledPhones, BAGUETTE_PREFIX: PREFIX, BAGUETTE_MIN_VERSION: MIN_VERSION };
