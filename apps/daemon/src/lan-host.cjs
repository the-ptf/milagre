const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { WebSocketServer, WebSocket: NodeWebSocket } = require("ws");
const { createPhoneChannels, frame, OPEN, DATA, CLOSE } = require("./phone-channels.cjs");

const MAX_PHONES = 16;
// One device on the LAN gets a few sockets (a reconnect overlapping its dying predecessor), not the whole table.
const MAX_PER_ADDRESS = 4;
// A phone that reads slower than the Mac writes is dropped rather than buffered without end. A response is written
// all at once, base64 and sealed, so the cap holds the largest one (MAX_RESPONSE, 64 MiB, about 86 MiB on the wire)
// with room for a few small ones beside it. A phone that stops reading altogether is caught by the ping.
const MAX_BUFFERED = 96 * 1024 * 1024;
// A socket that answers neither a ping nor anything else for two intervals is half open: the phone left the network.
const PING_MS = 30_000;
// Larger than one sealed 256 KiB upload chunk, base64 and all.
const MAX_FRAME = 4 * 1024 * 1024;
const HELLO_MS = 15_000;
// The listener is on by default on every network, public Wi-Fi included, so it bounds what a stranger can hold open.
const MAX_CONNECTIONS = 64;
// A socket that has not finished its request line and headers, or sent anything at all, is not a phone.
const HEADERS_MS = 5_000;
const REQUEST_MS = 5_000;
const IDLE_MS = 10_000;
// The hello is a few hundred bytes; a bigger first message is not one.
const MAX_HELLO = 4 * 1024;
const notFound = "HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n";

/** A request target is attacker-controlled bytes: one that is not a URL is just a 404, never an exception. */
function parseTarget(url) {
  try {
    return new URL(url, "http://lan");
  } catch {
    return null;
  }
}

/**
 * Phone and paired-desktop access on the local network: the relay's phone protocol, end to end encrypted, over a socket the phone
 * dials directly. `/v1/hello` lets a phone check, without credentials, that this address is still this Mac.
 * A pinned pairing link can authorize a new device during the owner's pairing window, including over Tailscale.
 */
function startLanHost({
  port,
  hostname = "0.0.0.0",
  identity,
  phones,
  token,
  bridgeUrl,
  WebSocket = NodeWebSocket,
  fetch = globalThis.fetch,
  random = (n) => new Uint8Array(randomBytes(n)),
  helloMs = HELLO_MS,
  pingMs = PING_MS,
  idleMs = IDLE_MS,
  openPeer,
  canPair = () => false,
  allowComputer,
}) {
  const channels = createPhoneChannels({ identity, phones, token, bridgeUrl, canPair, WebSocket, fetch, random, helloMs, openPeer, allowComputer });
  const sockets = new Map(); // conn id -> the phone's socket
  const perAddress = new Map(); // remote address -> open sockets
  const alive = new WeakSet(); // sockets that answered since the last ping
  let nextConn = 1n;
  const session = {
    conns: new Map(),
    send(bytes) {
      const conn = new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(1);
      const ws = sockets.get(conn);
      if (!ws) return;
      if (bytes[0] === DATA) {
        if (ws.readyState !== NodeWebSocket.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED) ws.terminate();
        else ws.send(bytes.subarray(9));
      } else if (bytes[0] === CLOSE) {
        sockets.delete(conn);
        ws.close(1000);
      }
    },
    /** What this device's socket holds unsent: bounds a desktop that stopped reading (peer-channel.cjs). */
    queued: (conn) => sockets.get(conn)?.bufferedAmount ?? 0,
  };
  const hello = JSON.stringify({ v: 1, hostId: identity.hostId });
  const server = http.createServer((req, res) => {
    const target = parseTarget(req.url);
    if (req.method === "GET" && target?.pathname === "/v1/hello") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(hello);
      return;
    }
    res.writeHead(404).end();
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = HEADERS_MS;
  server.requestTimeout = REQUEST_MS;
  // Until a socket becomes a phone's, silence is a reason to drop it.
  server.on("connection", (socket) => socket.setTimeout(idleMs, () => socket.destroy()));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    const target = parseTarget(req.url);
    const address = req.socket.remoteAddress ?? "";
    if (
      target?.pathname !== "/v1/phone" ||
      target.searchParams.get("id") !== identity.hostId ||
      sockets.size >= MAX_PHONES ||
      (perAddress.get(address) ?? 0) >= MAX_PER_ADDRESS
    ) {
      socket.end(notFound);
      return;
    }
    // From here the liveness ping watches the socket.
    socket.setTimeout(0);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = nextConn++;
      sockets.set(conn, ws);
      perAddress.set(address, (perAddress.get(address) ?? 0) + 1);
      alive.add(ws);
      ws.on("pong", () => alive.add(ws));
      channels.onFrame(session, frame(OPEN, conn));
      ws.on("message", (data, isBinary) => {
        // Nothing a phone sends may take the daemon down.
        alive.add(ws);
        try {
          if (!isBinary) return ws.close(1003);
          if (data.length > MAX_HELLO && session.conns.get(conn)?.state === "hello") return ws.terminate();
          channels.onFrame(session, frame(DATA, conn, new Uint8Array(data)));
        } catch {
          ws.terminate();
        }
      });
      ws.on("close", () => {
        if (sockets.get(conn) === ws) sockets.delete(conn);
        const left = (perAddress.get(address) ?? 1) - 1;
        if (left > 0) perAddress.set(address, left);
        else perAddress.delete(address);
        channels.onFrame(session, frame(CLOSE, conn));
      });
      ws.on("error", () => {});
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      // Only a host that is listening has sockets to watch: a failed listen must leave no timer behind.
      const pinger = setInterval(() => {
        for (const ws of sockets.values()) {
          if (!alive.has(ws)) {
            ws.terminate();
            continue;
          }
          alive.delete(ws);
          try {
            ws.ping();
          } catch {
            ws.terminate();
          }
        }
      }, pingMs);
      pinger.unref();
      resolve({
        port: server.address().port,
        connectedKeys: () => channels.keysOf(session),
        drop: (key) => channels.dropKey(session, key),
        async close() {
          clearInterval(pinger);
          for (const conn of session.conns.keys()) channels.dropConn(session, conn, false);
          for (const ws of sockets.values()) ws.terminate();
          sockets.clear();
          server.closeAllConnections?.();
          await new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

module.exports = { startLanHost, LAN_PORT: 8798 };
