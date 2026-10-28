const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { WebSocket, WebSocketServer } = require("ws");
const { boxKeyPair, phoneHello, phoneFinish } = require("@milagre/shared/relay-crypto");
const { splitBody, createAssembler } = require("@milagre/shared/relay-rpc");
const { createFrameReader, createFrameWriter } = require("@milagre/shared/peer-frames");

const random = (n) => new Uint8Array(randomBytes(n));
const TOKEN = "a".repeat(64);
const LIVE_ORIGIN = "milagre-app://phone";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

async function until(check, label = "condition", ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(10);
  }
}

/** What the Mac's loopback bridge looks like to the relay host. */
async function startFakeBridge(t) {
  const seen = { requests: [], liveHeaders: [], liveOpen: 0, uploads: [] };
  const held = [];
  const authorized = (request) => request.headers.authorization === `Bearer ${TOKEN}`;
  const server = http.createServer((request, response) => {
    seen.requests.push({
      method: request.method,
      url: request.url,
      origin: request.headers.origin,
      host: request.headers.host,
      authorization: request.headers.authorization,
    });
    if (!authorized(request)) {
      response.writeHead(401).end();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/rpc") {
        seen.lastBody = Buffer.concat(chunks).toString();
        response.writeHead(200, { "content-type": "application/json", etag: '"abc"', "x-secret": "no", "set-cookie": "a=b" });
        response.end(JSON.stringify({ v: 1, result: "pong" }));
      } else if (request.url === "/attachments") {
        const body = Buffer.concat(chunks);
        seen.uploads.push({ body, type: request.headers["content-type"] });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ v: 1, result: { size: body.length } }));
      } else if (request.url === "/media") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.alloc(600_000, 7));
      } else if (request.url === "/slow") {
        held.push(() => {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("late");
        });
      } else response.writeHead(404).end();
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  const lives = [];
  server.on("upgrade", (request, socket, head) => {
    seen.liveHeaders.push({ authorization: request.headers.authorization, origin: request.headers.origin, url: request.url });
    if (!authorized(request) || request.headers.origin !== LIVE_ORIGIN) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      seen.liveOpen += 1;
      lives.push(ws);
      ws.send(JSON.stringify({ v: 1, hello: seen.liveOpen }));
      ws.on("message", (data) => ws.send(`echo:${data}`));
    });
  });
  const port = await listen(server);
  t.after(() => {
    for (const client of wss.clients) client.terminate();
    server.closeAllConnections();
    server.close();
  });
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    lives,
    waiting: () => held.length,
    release: () => {
      while (held.length) held.shift()();
    },
  };
}

/** A phone speaking the encrypted protocol over a raw relay socket. */
function connectPhone({ relayUrl, identity, token = TOKEN, key = boxKeyPair(random), name, kind, caps }) {
  const ws = new WebSocket(`${relayUrl}/v1/phone?id=${identity.hostId}`);
  const inbox = [];
  const waiters = [];
  const closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.on("message", (data) => {
    phone.rawFrames += 1;
    const bytes = new Uint8Array(data);
    const waiter = waiters.shift();
    if (waiter) waiter(bytes);
    else inbox.push(bytes);
  });
  const nextRaw = (ms = 5000) =>
    new Promise((resolve, reject) => {
      if (inbox.length) return resolve(inbox.shift());
      const timer = setTimeout(() => reject(new Error("Timed out waiting for a frame")), ms);
      waiters.push((bytes) => {
        clearTimeout(timer);
        resolve(bytes);
      });
    });
  const phone = {
    ws,
    key,
    closed,
    nextRaw,
    /** Frames the socket received, batches counted once. */
    rawFrames: 0,
    /** Messages of a batch still to hand out. */
    items: [],
    channel: null,
    opened: new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    }),
    /** Resolves with the channel, or with { error } when the Mac refused the hello. */
    async hello() {
      await phone.opened;
      const { message, ephemeral } = phoneHello({ phone: key, host: identity.box.publicKey, token, random, name, kind, caps });
      ws.send(message);
      const reply = await nextRaw();
      if (reply[0] === 0x04) return { error: JSON.parse(new TextDecoder().decode(reply.subarray(1))) };
      phone.channel = phoneFinish({ ephemeral, phone: key, host: identity.box.publicKey, reply });
      return { channel: phone.channel };
    },
    send(message) {
      ws.send(phone.channel.seal(message));
    },
    /** The next message; a batch (a Mac sends them to a phone whose hello asked) is handed out one message at a time. */
    async next(ms) {
      if (phone.items.length) return phone.items.shift();
      const message = phone.channel.open(await nextRaw(ms));
      if (message.t !== "batch") return message;
      phone.items.push(...message.items);
      return phone.items.shift();
    },
    /** Sends a request as `req` parts: the body goes out as base64 chunks, `''` and no more when there is none. */
    request(id, { method = "GET", path, headers = {}, body }, size) {
      const chunks = body ? splitBody(typeof body === "string" ? new TextEncoder().encode(body) : body, size) : [""];
      chunks.forEach((chunk, index) => phone.send({ t: "req", id, method, path, headers, chunk, more: index < chunks.length - 1 }));
    },
    /** Reads messages until a complete response for `id` arrives. */
    async response(id, ms) {
      const assembler = createAssembler();
      for (;;) {
        const message = await phone.next(ms);
        if (message.t !== "res" || message.id !== id) continue;
        const result = assembler.add(message);
        if (result.done) return { ...result, parts: undefined };
      }
    },
    close() {
      ws.terminate();
    },
  };
  return phone;
}

