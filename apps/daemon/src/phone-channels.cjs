const { hostAccept, RelayAuthError } = require("@milagre/shared/relay-crypto");
const { splitBody, createAssembler, MAX_RESPONSE } = require("@milagre/shared/relay-rpc");
const { openPeerChannel } = require("./peer-channel.cjs");

const OPEN = 1,
  DATA = 2,
  CLOSE = 3;
const ERROR_MARK = 0x04;
const PENDING_MARK = 0x05;
const PENDING_REPEAT_MS = 20_000;
const LIVE_ORIGIN = "milagre-app://phone";
const MAX_LIVE = 8;
const MAX_INFLIGHT = 16;
const MAX_QUEUED = 64;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
const MAX_QUEUE_WAIT = 20_000;
const MAX_UPLOAD = 8 * 1024 * 1024;
const REQUEST_TIMEOUT = 340_000;
const BLOCKED_HEADERS = new Set(["host", "origin", "authorization", "connection", "content-length", "transfer-encoding", "upgrade", "cookie"]);
const FORWARDED_HEADERS = ["content-type", "etag"];
const encoder = new TextEncoder();
const BATCH_CAP = "batch";
const BATCH_MS = 50;
const BATCH_BYTES = 512 * 1024;
const BATCH_HEAD = encoder.encode('{"t":"batch","items":[');
const BATCH_TAIL = encoder.encode("]}");
const COMMA = encoder.encode(",");

