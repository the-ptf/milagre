const nacl = require("tweetnacl");
const { randomBytes } = require("node:crypto");
const { b64url, fromB64url } = require("@milagre/shared/relay-crypto");
const { createPhoneChannels, frame, OPEN, CLOSE } = require("./phone-channels.cjs");
const { PEER_BUDGET } = require("./peer-channel.cjs");

const DEFAULT_TIMING = {
  pingMs: 20_000,
  idleMs: 45_000,
  helloMs: 15_000,
  pendingRepeatMs: 20_000,
  queueWaitMs: 20_000,
  backoff: [1000, 2000, 5000, 10_000, 30_000],
  serverErrorBackoff: [5000, 30_000, 60_000, 120_000, 300_000],
  replacedMs: 60_000,
  stableMs: 30_000,
  jitter: true,
};
const REPLACED = 4409;
const RELAY_BUSY = 4503;
const HOOK = 4,
  HOOK_SET = 5,
  HOOK_ACK = 6,
  HOOK_RESULT = 7;
const HOOK_RETRY_MS = [2000, 10_000, 30_000, 60_000, 300_000];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HOST_OFFLINE = encoder.encode("host-offline");
const EMPTY_SET = JSON.stringify({ hookIds: [] });
const RELAY_PEER_BUDGET = 96 * 1024 * 1024 + PEER_BUDGET;
const defaultRandom = (n) => new Uint8Array(randomBytes(n));

const ENVELOPES = ["OPEN", "DATA", "CLOSE", "HOOK", "HOOK_SET", "HOOK_ACK", "HOOK_RESULT"];
const MESSAGE_TYPES = new Set(["hello", "req", "res", "live-open", "live", "live-close", "ping", "pong", "peer"]);
const ANOMALIES = ["dataNoConn", "dataNotOpen", "dataUndecryptable", "duplicateOpen"];
const CLOSE_CODES = [1000, 1001, 1005, 1006, 1009, 1011, 4403, 4409, 4410];
const ROLES = ["phone", "retired", "hooks"];
const zeros = (names) => Object.fromEntries(names.map((name) => [name, 0]));
const envelopeOf = (bytes) => (bytes.length < 9 ? "short" : (ENVELOPES[bytes[0] - 1] ?? "other"));

function goneCode(data) {
  try {
    const message = JSON.parse(data.toString());
    return message?.t === "gone" && Number.isInteger(message.code) ? message.code : null;
  } catch {
    return null;
  }
}

function hookDeliveryOf(payload) {
  try {
    const at = payload.indexOf(10);
    if (at < 0) return null;
    const header = JSON.parse(decoder.decode(payload.subarray(0, at)));
    if (typeof header?.id !== "string" || typeof header.hookId !== "string") return null;
    return {
      id: header.id,
      hookId: header.hookId,
      receivedAt: Number(header.receivedAt) || Date.now(),
      headers: header.headers && typeof header.headers === "object" ? header.headers : {},
      query: header.query && typeof header.query === "object" ? header.query : {},
      body: new Uint8Array(payload.subarray(at + 1)),
    };
  } catch {
    return null;
  }
}

function retryDelay(code, current, { attempt, serverErrors }, { backoff, serverErrorBackoff, replacedMs, jitter }) {
  current.serverError ||= code === RELAY_BUSY;
  if (code === REPLACED && current.ready) return jitter ? replacedMs * (1 + Math.random() * 0.4) : replacedMs;
  const ladder = current.serverError ? serverErrorBackoff : backoff;
  const base = ladder[Math.min(current.serverError ? serverErrors : attempt, ladder.length - 1)];
  return jitter ? base * (0.8 + Math.random() * 0.4) : base;
}