/**
 * Plays the Cloudflare Worker: real sockets, the real room logic, and `POST /hook/<secret>` through the real hook logic
 * (apps/relay/src/hooks.mjs) on in-memory storage. `hooks.directory` is the hook directory every room shares.
 */
async function startLocalRelay(t, { autoPong = true, hostBehavior } = {}) {
  const { createRoom } = await import("../../relay/src/room.mjs");
  const { createHookRoom, memoryHookStorage, memoryHookDirectory, handleHookRequest, hookResponse, unpackHookRequest } =
    await import("../../relay/src/hooks.mjs");
  const rooms = new Map();
  const hookRooms = new Map();
  const directory = memoryHookDirectory();
  const hookRoomFor = (id) => {
    if (!hookRooms.has(id)) {
      const storage = memoryHookStorage();
      hookRooms.set(id, { storage, hooks: createHookRoom({ storage, directory, roomId: id, send: (bytes) => roomFor(id).sendHost(bytes) }) });
    }
    return hookRooms.get(id);
  };
  const roomFor = (id) => {
    if (!rooms.has(id))
      rooms.set(
        id,
        createRoom({
          id,
          onHostReady: () => hookRoomFor(id).hooks.onHostReady(),
          onHostFrame: (type, payload) => hookRoomFor(id).hooks.onFrame(type, payload),
        }),
      );
    return rooms.get(id);
  };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", async () => {
      try {
        const url = new URL(request.url, "http://relay");
        if (!url.pathname.startsWith("/hook/")) {
          response.writeHead(404).end();
          return;
        }
        const headers = Object.entries(request.headers).flatMap(([name, value]) =>
          Array.isArray(value) ? value.map((item) => [name, item]) : [[name, value]],
        );
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : Buffer.concat(chunks);
        const answer = await handleHookRequest(new Request(`http://relay${request.url}`, { method: request.method, headers, body }), {
          lookupRoom: (hookId) => directory.owner(hookId),
          forwardToRoom: (roomId, hookId, packed) => hookResponse(hookRoomFor(roomId).hooks.receive(hookId, unpackHookRequest(packed))),
        });
        response.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
        response.end(Buffer.from(await answer.arrayBuffer()));
      } catch {
        response.writeHead(500).end();
      }
    });
  });
  const wss = new WebSocketServer({ noServer: true, autoPong });
  const hostSockets = [];
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, "http://relay");
    const id = url.searchParams.get("id");
    wss.handleUpgrade(request, socket, head, (ws) => {
      const room = roomFor(id);
      const payload = (data, isBinary) => (isBinary ? data : data.toString());
      if (url.pathname === "/v1/host") {
        const index = hostSockets.length;
        hostSockets.push(ws);
        if (hostBehavior?.(ws, index, id)) return;
        ws.on("message", (data, isBinary) => room.hostMessage(ws, payload(data, isBinary)));
        ws.on("close", () => room.hostClosed(ws));
        room.hostOpened(ws);
      } else {
        ws.on("message", (data, isBinary) => room.phoneMessage(ws, payload(data, isBinary)));
        ws.on("close", () => room.phoneClosed(ws));
        room.phoneOpened(ws);
      }
    });
  });
  const port = await listen(server);
  t.after(() => {
    for (const client of wss.clients) client.terminate();
    server.close();
  });
  /** POSTs to a hook URL the Mac handed out (its origin is the relay's) and answers { status, json }. */
  const postHook = async (hookUrl, body, headers = {}) => {
    const response = await fetch(hookUrl, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    return { status: response.status, json: await response.json().catch(() => null) };
  };
  return { url: `ws://127.0.0.1:${port}`, hostSockets, hooks: { directory, rooms: hookRooms }, postHook };
}

