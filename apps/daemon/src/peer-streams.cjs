const net = require("node:net");
const { Duplex } = require("node:stream");

// TCP streams on a paired desktop's channel, beside its rpc / evt / part messages (peer-channel.cjs, peer-client.cjs).
// The desktop opens a stream to a host and port as seen from the computer; the computer dials it and the bytes flow
// both ways as base64 inside the sealed channel, like a part's. A remote Chat's Browser pages reach that computer's
// localhost this way (#832).
//   desktop → computer  { t: "tcp-open", id, host, port }
//   computer → desktop  { t: "tcp-opened", id }
//   either way          { t: "tcp", id, data }      data: base64 of at most CHUNK bytes
//                       { t: "tcp-ack", id, n }     n bytes of the other side's data were taken
//                       { t: "tcp-end", id }        no more data this way (half close)
//                       { t: "tcp-close", id, code? }  the stream is gone; code says why it failed or was refused
// Each side keeps at most WINDOW bytes unacknowledged per stream, so a slow reader slows its sender instead of filling
// the channel: MAX_STREAMS × WINDOW in base64 stays well under a desktop's channel budget (peer-channel.cjs).
const CHUNK = 32 * 1024;
const WINDOW = 128 * 1024;
const ACK_EVERY = 32 * 1024;
const MAX_STREAMS = 64;
const DIAL_MS = 10_000;
const MAX_DATA = Math.ceil(CHUNK / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// A host name or an IP address, as a browser's SOCKS request names it.
const HOST = /^(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\.?)+$|^[0-9A-Fa-f:.]+$/;
const STREAM_MESSAGES = new Set(["tcp-open", "tcp-opened", "tcp", "tcp-ack", "tcp-end", "tcp-close"]);

/** Why a dial failed, in words the desktop shows (refused, not-found, timeout, unreachable, busy, failed). */
function dialCode(error) {
  switch (error?.code) {
    case "ECONNREFUSED":
      return "refused";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "not-found";
    case "ETIMEDOUT":
      return "timeout";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "unreachable";
    default:
      return "failed";
  }
}

const isStreamMessage = (message) => STREAM_MESSAGES.has(message?.t);
const validId = (id) => Number.isSafeInteger(id) && id > 0;
const validTarget = (host, port) => typeof host === "string" && host.length <= 253 && HOST.test(host) && Number.isInteger(port) && port > 0 && port <= 65535;

/**
 * One side's streams on a channel. `send(message)` seals and sends one message. With `dial(host, port)` (the computer)
 * the other side may open streams, each dialed and piped to its socket; without it (the desktop) only `open` makes
 * them. `receive(message)` takes each stream message and throws on one that breaks the protocol, for the carrier to
 * drop the channel. `close()` ends every stream when the channel goes.
 * Either side may open streams: the desktop's ids are odd and the computer's even (`opener`), so the two never collide.
 * @param {{ send: (message: object) => void; dial?: (host: string, port: number) => import("node:net").Socket; onIdle?: () => void; dialMs?: number; opener?: "desktop" | "computer" }} options
 */
function createPeerStreams({ send, dial, onIdle = () => {}, dialMs = DIAL_MS, opener = "desktop" }) {
  /** @type {Map<number, { stream: Duplex | null; take(data: Buffer): void; acked(n: number): void; ended(): void; closed(code?: string): void }>} */
  const streams = new Map();
  /** @type {Map<number, { resolve: (stream: Duplex) => void; reject: (error: Error) => void }>} */
  const opening = new Map();
  let nextId = opener === "desktop" ? -1 : 0;
  let shut = false;

  /** The Duplex for stream `id`: its writes go to the other side, the other side's data comes out of it. */
  function makeStream(id) {
    let unacked = 0;
    /** @type {(() => void) | null} */
    let waiting = null;
    let owed = 0;
    let gone = false;
    const forget = () => {
      if (streams.get(id) !== entry) return;
      streams.delete(id);
      if (!streams.size && !opening.size) onIdle();
    };
    const ack = () => {
      if (owed && !gone) send({ t: "tcp-ack", id, n: owed });
      owed = 0;
    };
    const stream = new Duplex({
      allowHalfOpen: true,
      write(chunk, _encoding, callback) {
        if (gone) return callback(new Error("The stream closed"));
        for (let offset = 0; offset < chunk.length; offset += CHUNK) send({ t: "tcp", id, data: chunk.subarray(offset, offset + CHUNK).toString("base64") });
        unacked += chunk.length;
        if (unacked >= WINDOW) waiting = callback;
        else callback();
      },
      final(callback) {
        if (!gone) send({ t: "tcp-end", id });
        callback();
      },
      // The reader wants more: what it took is acknowledged, so the sender may go on.
      read() {
        ack();
      },
      destroy(error, callback) {
        if (!gone) {
          gone = true;
          send({ t: "tcp-close", id, ...(error ? { code: "failed" } : {}) });
        }
        forget();
        callback(error);
      },
    });
    const entry = {
      stream,
      take(data) {
        owed += data.length;
        // A sender stops at one window unacknowledged (one write may overshoot it); twice that broke the protocol.
        if (owed > WINDOW * 2) throw new Error("A stream ran past its window");
        // A full buffer holds its acks until read() asks for more: that is what slows the sender.
        if (stream.push(data) && owed >= ACK_EVERY) ack();
      },
      acked(n) {
        unacked = Math.max(0, unacked - n);
        if (waiting && unacked < WINDOW) {
          const callback = waiting;
          waiting = null;
          callback();
        }
      },
      ended() {
        stream.push(null);
      },
      closed(code) {
        gone = true;
        const callback = waiting;
        waiting = null;
        callback?.();
        stream.destroy(code ? Object.assign(new Error(`The stream closed (${code})`), { code }) : undefined);
        forget();
      },
    };
    streams.set(id, entry);
    // A stream that fails with no one listening must not take the process down; its users listen for themselves.
    stream.on("error", () => {});
    stream.on("end", () => {
      if (stream.writableFinished) stream.destroy();
    });
    stream.on("finish", () => {
      if (stream.readableEnded) stream.destroy();
    });
    return stream;
  }

  /** The computer: dials what the desktop asked for and joins the socket to the stream. */
  function accept(message) {
    const { id, host, port } = message;
    if (!validId(id) || streams.has(id)) throw new Error("Bad stream");
    if (!dial || !validTarget(host, port)) return send({ t: "tcp-close", id, code: "failed" });
    if (streams.size >= MAX_STREAMS) return send({ t: "tcp-close", id, code: "busy" });
    // Held until the socket connects, so the slot counts against MAX_STREAMS and a close from the desktop finds it.
    let socket;
    try {
      socket = dial(host, port);
    } catch (error) {
      return send({ t: "tcp-close", id, code: dialCode(error) });
    }
    const pendingEntry = {
      stream: null,
      take() {},
      acked() {},
      ended() {},
      closed() {
        clearTimeout(timer);
        socket.destroy();
        if (streams.get(id) === pendingEntry) streams.delete(id);
      },
    };
    streams.set(id, pendingEntry);
    const timer = setTimeout(() => socket.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), dialMs);
    socket.once("error", (error) => {
      if (streams.get(id) !== pendingEntry) return;
      clearTimeout(timer);
      streams.delete(id);
      send({ t: "tcp-close", id, code: dialCode(error) });
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      if (streams.get(id) !== pendingEntry || shut) return socket.destroy();
      streams.delete(id);
      const stream = makeStream(id);
      send({ t: "tcp-opened", id });
      socket.on("error", () => stream.destroy(new Error("The connection failed")));
      stream.on("error", () => socket.destroy());
      stream.on("close", () => socket.destroy());
      socket.pipe(stream).pipe(socket);
    });
  }

  return {
    isStreamMessage,
    /** Streams open or opening. */
    get size() {
      return streams.size + opening.size;
    },
    receive(message) {
      if (shut) return;
      const { id } = message;
      if (!validId(id)) throw new Error("Bad stream");
      switch (message.t) {
        case "tcp-open":
          return accept(message);
        case "tcp-opened": {
          const waiter = opening.get(id);
          if (!waiter) throw new Error("Bad stream");
          opening.delete(id);
          return waiter.resolve(makeStream(id));
        }
        case "tcp": {
          const { data } = message;
          if (typeof data !== "string" || data.length > MAX_DATA || data.length % 4 !== 0 || !BASE64.test(data)) throw new Error("Bad stream data");
          // Data for a stream this side already closed is late, not wrong.
          streams.get(id)?.take(Buffer.from(data, "base64"));
          return;
        }
        case "tcp-ack": {
          if (!Number.isSafeInteger(message.n) || message.n < 0) throw new Error("Bad stream ack");
          streams.get(id)?.acked(message.n);
          return;
        }
        case "tcp-end":
          streams.get(id)?.ended();
          return;
        case "tcp-close": {
          const code = typeof message.code === "string" ? message.code.slice(0, 32) : undefined;
          const waiter = opening.get(id);
          if (waiter) {
            opening.delete(id);
            waiter.reject(Object.assign(new Error(`The computer couldn't connect (${code ?? "failed"})`), { code: code ?? "failed" }));
            if (!streams.size && !opening.size) onIdle();
            return;
          }
          streams.get(id)?.closed(code);
          return;
        }
        default:
          throw new Error("Unknown stream message");
      }
    },
    /** The desktop: a stream to `host:port` as the computer sees them, once the computer has connected it. */
    open(host, port) {
      if (shut) return Promise.reject(new Error("The channel closed"));
      if (!validTarget(host, port)) return Promise.reject(new Error("Invalid address"));
      if (streams.size + opening.size >= MAX_STREAMS)
        return Promise.reject(Object.assign(new Error("Too many connections to this computer"), { code: "busy" }));
      const id = (nextId += 2);
      return new Promise((resolve, reject) => {
        opening.set(id, { resolve, reject });
        send({ t: "tcp-open", id, host, port });
      });
    },
    /** The channel went: every stream ends without a word to the other side. */
    close() {
      if (shut) return;
      shut = true;
      for (const waiter of opening.values()) waiter.reject(Object.assign(new Error("The channel closed"), { code: "lost" }));
      opening.clear();
      for (const [id, entry] of Array.from(streams)) {
        streams.delete(id);
        entry.closed(entry.stream ? "lost" : undefined);
      }
    },
  };
}

/** Dials as the computer does: TCP, no Nagle delay, as a browser would. */
const dialTcp = (host, port) => net.connect({ host, port, noDelay: true });

module.exports = { createPeerStreams, dialTcp, isStreamMessage, CHUNK, WINDOW, MAX_STREAMS };