function blankCounters() {
  const direction = (marks) => ({
    frames: 0,
    bytes: 0,
    envelopes: zeros([...ENVELOPES, "text", "short", "other"]),
    messages: zeros([...MESSAGE_TYPES, "unknown"]),
    ...(marks ? { marks: zeros(["pending", "error"]) } : {}),
  });
  return {
    in: direction(false),
    out: direction(true),
    anomalies: zeros(ANOMALIES),
    maxBufferedAmount: 0,
    sockets: Object.fromEntries(
      ROLES.map((role) => [role, { started: 0, stopped: 0, connects: 0, reconnects: 0, closes: zeros([...CLOSE_CODES.map(String), "idle", "other"]) }]),
    ),
  };
}

function createTransportDiagnostics({ now = Date.now } = {}) {
  let counters = blankCounters();
  let since = now();
  const active = zeros(ROLES);
  const count = {
    frame(direction, envelope, size) {
      const side = counters[direction];
      side.frames += 1;
      side.bytes += size;
      side.envelopes[envelope] += 1;
    },
    message(direction, type) {
      counters[direction].messages[typeof type === "string" && MESSAGE_TYPES.has(type) ? type : "unknown"] += 1;
    },
    mark(kind) {
      counters.out.marks[kind] += 1;
    },
    anomaly(name) {
      counters.anomalies[name] += 1;
    },
    buffered(amount) {
      if (amount > counters.maxBufferedAmount) counters.maxBufferedAmount = amount;
    },
  };
  return {
    attach(role) {
      let attached = true;
      active[role] += 1;
      counters.sockets[role].started += 1;
      return {
        frame: (direction, envelope, size) => attached && count.frame(direction, envelope, size),
        message: (direction, type) => attached && count.message(direction, type),
        mark: (kind) => attached && count.mark(kind),
        anomaly: (name) => attached && count.anomaly(name),
        buffered: (amount) => attached && count.buffered(amount),
        connect(reconnect) {
          if (!attached) return;
          const socket = counters.sockets[role];
          socket.connects += 1;
          if (reconnect) socket.reconnects += 1;
        },
        closed(code) {
          if (!attached) return;
          const closes = counters.sockets[role].closes;
          closes[code === undefined ? "idle" : CLOSE_CODES.includes(code) ? String(code) : "other"] += 1;
        },
        detach() {
          if (!attached) return;
          attached = false;
          active[role] -= 1;
          counters.sockets[role].stopped += 1;
        },
      };
    },
    read() {
      const at = now();
      return { enabled: true, since, uptimeMs: at - since, active: { ...active }, ...structuredClone(counters) };
    },
    reset() {
      counters = blankCounters();
      since = now();
    },
  };
}
const transportDiagnostics = process.env.MILAGRE_TRANSPORT_DIAGNOSTICS === "1" ? createTransportDiagnostics() : null;

