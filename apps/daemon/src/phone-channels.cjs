const { hostAccept, RelayAuthError } = require("@milagre/shared/relay-crypto");
const { splitBody, createAssembler, MAX_RESPONSE } = require("@milagre/shared/relay-rpc");
const { openPeerChannel } = require("./peer-channel.cjs");

const OPEN = 1,
  DATA = 2,
  CLOSE = 3;
const ERROR_MARK = 0x04;
// Sent before a computer's first hello is answered: the Mac is waiting for its owner's Allow (phone.cjs).
const PENDING_MARK = 0x05;
// Repeated while the owner decides, so the desktop knows the Mac is still there and the relay doesn't drop an idle socket.
const PENDING_REPEAT_MS = 20_000;
const LIVE_ORIGIN = "milagre-app://phone";
const MAX_LIVE = 8;
const MAX_INFLIGHT = 16;
// Requests past MAX_INFLIGHT wait for a free slot instead of failing: on a busy Mac slow answers fill the slots, and a
// refusal only makes the phone ask again. Past these a flood is still refused (429).
const MAX_QUEUED = 64;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
// The phone can't cancel a relayed request and gives up after 30 s at the least, so one that waited this long is
// refused (429: it never ran, the phone may send it again) rather than run late, like a Stop landing on a newer turn.
const MAX_QUEUE_WAIT = 20_000;
const MAX_UPLOAD = 8 * 1024 * 1024;
// Longer than the phone's own deadline for the slowest call (worktree:create, 330 s), so the phone gives up first.
const REQUEST_TIMEOUT = 340_000;
// What the phone may set. Origin and Host belong to the bridge's own checks, and Authorization is ours.
const BLOCKED_HEADERS = new Set(["host", "origin", "authorization", "connection", "content-length", "transfer-encoding", "upgrade", "cookie"]);
const FORWARDED_HEADERS = ["content-type", "etag"];
const encoder = new TextEncoder();
const PENDING_NOTICE = new Uint8Array([PENDING_MARK, ...encoder.encode('{"t":"pending"}')]);
// What a refused computer hears for each answer that isn't Allow; "expired" and "dropped" add nothing to unknown-phone.
const NOT_ALLOWED = { denied: { reason: "denied" }, busy: { reason: "busy" } };

