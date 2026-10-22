const nacl = require("tweetnacl");
const { randomBytes } = require("node:crypto");
const { b64url, fromB64url } = require("@milagre/shared/relay-crypto");
const { createPhoneChannels, frame, OPEN, CLOSE } = require("./phone-channels.cjs");
const { PEER_BUDGET } = require("./peer-channel.cjs");

// helloMs: a phone connection that has not finished its hello by then is closed, so idle sockets cannot fill the room.
// replacedMs: the wait after the relay closes a ready session as replaced (4409): another Mac holds the same identity
// (say, after Migration Assistant), and redialing on the short backoff would have the two knock each other off every second.
// stableMs: how long a session must stay up before the backoff starts over, so a relay that drops us right after
// ready still backs off.
const DEFAULT_TIMING = {
  pingMs: 20_000,
  idleMs: 45_000,
  helloMs: 15_000,
  pendingRepeatMs: 20_000,
  backoff: [1000, 2000, 5000, 10_000, 30_000],
  replacedMs: 60_000,
  stableMs: 30_000,
  jitter: true,
};
const REPLACED = 4409;
// Webhook frames on conn 0 (apps/relay/src/room.mjs): HOOK brings a delivery, HOOK_SET says which hooks this Mac wants,
// HOOK_ACK says a delivery is on disk, HOOK_RESULT answers a set with the hooks another room still holds.
const HOOK = 4,
  HOOK_SET = 5,
  HOOK_ACK = 6,
  HOOK_RESULT = 7;
// After a set the relay couldn't fully apply, the set goes again, slower each time.
const HOOK_RETRY_MS = [2000, 10_000, 30_000, 60_000, 300_000];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HOST_OFFLINE = encoder.encode("host-offline");
const EMPTY_SET = JSON.stringify({ hookIds: [] });
// Headroom for one full phone response (lan-host.cjs MAX_BUFFERED) plus a desktop's own budget.
const RELAY_PEER_BUDGET = 64 * 1024 * 1024 + PEER_BUDGET;
const defaultRandom = (n) => new Uint8Array(randomBytes(n));

