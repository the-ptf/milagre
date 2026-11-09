const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");

// A relay holds a delivery 24 h and a Routine remembers its key 48 h (store.cjs); a delivery nothing came back for in that
// time (its Run failed before its first message, a redelivery of one already handled) goes when the file is next read.
const HOOK_DELIVERY_MAX_AGE_MS = 48 * 3600_000;
const VERSION = 1;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value !== "";
const strings = (value) => (isObject(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)])) : {});

function checkDelivery(value) {
  if (!isObject(value) || !text(value.id) || !text(value.hookId) || !Number.isFinite(value.receivedAt)) {
    throw new Error("A webhook delivery needs an id, a hookId and receivedAt");
  }
  if (!(value.body instanceof Uint8Array)) throw new Error("A webhook delivery's body must be bytes");
  return {
    id: value.id,
    hookId: value.hookId,
    receivedAt: value.receivedAt,
    headers: strings(value.headers),
    query: strings(value.query),
    body: Buffer.from(value.body.buffer, value.body.byteOffset, value.body.byteLength).toString("base64"),
  };
}
const readDelivery = (entry) => ({ ...entry, body: new Uint8Array(Buffer.from(entry.body, "base64")) });

/**
 * Webhook secrets and the deliveries the Mac has acknowledged but not yet turned into a Run's first message, in one file
 * only this user can read (0600 in a 0700 folder; written to a temporary file, synced, then renamed, as the Linear sign-ins
 * are). A secret is `{ secret, ownerKey?, signingSecret?, previous? }` per Routine: `secret` is the one in the hook
 * URL, the owner key proves to the relay that this Mac owns the hook (only over its own host connection, never in the URL),
 * and the signing secret checks a sender's HMAC and never leaves the Mac. Every write is synchronous and on disk before it returns,
 * so a delivery acknowledged to the relay survives a restart. Nothing here logs.
 */
function createHookStore({ file, now = Date.now }) {
  // Set when the file exists but couldn't be read: every write is refused, so a passing EACCES or EIO can't replace the
  // secrets with an empty store.
  let unreadable = null;
  let data = load();
  mintOwnerKeys();

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") unreadable = error?.code ?? "error";
      return { version: VERSION, secrets: {}, deliveries: {} };
    }
    try {
      const parsed = JSON.parse(raw);
      if (!isObject(parsed) || !isObject(parsed.secrets) || !isObject(parsed.deliveries)) throw new Error("Not a hook store");
      const oldest = now() - HOOK_DELIVERY_MAX_AGE_MS;
      const deliveries = Object.fromEntries(
        Object.entries(parsed.deliveries).filter(([, entry]) => isObject(entry) && typeof entry.body === "string" && entry.receivedAt >= oldest),
      );
      return { version: VERSION, secrets: parsed.secrets, deliveries };
    } catch {
      // Kept aside rather than overwritten: it may still hold a secret someone wants back.
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* nothing to keep */
      }
      return { version: VERSION, secrets: {}, deliveries: {} };
    }
  }

  // A hook saved before owner keys gets one now, so the relay can register its hash on the next hook set.
  function mintOwnerKeys() {
    const missing = Object.entries(data.secrets).filter(([, entry]) => isObject(entry) && text(entry.secret) && !text(entry.ownerKey));
    if (missing.length === 0 || unreadable) return;
    try {
      change((next) => {
        for (const [routineId, entry] of missing) next.secrets[routineId] = { ...entry, ownerKey: randomBytes(32).toString("base64url") };
      });
    } catch (error) {
      console.warn("[routines] couldn't give a webhook its owner key", error?.code ?? "error");
    }
  }

  function write(next) {
    if (unreadable) throw new Error(`The webhook store couldn't be read (${unreadable}), so nothing was changed.`);
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(next));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temp, file);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
    data = next;
  }
  // Every write also lets go of deliveries past their age, so a daemon that runs for weeks doesn't keep them.
  function change(edit) {
    const oldest = now() - HOOK_DELIVERY_MAX_AGE_MS;
    const deliveries = Object.fromEntries(Object.entries(data.deliveries).filter(([, entry]) => entry.receivedAt >= oldest));
    const next = { version: VERSION, secrets: { ...data.secrets }, deliveries };
    edit(next);
    write(next);
  }
  const readSecret = (entry) =>
    isObject(entry) && text(entry.secret)
      ? {
          secret: entry.secret,
          ...(text(entry.ownerKey) ? { ownerKey: entry.ownerKey } : {}),
          ...(text(entry.signingSecret) ? { signingSecret: entry.signingSecret } : {}),
        }
      : null;
  const cleanSecret = ({ secret, ownerKey, signingSecret }) => ({
    secret,
    ...(text(ownerKey) ? { ownerKey } : {}),
    ...(text(signingSecret) ? { signingSecret } : {}),
  });

  return {
    /** `previous`: the entry a rotation is replacing, kept until the Routine has the new hook id (see runtime-adapter.cjs). */
    secretFor(routineId) {
      const entry = data.secrets[routineId];
      const current = readSecret(entry);
      if (!current) return null;
      const previous = readSecret(entry.previous);
      return previous ? { ...current, previous } : current;
    },
    setSecret(routineId, { secret, ownerKey, signingSecret, previous } = {}) {
      if (!text(routineId) || !text(secret)) throw new Error("A webhook secret needs a Routine and a secret");
      if (previous !== undefined && !readSecret(previous)) throw new Error("A replaced webhook secret needs its secret");
      change((next) => {
        next.secrets[routineId] = { ...cleanSecret({ secret, ownerKey, signingSecret }), ...(previous ? { previous: cleanSecret(previous) } : {}) };
      });
    },
    removeSecret(routineId) {
      if (!Object.hasOwn(data.secrets, routineId)) return;
      change((next) => {
        delete next.secrets[routineId];
      });
    },
    putDelivery(delivery) {
      this.putDeliveries([delivery]);
    },
    /** Several deliveries in one synced write (the flush after the relay reconnects). */
    putDeliveries(deliveries) {
      const entries = deliveries.map(checkDelivery);
      if (entries.length === 0) return;
      change((next) => {
        for (const entry of entries) next.deliveries[entry.id] = entry;
      });
    },
    getDelivery(id) {
      const entry = Object.hasOwn(data.deliveries, id) ? data.deliveries[id] : null;
      return entry ? readDelivery(entry) : null;
    },
    takeDelivery(id) {
      const found = this.getDelivery(id);
      if (!found) return null;
      change((next) => {
        delete next.deliveries[id];
      });
      return found;
    },
    /** Oldest first. */
    listDeliveries() {
      return Object.values(data.deliveries)
        .map(readDelivery)
        .toSorted((a, b) => a.receivedAt - b.receivedAt);
    },
  };
}

module.exports = { createHookStore, HOOK_DELIVERY_MAX_AGE_MS };