function frame(type, conn, payload = new Uint8Array()) {
  const out = new Uint8Array(9 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setBigUint64(1, conn);
  out.set(payload, 9);
  return out;
}

const tooLarge = encoder.encode(JSON.stringify({ v: 1, error: { message: "Upload too large" } }));
const tooManyRequests = encoder.encode(JSON.stringify({ v: 1, error: { message: "Too many requests" } }));
const routeOk = (path) => typeof path === "string" && path.startsWith("/") && !path.startsWith("//");

/**
 * One encrypted channel per device, whatever carries its bytes: the public relay (frames multiplexed on the Mac's
 * relay socket) or the LAN listener (one socket per device). A `session` is `{ conns, send(bytes), queued?(conn) }`;
 * `send` takes a whole frame (type, conn id, payload) and delivers it to that device, and `queued` says how many bytes
 * it holds unsent toward one (`peerBudget`, optional, replaces a desktop's default limit on that when `queued` is
 * shared among devices). `send` must also handle CLOSE frames: the channel emits them (after a refusal, or when it
 * drops a connection) and the carrier has to close that device's socket.
 * A phone speaks HTTP-over-channel to the loopback bridge. A desktop (hello `kind: "desktop"`, saved as a "computer")
 * is one more client of the daemon instead: `openPeer(carrier)` opens its connection and peer-channel.cjs carries its
 * frames. Without `openPeer` desktops are turned away. `phones` is the devices store (`isKnown`, `kindOf`, `add`, `seen`).
 * A computer's first hello waits for `allowComputer({ key, name, signal, waiting })` (phone.cjs), which resolves
 * "allowed", "denied", "expired", "busy" or "dropped" and calls `waiting()` once it holds the request.
 */
function createPhoneChannels({
  identity,
  phones,
  token,
  bridgeUrl,
  canPair,
  retired = false,
  WebSocket,
  fetch: fetchBridge,
  random,
  helloMs,
  openPeer,
  allowComputer,
  pendingRepeatMs = PENDING_REPEAT_MS,
  queueWaitMs = MAX_QUEUE_WAIT,
}) {
  const sendFrame = (current, type, conn, payload) => current.send(frame(type, conn, payload));
  function sendMessage(current, conn, record, message) {
    if (current.conns.get(conn) !== record || !record.channel) return;
    sendFrame(current, DATA, conn, record.channel.seal(message));
  }

  function closeLives(record) {
    for (const live of record.lives.values()) {
      try {
        live.close(1001);
      } catch {
        /* already closed */
      }
    }
    record.lives.clear();
  }
  /** Forgets one phone connection. `notify` tells the relay so the phone's socket closes too. */
  function dropConn(current, conn, notify) {
    const record = current.conns.get(conn);
    if (!record) return;
    current.conns.delete(conn);
    clearTimeout(record.helloTimer);
    // A computer still waiting for Allow: its request goes with its channel, and the notices stop even if the owner never answers the abort.
    record.abort?.abort();
    clearInterval(record.pendingTimer);
    closeLives(record);
    // A desktop's daemon connection goes with its channel.
    record.peer?.close();
    for (const queued of record.queue.splice(0)) clearTimeout(queued.expiry);
    if (notify) sendFrame(current, CLOSE, conn);
  }

  function refuse(current, conn, code, extra) {
    sendFrame(current, DATA, conn, new Uint8Array([ERROR_MARK, ...encoder.encode(JSON.stringify({ t: "error", code, ...extra }))]));
    dropConn(current, conn, true);
  }

  /**
   * Holds a computer's first hello until this Mac's owner answers. The channel stays open with no daemon connection;
   * the desktop hears PENDING_NOTICE (outside the channel, which isn't open yet) now and every pendingRepeatMs, and
   * anything it sends meanwhile drops it (onFrame only reads open channels). No `allowComputer`: no one can say yes.
   */
  async function waitForAllow(current, conn, record, accepted) {
    if (!allowComputer) return "expired";
    record.state = "pending";
    clearTimeout(record.helloTimer);
    const abort = new AbortController();
    record.abort = abort;
    const notice = () => sendFrame(current, DATA, conn, PENDING_NOTICE);
    try {
      return await allowComputer({
        key: accepted.phoneKey,
        name: accepted.name,
        signal: abort.signal,
        waiting() {
          // Once per request, and not after it is over.
          if (record.pendingTimer || record.abort !== abort) return;
          notice();
          record.pendingTimer = setInterval(notice, pendingRepeatMs);
        },
      });
    } catch {
      // The request may have registered before it threw: tell it to stop, so it doesn't keep holding a slot.
      abort.abort();
      return "dropped";
    } finally {
      // Only this request's own notices and abort: a wait that replaced it on this record keeps its own.
      if (record.abort === abort) {
        clearInterval(record.pendingTimer);
        record.pendingTimer = null;
        record.abort = null;
      }
    }
  }

  async function hello(current, conn, record, bytes) {
    record.state = "accepting";
    // Nothing to decrypt: whoever dials a retired room only needs to hear that the Mac was reset.
    if (retired) return refuse(current, conn, "bad-token", { reason: "reset" });
    let accepted;
    try {
      accepted = hostAccept({ host: identity.box, hello: bytes, isKnown: (id) => phones.isKnown(id), canPair: (id) => !!canPair(id), token, random });
    } catch (error) {
      if (error instanceof RelayAuthError) return refuse(current, conn, error.code);
      return refuse(current, conn, "bad-hello");
    }
    // The hello says "desktop"; the store says "computer".
    const kind = accepted.kind === "desktop" ? "computer" : "phone";
    // A desktop drives the daemon itself. A host with no daemon to hand it (a confined demo) turns it away unsaved.
    if (kind === "computer" && !openPeer) return refuse(current, conn, "bad-hello", { reason: "kind" });
    // A device keeps the kind it paired as: a phone's key saying "desktop" would trade the bridge's allow-list for the
    // whole daemon.
    const stored = accepted.firstPairing ? null : phones.kindOf(accepted.phoneKey);
    if (stored && stored !== kind) return refuse(current, conn, "bad-hello", { reason: "kind" });
    // Set before any wait, so a removal that lands meanwhile finds this channel.
    record.key = accepted.phoneKey;
    // A computer's first pairing waits for its owner's Allow on this Mac; nothing is saved before it.
    if (accepted.firstPairing && kind === "computer") {
      const verdict = await waitForAllow(current, conn, record, accepted);
      if (current.conns.get(conn) !== record) return;
      if (verdict !== "allowed") return refuse(current, conn, "unknown-phone", NOT_ALLOWED[verdict]);
    }
    if (accepted.firstPairing) {
      try {
        await phones.add(accepted.phoneKey, { kind, name: accepted.name });
      } catch {
        return dropConn(current, conn, true);
      }
    } else {
      // When it was last here, and its name if it changed. A failed write never closes a known device's channel.
      void Promise.resolve(phones.seen?.(accepted.phoneKey, { name: accepted.name })).catch(() => {});
    }
    if (current.conns.get(conn) !== record) return;
    record.channel = accepted.channel;
    record.state = "open";
    clearTimeout(record.helloTimer);
    record.kind = kind;
    sendFrame(current, DATA, conn, accepted.reply);
    if (kind === "computer") {
      try {
        record.peer = openPeerChannel({
          openPeer,
          channel: record.channel,
          deliver: (sealed) => sendFrame(current, DATA, conn, sealed),
          queued: () => current.queued?.(conn) ?? 0,
          budget: current.peerBudget,
          isOpen: () => current.conns.get(conn) === record,
          drop: () => dropConn(current, conn, true),
        });
      } catch {
        // A desktop with no daemon connection has nothing to talk to, and must never fall through to the bridge.
        return dropConn(current, conn, true);
      }
      // The connection ended while it was being built: dropConn found no peer to close.
      if (current.conns.get(conn) !== record) record.peer.close();
    }
  }

  /** Keys of the devices whose channel on this carrier finished its hello. */
  function keysOf(current) {
    const keys = new Set();
    for (const record of current.conns.values()) if (record.state === "open" && record.key) keys.add(record.key);
    return [...keys];
  }

  /** Closes every channel `key` has on this carrier, and tells the carrier to close their sockets. */
  function dropKey(current, key) {
    for (const [conn, record] of Array.from(current.conns)) if (record.key === key) dropConn(current, conn, true);
  }

  /** Sends a whole response as `res` parts. */
  function respond(current, conn, record, id, status, headers, body) {
    const parts = splitBody(body);
    parts.forEach((chunk, index) => sendMessage(current, conn, record, { t: "res", id, status, headers, chunk, more: index < parts.length - 1 }));
  }
  const JSON_HEADERS = { "content-type": "application/json" };

  async function forward(current, conn, record, { id, method, path, headers: phoneHeaders }, body) {
    record.inflight += 1;
    try {
      const headers = {};
      for (const [name, value] of Object.entries(phoneHeaders ?? {})) {
        if (typeof value === "string" && !BLOCKED_HEADERS.has(name.toLowerCase())) headers[name] = value;
      }
      headers.Authorization = `Bearer ${token}`;
      const response = await fetchBridge(bridgeUrl + path, {
        method,
        headers,
        body: method === "POST" && body.length ? body : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const forwarded = {};
      for (const name of FORWARDED_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) forwarded[name] = value;
      }
      if (bytes.length > MAX_RESPONSE)
        respond(current, conn, record, id, 502, JSON_HEADERS, encoder.encode(JSON.stringify({ v: 1, error: { message: "Response too large" } })));
      else respond(current, conn, record, id, response.status, forwarded, bytes);
    } catch (error) {
      const timedOut = error?.name === "TimeoutError";
      respond(
        current,
        conn,
        record,
        id,
        timedOut ? 504 : 502,
        JSON_HEADERS,
        encoder.encode(JSON.stringify({ v: 1, error: { message: timedOut ? "The computer took too long to answer" : "The computer could not be reached" } })),
      );
    } finally {
      record.inflight -= 1;
      const next = record.queue.shift();
      if (next) {
        clearTimeout(next.expiry);
        record.queuedBytes -= next.body.length;
        if (current.conns.get(conn) === record) void forward(current, conn, record, next.meta, next.body);
      }
    }
  }

  /**
   * One part of a request. The first part carries the method, path and headers; the body arrives as
   * base64 chunks, reassembled here and capped at MAX_UPLOAD. Throws on a malformed part: the caller closes the connection.
   */
  function requestPart(current, conn, record, message) {
    const { id } = message;
    if (!Number.isSafeInteger(id) || typeof message.chunk !== "string" || typeof message.more !== "boolean") throw new Error("Bad request part");
    if (record.rejected.has(id)) {
      if (!message.more) record.rejected.delete(id);
      return;
    }
    let upload = record.uploads.get(id);
    if (!upload) {
      if (record.inflight + record.uploads.size + record.queue.length >= MAX_INFLIGHT + MAX_QUEUED)
        return refuseRequest(current, conn, record, message, 429, tooManyRequests);
      if ((message.method !== "GET" && message.method !== "POST") || !routeOk(message.path))
        return refuseRequest(current, conn, record, message, 400, new Uint8Array());
      upload = { size: 0, meta: { id, method: message.method, path: message.path, headers: message.headers } };
      record.uploads.set(id, upload);
    }
    upload.size += Math.floor((message.chunk.length * 3) / 4);
    if (upload.size > MAX_UPLOAD) {
      record.assembler.drop(id);
      record.uploads.delete(id);
      return refuseRequest(current, conn, record, message, 413, tooLarge);
    }
    let result;
    try {
      result = record.assembler.add({ t: "res", id, status: 0, headers: {}, chunk: message.chunk, more: message.more });
    } catch (error) {
      record.assembler.drop(id);
      record.uploads.delete(id);
      throw error;
    }
    if (!result.done) return;
    record.uploads.delete(id);
    if (record.inflight < MAX_INFLIGHT) return void forward(current, conn, record, upload.meta, result.body);
    if (record.queuedBytes + result.body.length > MAX_QUEUED_BYTES) return respond(current, conn, record, id, 429, JSON_HEADERS, tooManyRequests);
    const queued = { meta: upload.meta, body: result.body };
    queued.expiry = setTimeout(() => {
      const at = record.queue.indexOf(queued);
      if (at < 0) return;
      record.queue.splice(at, 1);
      record.queuedBytes -= queued.body.length;
      respond(current, conn, record, id, 429, JSON_HEADERS, tooManyRequests);
    }, queueWaitMs);
    record.queue.push(queued);
    record.queuedBytes += result.body.length;
  }

  /** Answers a request without forwarding it; the rest of its parts are skipped. */
  function refuseRequest(current, conn, record, message, status, body) {
    if (message.more) {
      if (record.rejected.size >= 64) throw new Error("Too many abandoned uploads");
      record.rejected.add(message.id);
    }
    respond(current, conn, record, message.id, status, JSON_HEADERS, body);
  }

  function liveOpen(current, conn, record, message) {
    const { id } = message;
    const refuseLive = (code) => sendMessage(current, conn, record, { t: "live-close", id, code });
    if (!Number.isSafeInteger(id) || record.lives.has(id) || !routeOk(message.path)) return refuseLive(1008);
    if (record.lives.size >= MAX_LIVE) return refuseLive(1013);
    const live = new WebSocket(bridgeUrl.replace(/^http/, "ws") + message.path, { headers: { Authorization: `Bearer ${token}`, Origin: LIVE_ORIGIN } });
    record.lives.set(id, live);
    live.on("message", (data) => {
      if (record.lives.get(id) === live) sendMessage(current, conn, record, { t: "live", id, data: data.toString() });
    });
    const ended = (code) => {
      if (record.lives.get(id) !== live) return;
      record.lives.delete(id);
      sendMessage(current, conn, record, { t: "live-close", id, code });
    };
    live.on("close", (code) => ended(code));
    live.on("error", () => ended(1011)); // ws emits close after error; the first one wins
  }

  function handleMessage(current, conn, record, message) {
    if (!message || typeof message !== "object") throw new Error("Not a message");
    // A desktop's channel speaks peer messages only (peer-channel.cjs), never HTTP-over-channel.
    if (record.kind === "computer") {
      if (!record.peer) throw new Error("No peer");
      return record.peer.receive(message);
    }
    switch (message.t) {
      case "req":
        requestPart(current, conn, record, message);
        break;
      case "live-open":
        liveOpen(current, conn, record, message);
        break;
      case "live": {
        const live = record.lives.get(message.id);
        if (live && live.readyState === WebSocket.OPEN && typeof message.data === "string") live.send(message.data);
        break;
      }
      case "live-close": {
        const live = record.lives.get(message.id);
        if (live) {
          record.lives.delete(message.id);
          live.close(1000);
        }
        break;
      }
      case "ping":
        sendMessage(current, conn, record, { t: "pong" });
        break;
      default:
        throw new Error("Unknown message");
    }
  }

  function onFrame(current, data) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.length < 9) return;
    const type = bytes[0];
    const conn = new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(1);
    const payload = bytes.subarray(9);
    if (type === OPEN) {
      const record = {
        state: "hello",
        channel: null,
        lives: new Map(),
        inflight: 0,
        queue: [],
        queuedBytes: 0,
        uploads: new Map(),
        rejected: new Set(),
        assembler: createAssembler(),
        helloTimer: null,
        key: null,
        kind: null,
        peer: null,
        abort: null,
        pendingTimer: null,
      };
      current.conns.set(conn, record);
      record.helloTimer = setTimeout(() => {
        if (current.conns.get(conn) === record && record.state !== "open") dropConn(current, conn, true);
      }, helloMs);
      return;
    }
    if (type === CLOSE) {
      dropConn(current, conn, false);
      return;
    }
    if (type !== DATA) return;
    const record = current.conns.get(conn);
    if (!record) return;
    if (record.state === "hello") {
      // Anything unexpected past the guarded steps drops this channel; it must never become an unhandled rejection.
      void hello(current, conn, record, payload).catch(() => dropConn(current, conn, true));
      return;
    }
    if (record.state !== "open") return dropConn(current, conn, true);
    try {
      handleMessage(current, conn, record, record.channel.open(payload));
    } catch {
      dropConn(current, conn, true);
    }
  }

  return { onFrame, dropConn, dropKey, keysOf };
}

module.exports = { createPhoneChannels, frame, OPEN, DATA, CLOSE };