/**
 * Keeps the Mac connected to the public relay and serves each phone that comes through it:
 * an encrypted channel per phone, with requests and live sockets forwarded to the loopback bridge.
 * `retired`: the identity is one Reset replaced. It holds the old room only to turn every phone away with
 * `{ code: 'bad-token', reason: 'reset' }`; it needs only `identity.hostId` and `identity.sign`. Apps that predate
 * `reason` still read it as an older code and say to scan again.
 */
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
}) {
  const { pingMs, idleMs, helloMs, backoff, replacedMs, stableMs, jitter, pendingRepeatMs } = { ...DEFAULT_TIMING, ...timing };
  // `hooksOnly`: no phone is served (phone access is off), the socket is kept for webhooks alone.
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
      });
  let status = "connecting";
  let closed = false;
  let attempt = 0;
  let retryTimer = null;
  let session = null; // the live relay socket and its phone connections
  let drainedOnce = false;

  const setStatus = (next) => {
    if (status === next) return;
    status = next;
    try {
      onStatus?.(next);
    } catch {
      /* a listener must not break the host */
    }
  };

  function sendRaw(current, bytes) {
    if (current.socket.readyState === WebSocket.OPEN) current.socket.send(bytes);
  }

  /**
   * Webhooks (`hooks`: { ids(), receive(deliveries), refused(ids), owners(ids) }). The relay holds deliveries for the ids
   * in the last HOOK_SET, sent after every ready and whenever they change, each with its owner key (made with the hook,
   * never in its URL): the relay keeps the key's hash, and the key moves a hook another room holds (this Mac's own room
   * before a Reset) to this one. A hook refused even so shows on its Routine and is asked for again, slower each time.
   * Deliveries arriving together are handed over as one batch and acknowledged only once `receive` has them on disk; a
   * throw leaves them at the relay for the next ready. Nothing here logs ids, keys, secrets or payloads.
   */
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
    // A room a Reset retired, draining (`hooks.drained`): it registers nothing, and once it holds nothing more and every
    // delivery it sent is acked, it is done. Relays from before `held` never say so; the Mac gives up on them in time.
    if (hooks.drained && !drainedOnce && result?.held === 0 && current.hookSet === EMPTY_SET && current.hookBatch.length === 0 && current.receiving === 0) {
      drainedOnce = true;
      try {
        hooks.drained();
      } catch {
        /* a listener must not break the host */
      }
    }
    // Refused although the set carried the owner key: say so on their Routines (a failed claim is only retried).
    try {
      hooks.refused(refused);
    } catch {
      /* a listener must not break the host */
    }
    if (refused.length === 0 && failed.length === 0) {
      current.hookAttempt = 0;
      return;
    }
    const delay = HOOK_RETRY_MS[Math.min(current.hookAttempt++, HOOK_RETRY_MS.length - 1)];
    current.hookRetry = setTimeout(() => sendHookSet(current, true), delay);
    current.hookRetry.unref?.();
  }
  function takeHook(current, payload) {
    let delivery;
    try {
      const at = payload.indexOf(10);
      if (at < 0) return;
      const header = JSON.parse(decoder.decode(payload.subarray(0, at)));
      if (typeof header?.id !== "string" || typeof header.hookId !== "string") return;
      delivery = {
        id: header.id,
        hookId: header.hookId,
        receivedAt: Number(header.receivedAt) || Date.now(),
        headers: header.headers && typeof header.headers === "object" ? header.headers : {},
        query: header.query && typeof header.query === "object" ? header.query : {},
        body: new Uint8Array(payload.subarray(at + 1)),
      };
    } catch {
      return;
    }
    current.hookBatch.push(delivery);
    if (current.hookBatch.length > 1) return;
    setImmediate(async () => {
      const batch = current.hookBatch.splice(0);
      current.receiving += 1;
      try {
        await hooks.receive(batch);
      } catch {
        return; // not acknowledged: the relay keeps them and sends them again after the next ready
      } finally {
        current.receiving -= 1;
      }
      for (const item of batch) sendRaw(current, frame(HOOK_ACK, 0n, encoder.encode(item.id)));
      // Draining: ask again, so the room's answer says what it still holds after these acks.
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
  // Phone access off: a phone that dials this room is closed at once with "host-offline", the answer it gets when no Mac
  // is connected (relays from before that word close it as closed-by-host).
  function hooksOnlyFrame(current, data) {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.length < 9 || bytes[0] !== OPEN) return;
    sendRaw(current, frame(CLOSE, new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(1), HOST_OFFLINE));
  }

  function connect() {
    if (closed) return;
    setStatus("connecting");
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
    };
    current.send = (bytes) => sendRaw(current, bytes);
    // Every channel shares this socket, so its buffer holds whatever phones have in flight too: a single phone response
    // (MAX_RESPONSE, about 43 MiB on the wire) can sit there while a healthy desktop is connected. A desktop's budget
    // therefore starts above that. A desktop that stalls on the relay never shows here at all (the relay forwards to each
    // peer on its own), so catching that one is the relay's job; this only bounds what the Mac itself can pile up.
    current.queued = () => current.socket.bufferedAmount;
    current.peerBudget = RELAY_PEER_BUDGET;
    session = current;

    const finish = (code) => {
      if (current.over) return;
      current.over = true;
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
      let delay;
      // Only a proven host being replaced means a twin Mac: replacing a pending socket takes no key, so anyone
      // who knows the hostId could otherwise keep this Mac offline for a minute at a time.
      if (code === REPLACED && current.ready) {
        // The usual 40% jitter spread, laid above replacedMs so the wait is never shorter than it.
        delay = jitter ? replacedMs * (1 + Math.random() * 0.4) : replacedMs;
      } else {
        const base = backoff[Math.min(attempt, backoff.length - 1)];
        delay = jitter ? base * (0.8 + Math.random() * 0.4) : base;
      }
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    ws.on("message", (data, isBinary) => {
      // ws does not catch listener errors, and nothing a relay sends may take the daemon down.
      try {
        current.lastHeard = Date.now();
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
          ws.send(JSON.stringify({ t: "proof", key: b64url(identity.sign.publicKey), sig: b64url(nacl.sign.detached(nonce, identity.sign.secretKey)) }));
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
    ws.on("error", () => {
      /* close follows */
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
        } catch {
          /* closing */
        }
      }, pingMs);
    });
  }

  connect();

  return {
    status: () => status,
    /** Keys of the devices with a channel open through the relay now. */
    connectedKeys: () => (session && channels ? channels.keysOf(session) : []),
    /** Closes every channel the device with `key` has open through the relay. */
    drop(key) {
      if (session && channels) channels.dropKey(session, key);
    },
    /** Tells the relay the current hook set if it changed (a Routine made, deleted, paused or rotated). */
    syncHooks() {
      if (session) sendHookSet(session);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(retryTimer);
      const current = session;
      if (!current) {
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
    },
  };
}

module.exports = { startRelayHost };
