import { b64url } from "@milagre/shared/relay-crypto";
import { frame, HOOK, HOOK_SET, HOOK_ACK } from "./room.mjs";

/**
 * Webhooks through the relay, runtime-neutral so the Worker and the daemon's local test relay share it.
 *
 * `POST /hook/<secret>`: the secret is 32 random bytes in base64url and its hex sha256 is the hook id. The Worker
 * hashes the secret, asks the hook's directory entry which room owns it, and hands the delivery to that room, which
 * accepts it only for a hook the Mac registered there (HOOK_SET). The room stores the delivery before it answers 202,
 * forwards it to the Mac when the Mac is connected, and deletes it on HOOK_ACK or after 24 h.
 *
 * Nothing here logs: secrets, URLs and payloads never reach a log line.
 */

export const MAX_HOOK_BODY = 256 * 1024;
export const MAX_HOOK_HEADERS = 16 * 1024;
export const MAX_STORED = 200;
export const MAX_STORED_BYTES = 20 * 1024 * 1024;
// One noisy hook can fill at most a quarter of the room, so the others always have space left.
export const MAX_STORED_PER_HOOK = 50;
export const MAX_STORED_BYTES_PER_HOOK = 5 * 1024 * 1024;
export const HOLD_MS = 24 * 60 * 60 * 1000;
export const MAX_HOOKS = 100;
/** The one answer for every hook nobody can deliver to: unknown, malformed, released or owned by another room. */
export const NOT_FOUND = Object.freeze({ status: 404, json: Object.freeze({ error: "not found" }) });
export const NOT_FOUND_BODY = JSON.stringify(NOT_FOUND.json);
const FULL = Object.freeze({ status: 429, json: Object.freeze({ error: "too many deliveries waiting" }) });
const TOO_LARGE = Object.freeze({ status: 413, json: Object.freeze({ error: "payload too large" }) });

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const HOOK_ID = /^[0-9a-f]{64}$/;
// Headers that belong to the relay or the network, or that a sender should not hand an agent.
const SKIPPED_HEADERS = /^(cf-|x-forwarded-|x-real-ip$|x-milagre-|cookie$|authorization$|host$|content-length$|connection$|transfer-encoding$)/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const defaultRandomId = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

/** The secret in a `/hook/<secret>` path, or null when the path or the secret's shape is wrong. */
export function hookSecretOf(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/hook/")) return null;
  const secret = pathname.slice("/hook/".length);
  return SECRET.test(secret) ? secret : null;
}

/** The hook id for a secret: its hex sha256. Hashing every candidate is the only way a secret is ever compared. */
export async function hookIdOf(secret) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(secret))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A request's body as bytes, or null past `max` (256 KiB), whatever its Content-Length says. */
export async function readHookBody(request, max = MAX_HOOK_BODY) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The sender's headers worth passing on: lowercased, the relay's and network's own left out, 16 KiB at most. */
export function pickHookHeaders(entries, max = MAX_HOOK_HEADERS) {
  const out = {};
  let size = 0;
  for (const [rawName, value] of entries) {
    const name = String(rawName).toLowerCase();
    if (SKIPPED_HEADERS.test(name) || Object.hasOwn(out, name)) continue;
    const cost = name.length + String(value).length;
    if (size + cost > max) continue;
    out[name] = String(value);
    size += cost;
  }
  return out;
}

/** The first value of each query parameter, as the agent's `{{query.<name>}}` reads it. */
export function pickHookQuery(search) {
  const out = {};
  for (const [name, value] of new URLSearchParams(search)) if (!Object.hasOwn(out, name)) out[name] = value;
  return out;
}

/** A HOOK frame's payload split into its JSON header line and the body bytes. */
export function splitHookFrame(payload) {
  const at = payload.indexOf(10);
  if (at < 0) throw new Error("A HOOK frame needs a header line");
  return { header: JSON.parse(decoder.decode(payload.subarray(0, at))), body: payload.slice(at + 1) };
}

