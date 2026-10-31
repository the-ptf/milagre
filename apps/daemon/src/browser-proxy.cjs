const net = require("node:net");

// A remote Chat's Browser pages draw on this Mac and reach the web from the Chat's computer (#832): each page's session
// uses one of these as its SOCKS5 proxy (desktop main sets it), and every connection a page makes is opened from that
// computer over its channel (peer-streams.cjs), so its localhost is the computer's and its LAN is the computer's.
// One proxy per computer, on loopback, made the first time a page needs it. Chromium's SOCKS5 has no authentication,
// so it takes only "no authentication"; the random port on loopback is what keeps it to this Mac.
const VERSION = 0x05;
const NO_AUTH = 0x00;
const NO_METHOD = 0xff;
const CONNECT = 0x01;
const IPV4 = 0x01;
const DOMAIN = 0x03;
const IPV6 = 0x04;
// RFC 1928 replies.
const REPLY = { ok: 0x00, failed: 0x01, network: 0x03, host: 0x04, refused: 0x05, ttl: 0x06, command: 0x07, address: 0x08 };
const HANDSHAKE_MS = 10_000;
const MAX_HEADER = 512;

/** The SOCKS reply for why the computer couldn't open a stream (peer-streams.cjs codes, or the computer being offline). */
function replyFor(error) {
  switch (error?.code) {
    case "refused":
      return REPLY.refused;
    case "not-found":
      return REPLY.host;
    case "unreachable":
    case "offline":
    case "lost":
      return REPLY.network;
    case "timeout":
      return REPLY.ttl;
    default:
      return REPLY.failed;
  }
}

/**
 * Reads a client's greeting and CONNECT request from `buffer`. Returns null while bytes are missing, { error } for a
 * request this proxy refuses, or { target, port, rest } with the bytes after the request.
 * @param {Buffer} buffer
 */
function parseRequest(buffer) {
  if (buffer.length < 2) return null;
  if (buffer[0] !== VERSION) return { error: "version" };
  const methods = buffer[1];
  const greeting = 2 + methods;
  if (buffer.length < greeting) return null;
  if (!buffer.subarray(2, greeting).includes(NO_AUTH)) return { error: "auth", greeting };
  const request = buffer.subarray(greeting);
  if (request.length < 4) return { greeting };
  if (request[0] !== VERSION) return { error: "version", greeting };
  if (request[1] !== CONNECT) return { error: "command", greeting };
  let target, at;
  if (request[3] === IPV4) {
    if (request.length < 10) return { greeting };
    target = Array.from(request.subarray(4, 8)).join(".");
    at = 8;
  } else if (request[3] === DOMAIN) {
    if (request.length < 5) return { greeting };
    const length = request[4];
    if (request.length < 5 + length + 2) return { greeting };
    target = request.subarray(5, 5 + length).toString("latin1");
    at = 5 + length;
  } else if (request[3] === IPV6) {
    if (request.length < 22) return { greeting };
    const words = [];
    for (let index = 4; index < 20; index += 2) words.push(request.readUInt16BE(index).toString(16));
    target = words.join(":");
    at = 20;
  } else return { error: "address", greeting };
  const port = request.readUInt16BE(at);
  return { greeting, target, port, rest: request.subarray(at + 2) };
}

/**
 * `openStream(computerId, target, port)` opens a stream from that computer (computers.cjs openStream).
 * @param {{ openStream: (computerId: string, target: string, port: number) => Promise<import("node:stream").Duplex>; log?: (line: string) => void }} options
 */
function createBrowserProxies({ openStream, log = () => {} }) {
  /** @type {Map<string, Promise<{ server: net.Server; port: number; sockets: Set<net.Socket> }>>} */
  const proxies = new Map();
  let closed = false;

  function serve(computerId, socket) {
    let buffer = Buffer.alloc(0);
    let greeted = false;
    let done = false;
    const timer = setTimeout(() => socket.destroy(), HANDSHAKE_MS);
    socket.on("error", () => {});
    const fail = (code) => {
      done = true;
      clearTimeout(timer);
      socket.end(Buffer.from([VERSION, code, 0x00, IPV4, 0, 0, 0, 0, 0, 0]));
    };
    const onData = (chunk) => {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_HEADER) return socket.destroy();
      const parsed = parseRequest(buffer);
      if (!parsed) return;
      if (!greeted && parsed.greeting !== undefined && parsed.error !== "version") {
        greeted = true;
        socket.write(Buffer.from([VERSION, parsed.error === "auth" ? NO_METHOD : NO_AUTH]));
      }
      if (parsed.error === "version" || parsed.error === "auth") {
        done = true;
        clearTimeout(timer);
        return socket.end();
      }
      if (parsed.error) return fail(parsed.error === "command" ? REPLY.command : REPLY.address);
      if (parsed.target === undefined) return;
      done = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.pause();
      const { target, port, rest } = parsed;
      openStream(computerId, target, port).then(
        (stream) => {
          if (socket.destroyed) return stream.destroy();
          socket.write(Buffer.from([VERSION, REPLY.ok, 0x00, IPV4, 0, 0, 0, 0, 0, 0]));
          if (rest.length) stream.write(rest);
          stream.on("error", () => socket.destroy());
          socket.on("close", () => stream.destroy());
          stream.on("close", () => socket.destroy());
          socket.pipe(stream).pipe(socket);
          socket.resume();
        },
        (error) => {
          log(`browser proxy: ${computerId} could not open ${target}:${port} (${error?.code ?? "failed"})`);
          if (!socket.destroyed) fail(replyFor(error));
        },
      );
    };
    socket.on("data", onData);
  }

  return {
    /** The loopback port of `computerId`'s proxy, started the first time it is asked for. */
    port(computerId) {
      if (closed) return Promise.reject(new Error("Milagre is quitting."));
      let proxy = proxies.get(computerId);
      if (!proxy) {
        proxy = new Promise((resolve, reject) => {
          const sockets = new Set();
          const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
            serve(computerId, socket);
          });
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => resolve({ server, port: /** @type {net.AddressInfo} */ (server.address()).port, sockets }));
        });
        proxies.set(computerId, proxy);
        proxy.catch(() => proxies.delete(computerId));
      }
      return proxy.then(({ port }) => port);
    },
    /** Stops a computer's proxy and its connections (the computer was removed). */
    async drop(computerId) {
      const proxy = proxies.get(computerId);
      proxies.delete(computerId);
      const running = await proxy?.catch(() => null);
      if (!running) return;
      for (const socket of running.sockets) socket.destroy();
      await new Promise((resolve) => running.server.close(() => resolve(undefined)));
    },
    async close() {
      closed = true;
      await Promise.all([...proxies.keys()].map((id) => this.drop(id)));
    },
  };
}

module.exports = { createBrowserProxies, parseRequest };
