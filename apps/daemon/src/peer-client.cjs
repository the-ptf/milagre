const { EventEmitter } = require("node:events");
const { randomBytes } = require("node:crypto");
const { phoneHello, phoneFinish, fromB64url } = require("@milagre/shared/relay-crypto");
const { createFrameReader, createFrameWriter } = require("@milagre/shared/peer-frames");
const { deadlineFor } = require("./client.cjs");
const { createPeerStreams } = require("./peer-streams.cjs");
const { VERSION, MAX_PENDING } = require("./protocol.cjs");

const ACCEPT = 0x02;
const REFUSED = 0x04;
// A Mac holding a computer's first hello until its owner allows it (phone-channels.cjs), again every 20 s.
const PENDING = 0x05;
// As the phone's relay transport (apps/mobile/src/relay-transport.ts:66-70): the hello's reply within 15 s, a ping every
// 20 s, and a socket that says nothing for 45 s is dead. The Mac's pending notices count, so the same 45 s catches a
// Mac that went away while its owner decided; ALLOW_MS bounds that wait by the 10-minute pairing window.
const HANDSHAKE_MS = 15_000;
const PING_MS = 20_000;
const SILENCE_MS = 45_000;
const ALLOW_MS = 11 * 60_000;
// The relay's close codes (apps/relay/src/room.mjs): the Mac closed the socket, no Mac in the room, room full.
const CLOSE_BY_HOST = 1000;
const CLOSE_HOST_OFFLINE = 4404;
const CLOSE_ROOM_FULL = 4429;
const DESKTOP_PEER = "desktop-peer-v1";
// A computer that takes TCP streams on the channel (peer-streams.cjs); an older one drops the channel on their messages.
const PEER_TCP = "peer-tcp-v1";
// Asked for in the hello: the Mac then sends a window's messages as one frame (phone-channels.cjs).
const BATCH_CAP = "batch";
// A paired Mac is not trusted like the local daemon: a paged reply may not announce more than MAX_PAGES pages nor run
// past MAX_PAGED_CHARS in all. The daemon holds at most 96 Mi characters of pages at once (server.cjs PAGES_BUDGET_CHARS)
// in pages of up to 1 Mi, so these have headroom over any real reply.
const MAX_PAGES = 1024;
const MAX_PAGED_CHARS = 128 * 1024 * 1024;
// Refusals that retrying can't change: the computer must be paired again (or its keys found).
const FINAL = new Set(["denied", "unknown-phone", "reset", "bad-token", "kind", "bad-host", "keys"]);
const decoder = new TextDecoder();

/** Why a computer turned this Mac away or couldn't be reached; computer-errors.cjs words it. */
class PeerError extends Error {
  /** @param {string} code @param {boolean} [final] */
  constructor(code, final = FINAL.has(code)) {
    super(`Couldn't connect to the computer (${code})`);
    this.name = "PeerError";
    this.code = code;
    this.final = final;
  }
}

/** The code for a Mac's refusal `{ t: "error", code, reason? }` (phone-channels.cjs). */
function refusalCode(refusal) {
  const { code, reason } = refusal ?? {};
  if (code === "unknown-phone") return reason === "denied" ? "denied" : reason === "busy" ? "busy" : "unknown-phone";
  if (code === "bad-token") return reason === "reset" ? "reset" : "bad-token";
  if (code === "bad-hello") return reason === "kind" ? "kind" : "bad-hello";
  return "lost";
}

function toBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null; // a text frame: the relay and the LAN host only send binary
}
const defaultRandom = (n) => new Uint8Array(randomBytes(n));
const defaultSocket = (url) => new WebSocket(url);