/** Packs a delivery for the Worker's hop to the room: a JSON line with headers and query, then the body. */
export function packHookRequest({ headers, query, body }) {
  const head = encoder.encode(JSON.stringify({ headers, query }) + "\n");
  const out = new Uint8Array(head.byteLength + body.byteLength);
  out.set(head);
  out.set(body, head.byteLength);
  return out;
}
export function unpackHookRequest(bytes) {
  const { header, body } = splitHookFrame(bytes);
  return { headers: objectOf(header?.headers), query: objectOf(header?.query), body };
}
const objectOf = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, String(v)])) : {};

function hookFrame(delivery) {
  const head = encoder.encode(
    JSON.stringify({ id: delivery.id, hookId: delivery.hook, receivedAt: delivery.receivedAt, headers: delivery.headers, query: delivery.query }) + "\n",
  );
  const payload = new Uint8Array(head.byteLength + delivery.body.byteLength);
  payload.set(head);
  payload.set(delivery.body, head.byteLength);
  return frame(HOOK, 0n, payload);
}

/** The full hook set from a HOOK_SET payload, or null when it is malformed (then nothing changes). */
function hookSetOf(payload) {
  try {
    const ids = JSON.parse(decoder.decode(payload))?.hookIds;
    if (!Array.isArray(ids) || ids.length > MAX_HOOKS || !ids.every((id) => typeof id === "string" && HOOK_ID.test(id))) return null;
    return new Set(ids);
  } catch {
    return null;
  }
}

/**
 * One Mac's hooks inside its room. `storage.hooks` is the set registered here; `storage.deliveries` holds what waits for
 * the Mac ({ put, get, delete, list → [{ id, hook, receivedAt, size }] oldest first, size, bytes }). `directory` is the
 * cross-room map ({ claim(hookId, roomId) → boolean, release(hookId, roomId) }, sync or async). `send(bytes)` delivers a
 * whole frame to the Mac and says whether it could; the last one handed over (onHostReady, onFrame or the option) is used
 * for live forwarding, and failing to forward never loses a delivery, which stays stored until HOOK_ACK or expiry.
 */
