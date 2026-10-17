import { b64url } from "@milagre/shared/relay-crypto";
import { frame, HOOK, HOOK_SET, HOOK_ACK, HOOK_RESULT } from "./room.mjs";

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

/** The JSON answer for a hook request; every 404 is these exact bytes and headers. */
export function hookResponse(answer) {
  return new Response(answer === NOT_FOUND ? NOT_FOUND_BODY : JSON.stringify(answer.json), {
    status: answer.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * `POST /hook/<secret>` at the edge. 405 and 413 are decided before anything about the hook is looked at. Then every path
 * is hashed, well-formed or not, and its directory entry is asked once (`lookupRoom(hookId)` → room id or null), so a
 * malformed secret, an unknown hook and a released one take the same steps to the same 404. A hook with a room goes on
 * to it (`forwardToRoom(roomId, hookId, packed)` → Response), which answers 404 itself when the hook isn't registered there.
 * Nothing here logs the secret, the URL or the body.
 */
export async function handleHookRequest(request, { lookupRoom, forwardToRoom }) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  const url = new URL(request.url);
  const body = await readHookBody(request);
  if (!body) return hookResponse(TOO_LARGE);
  const secret = hookSecretOf(url.pathname);
  const hookId = await hookIdOf(secret ?? url.pathname);
  const roomId = await lookupRoom(hookId);
  if (!secret || typeof roomId !== "string" || roomId === "") return hookResponse(NOT_FOUND);
  return forwardToRoom(roomId, hookId, packHookRequest({ headers: pickHookHeaders(request.headers.entries()), query: pickHookQuery(url.search), body }));
}

/**
 * One room's hook storage over SQLite (`sql.exec(query, ...bindings)` → a cursor with toArray and one, as a Durable
 * Object's `ctx.storage.sql` is). Makes its tables on first use.
 */
export function sqlHookStorage(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS hooks (id TEXT PRIMARY KEY)");
  sql.exec(
    "CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, hook TEXT NOT NULL, received_at INTEGER NOT NULL, size INTEGER NOT NULL, headers TEXT NOT NULL, query TEXT NOT NULL, body BLOB NOT NULL)",
  );
  const entry = (row) => ({ id: row.id, hook: row.hook, receivedAt: Number(row.received_at), size: Number(row.size) });
  return {
    hooks: {
      has: (id) => sql.exec("SELECT 1 AS x FROM hooks WHERE id = ?", id).toArray().length > 0,
      add: (id) => void sql.exec("INSERT OR IGNORE INTO hooks (id) VALUES (?)", id),
      delete: (id) => void sql.exec("DELETE FROM hooks WHERE id = ?", id),
      [Symbol.iterator]: () => {
        const ids = sql
          .exec("SELECT id FROM hooks")
          .toArray()
          .map((row) => row.id);
        return ids[Symbol.iterator]();
      },
    },
    deliveries: {
      put: (d) =>
        void sql.exec(
          "INSERT OR REPLACE INTO deliveries (id, hook, received_at, size, headers, query, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
          d.id,
          d.hook,
          d.receivedAt,
          d.size,
          JSON.stringify(d.headers),
          JSON.stringify(d.query),
          d.body.slice().buffer,
        ),
      get: (id) => {
        const row = sql.exec("SELECT * FROM deliveries WHERE id = ?", id).toArray()[0];
        if (!row) return null;
        return { ...entry(row), headers: JSON.parse(row.headers), query: JSON.parse(row.query), body: new Uint8Array(row.body) };
      },
      delete: (id) => void sql.exec("DELETE FROM deliveries WHERE id = ?", id),
      list: () => sql.exec("SELECT id, hook, received_at, size FROM deliveries ORDER BY received_at, rowid").toArray().map(entry),
      size: () => Number(sql.exec("SELECT COUNT(*) AS n FROM deliveries").one().n),
      bytes: () => Number(sql.exec("SELECT COALESCE(SUM(size), 0) AS n FROM deliveries").one().n),
    },
  };
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

/**
 * The full hook set from a HOOK_SET payload, `{ hookIds, proofs? }`, or null when it is malformed (then nothing changes).
 * `proofs` maps a hook id to its URL secret, sent only over the Mac's proven connection, so a hook another room still holds
 * (this Mac's room before a Reset) can move here.
 */
function hookSetOf(payload) {
  try {
    const message = JSON.parse(decoder.decode(payload));
    const ids = message?.hookIds;
    if (!Array.isArray(ids) || ids.length > MAX_HOOKS || !ids.every((id) => typeof id === "string" && HOOK_ID.test(id))) return null;
    const proofs = new Map();
    const given = message.proofs;
    if (given && typeof given === "object" && !Array.isArray(given)) {
      for (const id of ids) if (Object.hasOwn(given, id) && typeof given[id] === "string" && SECRET.test(given[id])) proofs.set(id, given[id]);
    }
    return { ids: new Set(ids), proofs };
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
  const unreleased = new Set(); // hooks dropped here whose directory release hasn't gone through yet
  const release = (id, roomNow) =>
    Promise.resolve()
      .then(() => directory.release(id, roomNow))
      .then(
        () => unreleased.delete(id),
        () => unreleased.add(id),
      );
  async function settle(removed, proofs) {
    const roomNow = room();
    for (const id of removed) unreleased.add(id);
    // Releases that failed before are tried again on every set; a hook wanted again is still this room's.
    for (const id of [...unreleased]) {
      if (desired.has(id)) unreleased.delete(id);
      else await release(id, roomNow);
    }
    const refused = [];
    const failed = [];
    for (const id of desired) {
      if (storage.hooks.has(id)) continue;
      const secret = proofs.get(id);
      const claimed = await Promise.resolve()
        .then(() => (secret ? directory.claim(id, roomNow, secret) : directory.claim(id, roomNow)))
        .catch(() => null);
      if (claimed !== true) {
        // false: another room holds it (this Mac before a Reset, until its old room lets go or a proof moves it here).
        // null: the directory couldn't be asked. Either way the next set tries again.
        if (desired.has(id)) (claimed === null ? failed : refused).push(id);
        continue;
      }
      // A later HOOK_SET may have dropped it while the claim was in flight.
      if (desired.has(id)) storage.hooks.add(id);
      else await release(id, roomNow);
    }
    try {
      send(frame(HOOK_RESULT, 0n, encoder.encode(JSON.stringify({ refused, failed }))));
    } catch {
      /* the Mac is gone; it sends its set again on the next ready */
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
        return undefined;
      }
      if (type !== HOOK_SET) return undefined;
      const next = hookSetOf(payload);
      if (!next) return undefined;
      desired = next.ids;
      // Removals now, before any directory call: a rotated hook is dead at once.
      const removed = [...storage.hooks].filter((id) => !next.ids.has(id));
      for (const id of removed) storage.hooks.delete(id);
      // A settle that fails (no room id yet, storage trouble) must not stop every later set from applying.
      applying = applying.then(() => settle(removed, next.proofs)).catch(() => {});
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
    /**
     * `proof` ({ hookId, secret }) moves the hook here from another room when sha256(secret) is this entry's hook id: the
     * Mac that made the URL takes it back after a Reset left its old room holding it. Without a valid proof a hook another
     * room holds stays there.
     */
    async claim(roomId, proof) {
      const current = owner();
      const known = storage.get("hook") ?? null;
      if (!current || current === roomId) {
        if (!current) storage.put("room", roomId);
        if (!known && proof && HOOK_ID.test(String(proof.hookId))) storage.put("hook", proof.hookId);
        return true;
      }
      if (!proof || typeof proof.secret !== "string" || !SECRET.test(proof.secret)) return false;
      if (known && known !== proof.hookId) return false;
      if ((await hookIdOf(proof.secret)) !== proof.hookId) return false;
      storage.put("room", roomId);
      storage.put("hook", proof.hookId);
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
    claim: (hookId, roomId, secret) => entry(hookId).claim(roomId, secret ? { hookId, secret } : undefined),
    release: (hookId, roomId) => entry(hookId).release(roomId),
    owner: (hookId) => entry(hookId).room(),
  };
}