/**
 * Opens one paired-desktop channel to a computer and reads its daemon:status: over the relay (`url` is its base, e.g.
 * wss://relay.milagre.cloud) or the LAN (ws://<address>:8798); both serve /v1/phone?id=<hostId>. The hello carries
 * `kind: "desktop"` and this Mac's `name`; `hostKey` is the Mac's box key pinned from its link. Resolves with a client
 * shaped like @milagre/daemon/client's `connect` (call, close, status, "event", "close"), so daemon-runtime.cjs drives
 * it as it drives the socket. Rejects with a PeerError. `onPending()` runs once if the Mac holds this first pairing for
 * its owner's Allow; `signal` cancels the attempt ("cancelled").
 * @param {{
 *   url: string; hostId: string; hostKey: string; token: string; identity: any; name?: string;
 *   onPending?: () => void; signal?: AbortSignal; random?: (n: number) => Uint8Array; createSocket?: (url: string) => any;
 *   timeoutMs?: number; maxPagedChars?: number; acceptStream?: (target: string, port: number) => import("node:net").Socket;
 * }} options
 */
async function connectPeer({
  url,
  hostId,
  hostKey,
  token,
  identity,
  name,
  onPending,
  signal,
  random = defaultRandom,
  createSocket = defaultSocket,
  acceptStream,
  timeoutMs = 30_000,
  maxPagedChars = MAX_PAGED_CHARS,
}) {
  if (signal?.aborted) throw new PeerError("cancelled");
  let host, hello;
  try {
    host = fromB64url(hostKey);
    hello = phoneHello({ phone: identity, host, token, random, name, kind: "desktop", caps: [BATCH_CAP] });
  } catch {
    // A malformed pinned key or identity: this Mac's stored keys for the computer are unusable.
    throw new PeerError("keys");
  }
  const socket = createSocket(`${url.replace(/\/+$/, "")}/v1/phone?id=${encodeURIComponent(hostId)}`);
  socket.binaryType = "arraybuffer";
  const client = Object.assign(new EventEmitter(), {
    closed: false,
    /** @type {any} */
    status: undefined,
    /** @type {(method: string, args?: unknown[]) => Promise<any>} */
    call: async () => undefined,
    close: () => {},
    /** @type {(beforeClose?: () => void) => void} */
    closeWhenIdle: () => {},
    keepOpen: () => {},
    /** @type {(target: string, port: number) => Promise<import("node:stream").Duplex>} */
    openStream: async () => {
      throw new Error("Not connected");
    },
  });
  const pending = new Map();
  // Calls past MAX_PENDING wait here for a free slot (the daemon drops a connection that sends more).
  const queued = [];
  const reader = createFrameReader("evt");
  const writer = createFrameWriter("rpc");
  /** @type {import("@milagre/shared/relay-crypto").Channel | null} */
  let channel = null;
  let nextId = 0;
  // TCP streams this Mac opens from the computer; open ones keep a closeWhenIdle waiting, as calls do.
  const streams = createPeerStreams({
    // The computer may open streams back only where `acceptStream` dials them (it throws everywhere else).
    ...(acceptStream ? { dial: acceptStream } : {}),
    send: (message) => {
      if (channel && !client.closed) send(channel.seal(message));
    },
    onIdle: () => closeIfIdle(),
  });
  // Whether the daemon answered anything on this channel: a close before that, by the Mac, is a Mac from before PR 1.
  let answered = false;
  /** @type {Error | null} */
  let failure = null;
  // Paged replies being read (readPages): a call whose answer is still arriving page by page.
  let paging = 0;
  /** @type {(() => void) | null} */
  let whenIdle = null;
  /** Runs a pending closeWhenIdle once nothing is in flight. */
  function closeIfIdle() {
    if (!whenIdle || client.closed || pending.size > 0 || queued.length > 0 || paging > 0 || streams.size > 0) return;
    const before = whenIdle;
    whenIdle = null;
    try {
      before();
    } catch {
      /* the caller's bug must not keep the channel open */
    }
    client.close();
  }
  let handshake, silence, ping, allowDeadline;
  /** @type {{ resolve: (value: unknown) => void; reject: (error: Error) => void } | null} */
  let settle = null;
  const opened = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  function end(error) {
    if (client.closed) return;
    client.closed = true;
    failure = error;
    for (const timer of [handshake, silence, ping, allowDeadline]) clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
    for (const request of [...pending.values(), ...queued]) {
      clearTimeout(request.timeout);
      request.reject(new Error("Daemon connection closed"));
    }
    pending.clear();
    queued.length = 0;
    streams.close();
    if (settle) {
      settle.reject(error);
      settle = null;
    } else client.emit("close");
  }
  function cancel() {
    end(new PeerError("cancelled"));
  }
  signal?.addEventListener("abort", cancel, { once: true });
  function send(bytes) {
    try {
      socket.send(bytes);
    } catch {
      end(new PeerError("lost"));
    }
  }
  function heard() {
    clearTimeout(silence);
    silence = setTimeout(() => end(new PeerError("lost")), SILENCE_MS);
  }
  function tick() {
    if (client.closed || !channel) return;
    send(channel.seal({ t: "ping" }));
    ping = setTimeout(tick, PING_MS);
  }
  function waitForAllow() {
    clearTimeout(handshake);
    if (allowDeadline) return;
    allowDeadline = setTimeout(() => end(new PeerError("unknown-phone")), ALLOW_MS);
    try {
      onPending?.();
    } catch {
      /* the caller's bug must not end the pairing */
    }
  }
  /** One daemon frame: an event, or the answer to a call (as @milagre/daemon/client reads the socket's). */
  function receive(frame) {
    if (frame?.v !== VERSION) return end(new PeerError("outdated"));
    if (frame.event) {
      client.emit("event", frame.event);
      return;
    }
    answered = true;
    const request = pending.get(frame.id);
    if (!request) return;
    pending.delete(frame.id);
    clearTimeout(request.timeout);
    drain();
    if (frame.error) request.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
    else if (frame.pages) request.resolve(readPages(frame.pages));
    else request.resolve(frame.result);
    closeIfIdle();
  }
  // A response too large for one frame (a big Project's state) arrives as pages, read one at a time in order.
  async function readPages({ pageId, pageCount }) {
    paging++;
    try {
      if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) throw new Error("The daemon sent an invalid paged response");
      const parts = [];
      let chars = 0;
      for (let index = 0; index < pageCount; index++) {
        const part = await client.call("daemon:result-page", [pageId, index]);
        if (typeof part !== "string") throw new Error("The daemon sent an invalid paged response");
        chars += part.length;
        if (chars > maxPagedChars) throw new Error("The daemon's paged response is too large");
        parts.push(part);
      }
      return JSON.parse(parts.join(""));
    } finally {
      paging--;
      closeIfIdle();
    }
  }

  socket.addEventListener("open", () => {
    if (!client.closed) send(hello.message);
  });
  // A failed socket always closes afterwards, with the code that says why.
  socket.addEventListener("error", () => {});
  socket.addEventListener("close", (event) => {
    const code = event?.code;
    if (!channel) end(new PeerError(code === CLOSE_ROOM_FULL ? "full" : code === CLOSE_HOST_OFFLINE ? "offline" : "lost"));
    // A Mac from before PR 1 takes the hello as a phone's and closes on the first rpc message.
    else end(new PeerError(!answered && code === CLOSE_BY_HOST ? "outdated" : "lost"));
  });
  socket.addEventListener("message", (event) => {
    if (client.closed) return;
    const bytes = toBytes(event?.data);
    if (!bytes?.length) return end(new PeerError("lost"));
    heard();
    if (channel) {
      const frames = [];
      try {
        const message = /** @type {any} */ (channel.open(bytes));
        // A Mac that batches (this hello asked for it) sends a window's messages as one, in order.
        const items = message?.t === "batch" ? message.items : [message];
        if (!Array.isArray(items)) throw new Error("Malformed batch");
        for (const item of items) {
          if (item?.t === "pong") continue;
          if (streams.isStreamMessage(item)) {
            streams.receive(item);
            continue;
          }
          const read = reader.read(item);
          if (read) frames.push(read.frame);
        }
      } catch {
        return end(new PeerError("lost"));
      }
      for (const frame of frames) {
        if (client.closed) return;
        receive(frame);
      }
      return;
    }
    if (bytes[0] === PENDING) return waitForAllow();
    clearTimeout(handshake);
    clearTimeout(allowDeadline);
    if (bytes[0] === REFUSED) {
      let refusal = null;
      try {
        refusal = JSON.parse(decoder.decode(bytes.subarray(1)));
      } catch {
        /* unreadable: a drop */
      }
      return end(new PeerError(refusalCode(refusal)));
    }
    if (bytes[0] !== ACCEPT) return end(new PeerError("lost"));
    try {
      channel = phoneFinish({ ephemeral: hello.ephemeral, phone: identity, host, reply: bytes });
    } catch {
      return end(new PeerError("bad-host"));
    }
    ping = setTimeout(tick, PING_MS);
    settle?.resolve(undefined);
    settle = null;
  });
  handshake = setTimeout(() => end(new PeerError("lost")), HANDSHAKE_MS);

  function start(request) {
    if (client.closed || !channel) {
      clearTimeout(request.timeout);
      return request.reject(new Error("Daemon connection closed"));
    }
    const id = ++nextId;
    let texts;
    try {
      texts = writer.write(JSON.stringify({ v: VERSION, id, method: request.method, args: request.args, pages: true }));
    } catch (error) {
      clearTimeout(request.timeout);
      return request.reject(error);
    }
    request.id = id;
    pending.set(id, request);
    for (const text of texts) send(channel.sealEncoded(text));
  }
  function drain() {
    while (queued.length > 0 && pending.size < MAX_PENDING) start(queued.shift());
  }
  client.call = (method, args = []) =>
    new Promise((resolve, reject) => {
      if (client.closed || !channel) return reject(new Error("Daemon connection closed"));
      // The deadline counts time spent queued, so a call never waits longer than it would have unqueued.
      /** @type {{ id: number; method: string; args: unknown[]; resolve: (value: any) => void; reject: (error: Error) => void; timeout?: ReturnType<typeof setTimeout> }} */
      const request = { id: 0, method, args, resolve, reject };
      request.timeout = setTimeout(
        () => {
          pending.delete(request.id);
          const index = queued.indexOf(request);
          if (index >= 0) queued.splice(index, 1);
          reject(new Error(`Timed out: ${method}. It may still be running; do not retry a mutation without checking state.`));
          drain();
          closeIfIdle();
        },
        deadlineFor(method, timeoutMs),
      );
      if (pending.size >= MAX_PENDING) queued.push(request);
      else start(request);
    });
  client.close = () => end(new PeerError("lost"));
  /** A TCP stream to `target:port` as the computer sees them (its localhost is its own), carried on this channel. */
  client.openStream = (target, port) => {
    if (client.closed || !channel) return Promise.reject(new Error("Daemon connection closed"));
    if (!client.status?.capabilities?.includes(PEER_TCP))
      return Promise.reject(
        Object.assign(new Error("This computer's Milagre is too old to open its pages here. Update it, then try again."), { code: "outdated" }),
      );
    return streams.open(target, port);
  };
  /** Closes once no call waits for its answer (`beforeClose` runs just before), or now when none does. */
  client.closeWhenIdle = (beforeClose = () => {}) => {
    whenIdle = beforeClose;
    closeIfIdle();
  };
  /** Takes back a closeWhenIdle that hasn't closed yet. */
  client.keepOpen = () => {
    whenIdle = null;
  };

  await opened;
  let status;
  try {
    status = await client.call("daemon:status");
  } catch (error) {
    const reason = failure;
    client.close();
    throw reason ?? error;
  }
  if (!status?.capabilities?.includes(DESKTOP_PEER) || !Array.isArray(status.methods)) {
    client.close();
    throw new PeerError("outdated");
  }
  client.status = status;
  // The signal only cancels the attempt; once connected, aborting it must not close the live client.
  signal?.removeEventListener("abort", cancel);
  return client;
}

module.exports = { connectPeer, PeerError };