function joinBatch(items) {
  let size = BATCH_HEAD.length + BATCH_TAIL.length + COMMA.length * (items.length - 1);
  for (const item of items) size += item.length;
  const out = new Uint8Array(size);
  let at = 0;
  const put = (bytes) => {
    out.set(bytes, at);
    at += bytes.length;
  };
  put(BATCH_HEAD);
  items.forEach((item, index) => {
    if (index) put(COMMA);
    put(item);
  });
  put(BATCH_TAIL);
  return out;
}
const PENDING_NOTICE = new Uint8Array([PENDING_MARK, ...encoder.encode('{"t":"pending"}')]);
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
  batchMs = BATCH_MS,
  diagnostics = null,
}) {
  const sendFrame = (current, type, conn, payload) => current.send(frame(type, conn, payload));
  function sendMessage(current, conn, record, message) {
    const urgent = (message.t === "res" && message.more === false) || message.t === "live-close";
    diagnostics?.message("out", message.t);
    sendEncoded(current, conn, record, encoder.encode(JSON.stringify(message)), urgent);
  }
  function sendEncoded(current, conn, record, encoded, urgent = false) {
    if (current.conns.get(conn) !== record || !record.channel) return;
    if (!record.batch) return sendFrame(current, DATA, conn, record.channel.sealEncoded(encoded));
    if (record.batched.length && record.batchedBytes + encoded.length > BATCH_BYTES) flushBatch(current, conn, record);
    record.batched.push(encoded);
    record.batchedBytes += encoded.length;
    if (urgent || record.batchedBytes >= BATCH_BYTES) return flushBatch(current, conn, record);
    record.batchTimer ??= setTimeout(() => flushBatch(current, conn, record), batchMs);
  }
  function flushBatch(current, conn, record) {
    clearTimeout(record.batchTimer);
    record.batchTimer = null;
    const items = record.batched.splice(0);
    record.batchedBytes = 0;
    if (!items.length || current.conns.get(conn) !== record || !record.channel) return;
    sendFrame(current, DATA, conn, record.channel.sealEncoded(items.length === 1 ? items[0] : joinBatch(items)));
  }

  function closeLives(record) {
    for (const live of record.lives.values()) {
      try {
        live.close(1001);
      } catch {}
    }
    record.lives.clear();
  }
  function release(record) {
    clearTimeout(record.helloTimer);
    clearTimeout(record.batchTimer);
    record.batched.length = 0;
    record.abort?.abort();
    clearInterval(record.pendingTimer);
    closeLives(record);
    record.peer?.close();
    for (const queued of record.queue.splice(0)) clearTimeout(queued.expiry);
    record.queuedBytes = 0;
  }
  function dropConn(current, conn, notify) {
    const record = current.conns.get(conn);
    if (!record) return;
    current.conns.delete(conn);
    release(record);
    if (notify) sendFrame(current, CLOSE, conn);
  }
  function dropOwn(current, conn, record, notify) {
    if (current.conns.get(conn) === record) dropConn(current, conn, notify);
  }

  function refuse(current, conn, code, extra) {
    diagnostics?.mark("error");
    sendFrame(current, DATA, conn, new Uint8Array([ERROR_MARK, ...encoder.encode(JSON.stringify({ t: "error", code, ...extra }))]));
    dropConn(current, conn, true);
  }

  async function waitForAllow(current, conn, record, accepted) {
    if (!allowComputer) return "expired";
    record.state = "pending";
    clearTimeout(record.helloTimer);
    const abort = new AbortController();
    record.abort = abort;
    const notice = () => {
      if (current.conns.get(conn) !== record) return;
      diagnostics?.mark("pending");
      sendFrame(current, DATA, conn, PENDING_NOTICE);
    };
    try {
      return await allowComputer({
        key: accepted.phoneKey,
        name: accepted.name,
        signal: abort.signal,
        waiting() {
          if (record.pendingTimer || record.abort !== abort || abort.signal.aborted) return;
          notice();
          record.pendingTimer = setInterval(notice, pendingRepeatMs);
        },
      });
    } catch {
      abort.abort();
      return "dropped";
    } finally {
      if (record.abort === abort) {
        clearInterval(record.pendingTimer);
        record.pendingTimer = null;
        record.abort = null;
      }
    }
  }

  async function hello(current, conn, record, bytes) {
    record.state = "accepting";
    if (retired) return refuse(current, conn, "bad-token", { reason: "reset" });
    let accepted;
    try {
      accepted = hostAccept({ host: identity.box, hello: bytes, isKnown: (id) => phones.isKnown(id), canPair: (id) => !!canPair(id), token, random });
    } catch (error) {
      if (error instanceof RelayAuthError) return refuse(current, conn, error.code);
      return refuse(current, conn, "bad-hello");
    }
    const kind = accepted.kind === "desktop" ? "computer" : "phone";
    if (kind === "computer" && !openPeer) return refuse(current, conn, "bad-hello", { reason: "kind" });
    const stored = accepted.firstPairing ? null : phones.kindOf(accepted.phoneKey);
    if (stored && stored !== kind) return refuse(current, conn, "bad-hello", { reason: "kind" });
    record.key = accepted.phoneKey;
    if (accepted.firstPairing && kind === "computer") {
      const verdict = await waitForAllow(current, conn, record, accepted);
      if (current.conns.get(conn) !== record) return;
      if (verdict !== "allowed") return refuse(current, conn, "unknown-phone", NOT_ALLOWED[verdict]);
    }
    if (accepted.firstPairing) {
      try {
        await phones.add(accepted.phoneKey, { kind, name: accepted.name });
      } catch {
        return dropOwn(current, conn, record, true);
      }
    } else {
      void Promise.resolve(phones.seen?.(accepted.phoneKey, { name: accepted.name })).catch(() => {});
    }
    if (current.conns.get(conn) !== record) return;
    record.channel = accepted.channel;
    record.state = "open";
    clearTimeout(record.helloTimer);
    record.kind = kind;
    record.batch = accepted.caps.includes(BATCH_CAP);
    diagnostics?.message("out", "hello");
    sendFrame(current, DATA, conn, accepted.reply);
    if (kind === "computer") {
      try {
        record.peer = openPeerChannel({
          openPeer,
          deliver: (encoded) => {
            diagnostics?.message("out", "peer");
            sendEncoded(current, conn, record, encoded);
          },
          queued: () => current.queued?.(conn) ?? 0,
          budget: current.peerBudget,
          isOpen: () => current.conns.get(conn) === record,
          drop: () => dropOwn(current, conn, record, true),
        });
      } catch {
        return dropOwn(current, conn, record, true);
      }
      if (current.conns.get(conn) !== record) record.peer.close();
    }
  }

  function keysOf(current) {
    const keys = new Set();
    for (const record of current.conns.values()) if (record.state === "open" && record.key) keys.add(record.key);
    return [...keys];
  }

  function dropKey(current, key) {
    for (const [conn, record] of Array.from(current.conns)) if (record.key === key) dropConn(current, conn, true);
  }

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
    live.on("error", () => ended(1011));
  }

  function handleMessage(current, conn, record, message) {
    if (!message || typeof message !== "object") throw new Error("Not a message");
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
      const superseded = current.conns.get(conn);
      if (superseded) {
        diagnostics?.anomaly("duplicateOpen");
        current.conns.delete(conn);
        release(superseded);
      }
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
        batch: false,
        batched: [],
        batchedBytes: 0,
        batchTimer: null,
      };
      current.conns.set(conn, record);
      record.helloTimer = setTimeout(() => {
        if (record.state !== "open") dropOwn(current, conn, record, true);
      }, helloMs);
      return;
    }
    if (type === CLOSE) {
      dropConn(current, conn, false);
      return;
    }
    if (type !== DATA) return;
    const record = current.conns.get(conn);
    if (!record) return void diagnostics?.anomaly("dataNoConn");
    if (record.state === "hello") {
      diagnostics?.message("in", "hello");
      void hello(current, conn, record, payload).catch(() => dropOwn(current, conn, record, true));
      return;
    }
    if (record.state !== "open") {
      diagnostics?.anomaly("dataNotOpen");
      return dropConn(current, conn, true);
    }
    let message;
    try {
      message = record.channel.open(payload);
    } catch {
      diagnostics?.anomaly("dataUndecryptable");
      return dropConn(current, conn, true);
    }
    diagnostics?.message("in", record.kind === "computer" ? "peer" : message?.t);
    try {
      handleMessage(current, conn, record, message);
    } catch {
      dropConn(current, conn, true);
    }
  }

  return { onFrame, dropConn, dropKey, keysOf };
}

module.exports = { createPhoneChannels, frame, OPEN, DATA, CLOSE };