function startRelayHost({
  relayUrl,
  identity,
  phones,
  token,
  bridgeUrl,
  canPair,
  retired = false,
  WebSocket = require("ws").WebSocket,
  fetch: fetchBridge = globalThis.fetch,
  random = defaultRandom,
  onStatus,
  timing,
  openPeer,
  allowComputer,
  hooks,
  hooksOnly = false,
  diagnostics = transportDiagnostics,
}) {
  const { pingMs, idleMs, helloMs, backoff, serverErrorBackoff, replacedMs, stableMs, jitter, pendingRepeatMs, queueWaitMs } = { ...DEFAULT_TIMING, ...timing };
  let probe = diagnostics ? diagnostics.attach(hooksOnly ? "hooks" : retired ? "retired" : "phone") : null;
  const channels = hooksOnly
    ? null
    : createPhoneChannels({
        identity,
        phones,
        token,
        bridgeUrl,
        canPair,
        retired,
        WebSocket,
        fetch: fetchBridge,
        random,
        helloMs,
        openPeer,
        allowComputer,
        pendingRepeatMs,
        queueWaitMs,
        diagnostics: probe,
      });
  let status = "connecting";
  let closed = false;
  let attempt = 0;
  let serverErrors = 0;
  let retryTimer = null;
  let session = null;
  let drainedOnce = false;
  let dialed = false;

  const setStatus = (next) => {
    if (status === next) return;
    status = next;
    try {
      onStatus?.(next);
    } catch {}
  };

  function sendRaw(current, bytes) {
    if (current.socket.readyState !== WebSocket.OPEN) return;
    current.socket.send(bytes);
    if (probe) {
      probe.frame("out", envelopeOf(bytes), bytes.length);
      probe.buffered(current.socket.bufferedAmount);
    }
  }

  function sendHookSet(current, force = false) {
    if (!hooks || !current.ready || current.over) return;
    let ids;
    let owners;
    try {
      ids = [...new Set(hooks.ids())].toSorted();
      const set = JSON.stringify({ hookIds: ids });
      if (!force && set === current.hookSet) return;
      current.hookSet = set;
      if (ids.length) drainedOnce = false;
      owners = ids.length ? hooks.owners(ids) : {};
    } catch {
      return;
    }
    const message = Object.keys(owners).length ? { hookIds: ids, owners } : { hookIds: ids };
    sendRaw(current, frame(HOOK_SET, 0n, encoder.encode(JSON.stringify(message))));
  }
  function hookResult(current, payload) {
    let result;
    try {
      result = JSON.parse(decoder.decode(payload));
    } catch {
      return;
    }
    const refused = Array.isArray(result?.refused) ? result.refused.filter((id) => typeof id === "string") : [];
    const failed = Array.isArray(result?.failed) ? result.failed.filter((id) => typeof id === "string") : [];
    clearTimeout(current.hookRetry);
    if (hooks.drained && !drainedOnce && result?.held === 0 && current.hookSet === EMPTY_SET && current.hookBatch.length === 0 && current.receiving === 0) {
      drainedOnce = true;
      try {
        hooks.drained();
      } catch {}
    }
    try {
      hooks.refused(refused);
    } catch {}
    if (refused.length === 0 && failed.length === 0) {
      current.hookAttempt = 0;
      return;
    }
    const delay = HOOK_RETRY_MS[Math.min(current.hookAttempt++, HOOK_RETRY_MS.length - 1)];
    current.hookRetry = setTimeout(() => sendHookSet(current, true), delay);
    current.hookRetry.unref?.();
  }
  function takeHook(current, payload) {
    const delivery = hookDeliveryOf(payload);
    if (!delivery) return;
    current.hookBatch.push(delivery);
    if (current.hookBatch.length > 1) return;
    setImmediate(async () => {
      const batch = current.hookBatch.splice(0);
      current.receiving += 1;
      try {
        await hooks.receive(batch);
      } catch {
        return;
      } finally {
        current.receiving -= 1;
      }
      for (const item of batch) sendRaw(current, frame(HOOK_ACK, 0n, encoder.encode(item.id)));
      if (hooks.drained) sendHookSet(current, true);
    });
  }
  function hookFrame(current, data) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.length < 9 || new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(1) !== 0n) return false;
    if (bytes[0] === HOOK) takeHook(current, bytes.subarray(9));
    else if (bytes[0] === HOOK_RESULT) hookResult(current, bytes.subarray(9));
    else return false;
    return true;
  }
  function hooksOnlyFrame(current, data) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.length < 9 || bytes[0] !== OPEN) return;
    sendRaw(current, frame(CLOSE, new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(1), HOST_OFFLINE));
  }

  function connect() {
    if (closed) return;
    setStatus("connecting");
    probe?.connect(dialed);
    dialed = true;
    const ws = new WebSocket(`${relayUrl}/v1/host?id=${identity.hostId}`, { handshakeTimeout: idleMs });
    const current = {
      socket: ws,
      conns: new Map(),
      ready: false,
      lastHeard: Date.now(),
      timer: null,
      readyTimer: null,
      stableTimer: null,
      over: false,
      hookSet: null,
      receiving: 0,
      hookBatch: [],
      hookRetry: null,
      hookAttempt: 0,
      serverError: false,
    };
    current.send = (bytes) => sendRaw(current, bytes);
    current.queued = () => current.socket.bufferedAmount;
    current.peerBudget = RELAY_PEER_BUDGET;
    session = current;

    const finish = (code) => {
      if (current.over) return;
      current.over = true;
      probe?.closed(code);
      clearInterval(current.timer);
      clearTimeout(current.readyTimer);
      clearTimeout(current.stableTimer);
      clearTimeout(current.hookRetry);
      if (channels) for (const conn of Array.from(current.conns.keys())) channels.dropConn(current, conn, false);
      if (session === current) session = null;
      if (closed) {
        setStatus("offline");
        return;
      }
      setStatus("offline");
      const delay = retryDelay(code, current, { attempt, serverErrors }, { backoff, serverErrorBackoff, replacedMs, jitter });
      serverErrors = current.serverError ? serverErrors + 1 : 0;
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    ws.on("message", (data, isBinary) => {
      try {
        current.lastHeard = Date.now();
        if (probe) probe.frame("in", isBinary ? envelopeOf(data) : "text", data.length);
        const gone = isBinary ? null : goneCode(data);
        if (gone !== null) {
          ws.close(1000);
          return finish(gone);
        }
        if (current.ready) {
          if (!isBinary) return;
          if (hooks && hookFrame(current, data)) return;
          if (channels) channels.onFrame(current, data);
          else hooksOnlyFrame(current, data);
          return;
        }
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message?.t === "challenge") {
          const nonce = fromB64url(String(message.nonce));
          if (nonce.length !== 32) throw new Error("Bad challenge");
          const proof = JSON.stringify({ t: "proof", key: b64url(identity.sign.publicKey), sig: b64url(nacl.sign.detached(nonce, identity.sign.secretKey)) });
          ws.send(proof);
          if (probe) probe.frame("out", "text", Buffer.byteLength(proof));
        } else if (message?.t === "ready") {
          current.ready = true;
          clearTimeout(current.readyTimer);
          current.stableTimer = setTimeout(() => {
            attempt = 0;
          }, stableMs);
          setStatus("online");
          sendHookSet(current);
        }
      } catch {
        ws.terminate();
      }
    });
    ws.on("pong", () => {
      current.lastHeard = Date.now();
    });
    ws.on("close", (code) => finish(code));
    ws.on("error", () => {});
    ws.on("unexpected-response", (_request, response) => {
      current.serverError = response.statusCode >= 500;
      ws.terminate();
    });
    ws.on("open", () => {
      current.lastHeard = Date.now();
      current.readyTimer = setTimeout(() => {
        if (!current.ready) ws.terminate();
      }, idleMs);
      current.timer = setInterval(() => {
        if (Date.now() - current.lastHeard > idleMs) {
          ws.terminate();
          finish();
          return;
        }
        try {
          ws.ping();
        } catch {}
      }, pingMs);
    });
  }

  function stopProbe() {
    probe?.detach();
    probe = null;
  }

  connect();

  return {
    status: () => status,
    connectedKeys: () => (session && channels ? channels.keysOf(session) : []),
    drop(key) {
      if (session && channels) channels.dropKey(session, key);
    },
    syncHooks() {
      if (session) sendHookSet(session);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      const current = session;
      if (!current) {
        stopProbe();
        setStatus("offline");
        return;
      }
      const ended = new Promise((resolve) => current.socket.once("close", resolve));
      if (channels) for (const conn of Array.from(current.conns.keys())) channels.dropConn(current, conn, false);
      if (current.socket.readyState === WebSocket.CONNECTING) current.socket.terminate();
      else current.socket.close(1000);
      const timer = setTimeout(() => current.socket.terminate(), 2000);
      await ended;
      clearTimeout(timer);
      stopProbe();
    },
  };
}

module.exports = { startRelayHost, createTransportDiagnostics, transportDiagnostics };