/**
 * A paired desktop over a raw relay or LAN socket: its hello says kind "desktop", then daemon frames travel as rpc,
 * evt and part messages (@milagre/shared/peer-frames). `messages` keeps every message the Mac sent, parts included;
 * `frames` every daemon frame they carried; `error` the first message it could not read.
 */
function connectDesktop({ relayUrl, identity, token = TOKEN, key = boxKeyPair(random), name = "studio", caps }) {
  const ws = new WebSocket(`${relayUrl}/v1/phone?id=${identity.hostId}`);
  const reader = createFrameReader("evt");
  const writer = createFrameWriter("rpc");
  const messages = [];
  const frames = [];
  const watchers = new Set();
  const early = []; // sealed messages that came in one chunk with the hello's reply
  let channel = null;
  let onReply = null;
  let nextId = 0;
  const closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  const opened = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  function take(bytes) {
    try {
      const message = channel.open(bytes);
      desktop.rawFrames += 1;
      // A batch (a Mac sends them to a desktop whose hello asked) holds a window's messages, in order.
      for (const item of message.t === "batch" ? message.items : [message]) {
        messages.push(item);
        if (item.t === "pong") continue;
        const read = reader.read(item);
        if (!read) continue;
        frames.push(read.frame);
        for (const watcher of Array.from(watchers)) watcher(read.frame);
      }
    } catch (error) {
      desktop.error ??= error;
      ws.terminate();
    }
  }
  ws.on("message", (data) => {
    const bytes = new Uint8Array(data);
    if (channel) take(bytes);
    else if (onReply) onReply(bytes);
    else early.push(bytes);
  });
  function waitFrame(match, ms = 15000) {
    const found = frames.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      let timer;
      const watch = (frame) => {
        if (!match(frame)) return;
        clearTimeout(timer);
        watchers.delete(watch);
        resolve(frame);
      };
      timer = setTimeout(() => {
        watchers.delete(watch);
        reject(new Error("Timed out waiting for a daemon frame"));
      }, ms);
      watchers.add(watch);
    });
  }
  const desktop = {
    ws,
    key,
    closed,
    messages,
    frames,
    /** Sealed frames the channel opened, batches counted once. */
    rawFrames: 0,
    error: null,
    notices: [],
    /** Resolves with the channel, or with { error } when the Mac refused the hello. Waits through pending notices (Allow). */
    async hello({ ms = 5000 } = {}) {
      await opened;
      const { message, ephemeral } = phoneHello({ phone: key, host: identity.box.publicKey, token, random, name, kind: "desktop", caps });
      const reply = await new Promise((resolve, reject) => {
        let timer;
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => reject(new Error("Timed out waiting for the hello's reply")), ms);
        };
        arm();
        onReply = (bytes) => {
          // A computer's first hello waits for Allow; the Mac says so, and again every few seconds.
          if (bytes[0] === 0x05) {
            desktop.notices.push(JSON.parse(new TextDecoder().decode(bytes.subarray(1))));
            arm();
            return;
          }
          clearTimeout(timer);
          onReply = null;
          resolve(bytes);
        };
        ws.send(message);
      });
      if (reply[0] === 0x04) return { error: JSON.parse(new TextDecoder().decode(reply.subarray(1))) };
      channel = phoneFinish({ ephemeral, phone: key, host: identity.box.publicKey, reply });
      for (const bytes of early.splice(0)) take(bytes);
      return { channel };
    },
    /** Sends one daemon frame as a desktop does: whole, or in parts past 768 KiB. */
    sendFrame(frame) {
      for (const text of writer.write(JSON.stringify(frame))) ws.send(channel.sealEncoded(text));
    },
    sendMessage(message) {
      ws.send(channel.seal(message));
    },
    /** Calls a daemon method and resolves with its reply frame ({ result } or { error }). */
    call(method, args = [], ms) {
      const id = ++nextId;
      desktop.sendFrame({ v: 1, id, method, args });
      return waitFrame((frame) => frame.id === id, ms);
    },
    /** The first event on `name` whose payload `match` accepts, already received or still to come. */
    event(name, match = () => true, ms) {
      return waitFrame((frame) => frame.event?.channel === name && match(frame.event.payload), ms);
    },
    close() {
      ws.terminate();
    },
  };
  return desktop;
}

