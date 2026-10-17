import nacl from "tweetnacl";
import { hostIdOf, b64url, fromB64url } from "@milagre/shared/relay-crypto";

const MAX_FRAME = 1024 * 1024;
export const MAX_PHONES = 16;
const OPEN = 1,
  DATA = 2,
  CLOSE = 3;
// Webhook frames, all on conn 0 (phones start at 1): HOOK carries a stored delivery to the Mac, HOOK_SET the Mac's full
// set of hook ids, HOOK_ACK the id of a delivery the Mac has persisted, HOOK_RESULT (room to Mac) the ids of the last
// set that another room still holds. Older daemons drop anything that is not DATA.
export const HOOK = 4,
  HOOK_SET = 5,
  HOOK_ACK = 6,
  HOOK_RESULT = 7;

const HOST_OFFLINE = new TextEncoder().encode("host-offline");

export function frame(type, conn, payload = new Uint8Array()) {
  const out = new Uint8Array(9 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setBigUint64(1, conn);
  out.set(payload, 9);
  return out;
}
export function unframe(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return { type: view[0], conn: new DataView(view.buffer, view.byteOffset).getBigUint64(1), payload: view.slice(9) };
}

const TOO_BIG = Symbol("too-big");
// Brand check that works across realms (`instanceof ArrayBuffer` does not) and cannot be faked by a toStringTag.
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
function isArrayBuffer(data) {
  try {
    bufferLength.call(data);
    return true;
  } catch {
    return false;
  }
}
/** Binary payloads only, never copied: null for text and anything that is not an ArrayBuffer or a view, TOO_BIG past `max` bytes. */
function toBytes(data, max) {
  let bytes;
  if (isArrayBuffer(data)) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else return null;
  return bytes.byteLength > max ? TOO_BIG : bytes;
}

/**
 * One Mac and its phones. Knows nothing about what the frames say.
 *
 * Restorable: the Durable Object can be evicted while every socket stays open, so the room
 * tells `mark(socket, state)` about each socket's role whenever it changes, and a fresh room
 * rebuilds itself from those marks with `restore`. A socket the room closes or forgets is marked
 * null, because a closing socket can still be listed for a while and must not come back as live.
 *   { role: 'pending', challenge: '<b64url nonce>' }  a Mac still proving its key
 *   { role: 'host', next: '<decimal>' }                 the proven Mac and the last conn handed out
 *   { role: 'phone', conn: '<decimal>' }                a phone and its connection number
 */
export function createRoom({ id, nonce = () => crypto.getRandomValues(new Uint8Array(32)), mark = () => {}, onHostReady, onHostFrame }) {
  let host = null,
    pending = null,
    challenge = null,
    next = 0n; // host: the proven Mac; pending: a newcomer still proving its key
  const phones = new Map(); // conn -> socket
  const connOf = new Map(); // socket -> conn
  // A mark that fails (a socket already gone) only costs that socket its restore.
  const note = (socket, state) => {
    try {
      mark(socket, state);
    } catch {
      /* socket already gone */
    }
  };
  const noteHost = () => note(host, { role: "host", next: next.toString() });
  const drop = (socket, code, reason) => {
    note(socket, null);
    try {
      socket.close(code, reason);
    } catch {
      /* already closed */
    }
  };
  const proves = (data) => {
    try {
      if ((typeof data === "string" ? data.length : data.byteLength) > 4096) return false;
      const proof = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data));
      const key = proof?.t === "proof" ? fromB64url(String(proof.key)) : null;
      return !!key && key.length === 32 && hostIdOf(key) === id && nacl.sign.detached.verify(challenge, fromB64url(String(proof.sig)), key);
    } catch {
      return false; /* malformed proof */
    }
  };
  const dropPhones = () => {
    for (const phone of phones.values()) drop(phone, 4410, "host-gone");
    phones.clear();
    connOf.clear();
  };
  // A send throws once a socket is closing. Every send is guarded, and a failed one counts as that socket closing.
  const sent = (socket, data) => {
    try {
      socket.send(data);
      return true;
    } catch {
      return false;
    }
  };
  const hostGone = () => {
    const old = host;
    host = null;
    dropPhones();
    if (old) drop(old, 1011, "send-failed");
  };
  const toHost = (data) => {
    if (host && !sent(host, data)) hostGone();
  };
  const phoneRefusal = () => {
    if (!host) return { code: 4404, reason: "host-offline" };
    if (phones.size >= MAX_PHONES) return { code: 4429, reason: "too-many-phones" };
    return null;
  };
  const forgetPhone = (conn, socket) => {
    phones.delete(conn);
    connOf.delete(socket);
    note(socket, null);
  };
  return {
    /** A new Mac socket waits as pending: the current host and its phones are untouched until the proof verifies. */
    hostOpened(socket) {
      if (pending) drop(pending, 4409, "replaced");
      pending = socket;
      challenge = nonce();
      note(socket, { role: "pending", challenge: b64url(challenge) });
      if (!sent(socket, JSON.stringify({ t: "challenge", nonce: b64url(challenge) }))) {
        pending = null;
        drop(socket, 1011, "send-failed");
      }
    },
    hostMessage(socket, data) {
      if (socket === pending) {
        if (!proves(data)) {
          pending = null;
          return drop(socket, 4403, "bad-proof");
        }
        if (host) drop(host, 4409, "replaced");
        dropPhones();
        host = socket;
        pending = null;
        noteHost();
        toHost(JSON.stringify({ t: "ready" }));
        if (host === socket) onHostReady?.();
        return;
      }
      if (socket !== host) return drop(socket, 4409, "replaced");
      const bytes = toBytes(data, MAX_FRAME + 9);
      if (bytes === TOO_BIG) return drop(socket, 1009, "too-big");
      if (!bytes || bytes.byteLength < 9) return drop(socket, 1003, "bad-frame");
      const { type, conn, payload } = unframe(bytes);
      if (conn === 0n) return type === HOOK_SET || type === HOOK_ACK ? onHostFrame?.(type, payload) : undefined;
      const phone = phones.get(conn);
      if (!phone) return;
      if (type === DATA) {
        if (sent(phone, payload)) return;
        forgetPhone(conn, phone);
        drop(phone, 1011, "send-failed");
        toHost(frame(CLOSE, conn));
      } else if (type === CLOSE) {
        forgetPhone(conn, phone);
        // A Mac whose phone access is off (it is connected for webhooks alone) says so, and the phone hears what it would
        // with no Mac here at all, so it waits instead of dialing again at once.
        if (payload.byteLength === HOST_OFFLINE.byteLength && payload.every((byte, index) => byte === HOST_OFFLINE[index])) drop(phone, 4404, "host-offline");
        else drop(phone, 1000, "closed-by-host");
      }
    },
    hostClosed(socket) {
      if (socket === pending) {
        pending = null;
        note(socket, null);
        return;
      }
      if (socket !== host) return;
      host = null;
      note(socket, null);
      dropPhones();
    },
    /** Why a new phone would be turned away right now, or null. Changes nothing. */
    phoneRefusal,
    /** Sends a whole frame to the proven Mac; false when there is none or the send failed. */
    sendHost(bytes) {
      if (!host) return false;
      toHost(bytes);
      return host !== null;
    },
    phoneOpened(socket) {
      const refusal = phoneRefusal();
      if (refusal) {
        drop(socket, refusal.code, refusal.reason);
        return null;
      }
      const conn = ++next;
      // The phone takes a slot only once the Mac has heard about it.
      if (!sent(host, frame(OPEN, conn))) {
        hostGone();
        drop(socket, 4404, "host-offline");
        return null;
      }
      phones.set(conn, socket);
      connOf.set(socket, conn);
      note(socket, { role: "phone", conn: conn.toString() });
      noteHost();
      return conn;
    },
    phoneMessage(socket, data) {
      const conn = connOf.get(socket);
      if (conn === undefined || !host) return;
      const bytes = toBytes(data, MAX_FRAME);
      if (bytes === TOO_BIG) return drop(socket, 1009, "too-big");
      if (!bytes) return drop(socket, 1003, "binary-only");
      toHost(frame(DATA, conn, bytes));
    },
    phoneClosed(socket) {
      const conn = connOf.get(socket);
      if (conn === undefined) return;
      forgetPhone(conn, socket);
      toHost(frame(CLOSE, conn));
    },
    /**
     * Rebuilds a fresh room from the sockets that outlived it and their last marks, in the order
     * the runtime lists them. The last host and the last pending socket win; the others were
     * already replaced. A socket with no usable mark is closed, since the room cannot route it.
     */
    restore(entries) {
      const hosts = [],
        pendings = [],
        restored = [];
      for (const { socket, state } of entries) {
        const role = state?.role;
        if (role === "host" && decimal(state.next) !== null) hosts.push({ socket, next: decimal(state.next) });
        else if (role === "pending" && nonceOf(state.challenge)) pendings.push({ socket, challenge: nonceOf(state.challenge) });
        else if (role === "phone" && decimal(state.conn)) restored.push({ socket, conn: decimal(state.conn) });
        else drop(socket, 1011, "lost-state");
      }
      const kept = hosts.pop(),
        waiting = pendings.pop();
      for (const { socket } of [...hosts, ...pendings]) drop(socket, 4409, "replaced");
      if (waiting) {
        pending = waiting.socket;
        challenge = waiting.challenge;
      }
      if (!kept) {
        for (const { socket } of restored) drop(socket, 4410, "host-gone");
        return;
      }
      host = kept.socket;
      next = kept.next;
      for (const { socket, conn } of restored) {
        const twin = phones.get(conn);
        if (twin) {
          connOf.delete(twin);
          drop(twin, 1011, "lost-state");
        } // two phones on one conn: the later mark wins
        phones.set(conn, socket);
        connOf.set(socket, conn);
        if (conn > next) next = conn;
      }
      if (next !== kept.next) noteHost();
    },
  };
}

/** A u64 counter written as a decimal string in a mark, or null. */
function decimal(text) {
  if (typeof text !== "string" || !/^\d{1,20}$/.test(text)) return null;
  const value = BigInt(text);
  return value <= 0xffffffffffffffffn ? value : null;
}
/** A 32-byte challenge from a mark, or null. */
function nonceOf(text) {
  try {
    const bytes = typeof text === "string" ? fromB64url(text) : null;
    return bytes?.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}