export function createHookRoom({ storage, directory, roomId, now = Date.now, randomId = defaultRandomId, send: initialSend }) {
  let send = initialSend ?? (() => false);
  let applying = Promise.resolve();
  const room = () => (typeof roomId === "function" ? roomId() : roomId);
  const forward = (delivery) => {
    try {
      return send(hookFrame(delivery)) === true;
    } catch {
      return false;
    }
  };
  const flush = () => {
    for (const { id } of storage.deliveries.list()) {
      const delivery = storage.deliveries.get(id);
      if (delivery && !forward(delivery)) return;
    }
  };
  let desired = null; // the latest HOOK_SET, which the directory calls catch up with
  async function settle(removed) {
    const roomNow = room();
    for (const id of removed) await Promise.resolve(directory.release(id, roomNow)).catch(() => {});
    for (const id of desired) {
      if (storage.hooks.has(id)) continue;
      const claimed = await Promise.resolve(directory.claim(id, roomNow)).catch(() => false);
      if (claimed !== true) continue;
      // A later HOOK_SET may have dropped it while the claim was in flight.
      if (desired.has(id)) storage.hooks.add(id);
      else await Promise.resolve(directory.release(id, roomNow)).catch(() => {});
    }
  }
  return {
    receive(hookId, request) {
      if (typeof hookId !== "string" || !storage.hooks.has(hookId)) return NOT_FOUND;
      const body = request.body instanceof Uint8Array ? request.body : new Uint8Array(request.body ?? 0);
      if (body.byteLength > MAX_HOOK_BODY) return TOO_LARGE;
      const waiting = storage.deliveries.list().filter((entry) => entry.hook === hookId);
      const hookBytes = waiting.reduce((sum, entry) => sum + entry.size, 0);
      if (
        storage.deliveries.size() >= MAX_STORED ||
        storage.deliveries.bytes() + body.byteLength > MAX_STORED_BYTES ||
        waiting.length >= MAX_STORED_PER_HOOK ||
        hookBytes + body.byteLength > MAX_STORED_BYTES_PER_HOOK
      )
        return FULL;
      const delivery = {
        id: randomId(),
        hook: hookId,
        receivedAt: now(),
        size: body.byteLength,
        headers: request.headers ?? {},
        query: request.query ?? {},
        body,
      };
      storage.deliveries.put(delivery);
      forward(delivery);
      return { status: 202, json: { id: delivery.id } };
    },
    /** The Mac just proved itself: everything stored goes to it, oldest first. */
    onHostReady(nextSend) {
      if (nextSend) send = nextSend;
      flush();
    },
    /** A HOOK_SET or HOOK_ACK from the Mac. HOOK_SETs apply one at a time, in the order they came. */
    onFrame(type, payload, nextSend) {
      if (nextSend) send = nextSend;
      if (type === HOOK_ACK) {
        storage.deliveries.delete(decoder.decode(payload));
        return applying;
      }
      if (type !== HOOK_SET) return applying;
      const next = hookSetOf(payload);
      if (!next) return applying;
      desired = next;
      // Removals now, before any directory call: a rotated hook is dead at once.
      const removed = [...storage.hooks].filter((id) => !next.has(id));
      for (const id of removed) storage.hooks.delete(id);
      applying = applying.then(() => settle(removed));
      return applying;
    },
    /** Deletes deliveries held 24 h by `at`; returns when the next one expires, or null when none is left. */
    expire(at) {
      let next = null;
      for (const entry of storage.deliveries.list()) {
        if (entry.receivedAt + HOLD_MS <= at) storage.deliveries.delete(entry.id);
        else if (next === null || entry.receivedAt + HOLD_MS < next) next = entry.receivedAt + HOLD_MS;
      }
      return next;
    },
  };
}

/**
 * One hook's directory entry (one Durable Object per hook id): the room that owns it. The first claim wins and only the
 * owner can release. `storage` is a key-value store ({ get, put, delete }).
 */
export function createHookDirectory({ storage }) {
  const owner = () => storage.get("room") ?? null;
  return {
    claim(roomId) {
      const current = owner();
      if (current && current !== roomId) return false;
      if (!current) storage.put("room", roomId);
      return true;
    },
    release(roomId) {
      if (owner() === roomId) storage.delete("room");
    },
    room: owner,
  };
}

/** In-memory storage for one room's hooks: the daemon's local test relay and the tests. */
export function memoryHookStorage() {
  const rows = new Map();
  let bytes = 0;
  return {
    hooks: new Set(),
    deliveries: {
      put(delivery) {
        const old = rows.get(delivery.id);
        if (old) bytes -= old.size;
        rows.set(delivery.id, delivery);
        bytes += delivery.size;
      },
      get: (id) => rows.get(id) ?? null,
      delete(id) {
        const old = rows.get(id);
        if (!old) return;
        rows.delete(id);
        bytes -= old.size;
      },
      // Insertion order is arrival order.
      list: () => [...rows.values()].map(({ id, hook, receivedAt, size }) => ({ id, hook, receivedAt, size })),
      size: () => rows.size,
      bytes: () => bytes,
    },
  };
}

/** Every hook's directory entry in one map: the daemon's local test relay and the tests. */
export function memoryHookDirectory() {
  const entries = new Map();
  const entry = (hookId) => {
    if (!entries.has(hookId)) {
      const kv = new Map();
      entries.set(hookId, createHookDirectory({ storage: { get: (k) => kv.get(k), put: (k, v) => kv.set(k, v), delete: (k) => kv.delete(k) } }));
    }
    return entries.get(hookId);
  };
  return {
    claim: (hookId, roomId) => entry(hookId).claim(roomId),
    release: (hookId, roomId) => entry(hookId).release(roomId),
    owner: (hookId) => entry(hookId).room(),
  };
}