/** Stands in for the daemon behind a desktop's channel: answers every request with its args, and records each connection. */
function fakePeerDaemon() {
  const connections = [];
  return {
    connections,
    openPeer(carrier) {
      const connection = { carrier, frames: [], closed: false };
      connections.push(connection);
      return {
        receive(frame) {
          connection.frames.push(frame);
          carrier.send({ v: 1, id: frame.id, result: { echo: frame.args } });
        },
        invalid(error) {
          carrier.send({ v: 1, id: null, error: { code: error.code, message: error.message } });
          carrier.end();
        },
        close() {
          connection.closed = true;
        },
      };
    },
  };
}
/**
 * A throwaway Mac: its own data folder, a local relay in place of relay.milagre.cloud, the LAN on a port the OS picks
 * on 127.0.0.1 (none with `lan: false`), and a clock the test moves (pairing windows). Never Victor's data folder, 8797
 * or 8798. `autoAllow`: this Mac's window allows every computer that asks, as its owner would.
 */
async function startTestMac(t, { autoAllow = true, lan = true, runtime: runtimeExtra = {}, relay: relayOptions = {} } = {}) {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { startDaemon } = require("./server.cjs");
  const { connect } = require("./client.cjs");
  const { readIdentity } = require("./relay-identity.cjs");
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "peer-e2e-")));
  const dataDir = path.join(directory, "profile");
  const project = path.join(directory, "project");
  await fs.mkdir(project);
  const clock = { now: 1_000_000 };
  const sockets = [];
  let daemon;
  let client;
  // Registered before the relay's own hook, so the daemon closes while the relay still answers; the folder goes last.
  t.after(async () => {
    for (const socket of sockets) socket.close();
    client?.close();
    try {
      await daemon?.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  const relay = await startLocalRelay(t, relayOptions);
  daemon = await startDaemon({
    dataDir,
    homeDir: directory,
    version: "9.8.7",
    runtimeOptions: { cwd: project, environmentReady: Promise.resolve(), titleModels: {}, readPullRequests: async (_worktree, refs) => refs, ...runtimeExtra },
    phoneOptions: {
      relayUrl: relay.url,
      localPort: 0,
      lanPort: lan ? 0 : null,
      lanHostname: "127.0.0.1",
      addresses: () => ["127.0.0.1"],
      now: () => clock.now,
    },
  });
  client = await connect({ dataDir });
  if (autoAllow)
    client.on("event", ({ channel, payload }) => {
      if (channel !== "devices:pending") return;
      for (const request of payload?.requests ?? []) void client.call("devices:allow", [request.key]).catch(() => {});
    });
  // Turning phone access on opens the pairing window, as showing the QR in Settings › Devices does.
  await client.call("phone:set-enabled", [true]);
  await until(async () => {
    const status = await client.call("phone:status");
    return status.state === "on" && status.relay === "online";
  }, "phone access on and the relay online");
  const identity = await readIdentity(dataDir);
  const token = JSON.parse(await fs.readFile(path.join(dataDir, "mobile.json"), "utf8")).token;
  /** Dials this Mac with `connectTo` (connectDesktop or connectPhone), through the relay unless `relayUrl` says otherwise. */
  const dial = (connectTo, options = {}) => {
    const socket = connectTo({ relayUrl: relay.url, identity, token, ...options });
    sockets.push(socket);
    return socket;
  };
  return { clock, client, project, identity, token, dial, relay, dataDir, home: directory };
}

module.exports = {
  random,
  TOKEN,
  LIVE_ORIGIN,
  sleep,
  listen,
  until,
  startFakeBridge,
  connectPhone,
  startLocalRelay,
  connectDesktop,
  fakePeerDaemon,
  startTestMac,
};
