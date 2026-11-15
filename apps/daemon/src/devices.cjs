const { assertPrivate } = require("@milagre/core/private-files");
const fs = require("node:fs/promises");
const path = require("node:path");
const { writePrivate } = require("./relay-identity.cjs");

const MAX_DEVICES = 32;
const KINDS = new Set(["phone", "computer"]);
// lastSeen changes at every hello; the file follows at most this often. A new name is written at once.
const SEEN_WRITE_MS = 60_000;
// A window that took a pairing notice confirms it once shown. Past this with no confirm (its reply was lost, or it went
// quiet), the notice is offered again.
const CLAIM_MS = 60_000;
const time = (value) => (Number.isFinite(value) ? value : null);

function readDevice(value) {
  if (!value || typeof value.key !== "string" || !KINDS.has(value.kind)) return null;
  return {
    key: value.key,
    kind: value.kind,
    name: typeof value.name === "string" && value.name ? value.name : null,
    pairedAt: time(value.pairedAt),
    lastSeen: time(value.lastSeen),
    // Missing in files from before these: nothing to announce or mark.
    isNew: value.isNew === true,
    announced: value.announced !== false,
  };
}
// What callers see: `announced` stays inside the store.
const shown = ({ announced: _announced, ...device }) => ({ ...device });

/**
 * The phones and computers paired to this Mac, oldest first, in `<dataDir>/devices.json` ({ devices, removed }, 0600).
 * `removed` keeps when each forgotten device was removed, so phone.cjs can keep it from pairing again in the window it
 * was removed in. Reset clears both. When devices.json is missing, the bare key list from before devices had names
 * (relay-phones.json) moves in as nameless phones and is deleted. Writes land in call order, so a clear is never
 * overwritten by an add that started before it. Any method may run before load(): the first one reads the file.
 *
 * A phone pairs without its owner at this Mac, so it arrives `isNew` (Settings › Phone & sharing marks it New until the owner
 * looks: `acknowledge`) and not yet `announced` (the "New phone paired" notice waits for a desktop to take it:
 * `takeNotices`, then `confirmNotices` once it showed them). Both survive restarts, so a phone that pairs while no
 * desktop is open is still told about. A computer pairs only after its owner's Allow in this Mac's window, so it is
 * neither. A taken notice is only claimed, in memory: no other window gets it while the claim holds, and it is offered
 * again if the claim is released (its connection closed), times out (CLAIM_MS) or dies with the daemon. Only the
 * confirm writes it as announced, so a reply lost on the way to the window never loses the notice.
 */
function createDevices(dataDir, { now = Date.now } = {}) {
  const file = path.join(dataDir, "devices.json");
  const legacyFile = path.join(dataDir, "relay-phones.json");
  let devices = [];
  let removed = new Map(); // key -> when it was removed
  let loaded = null;
  let writtenAt = -Infinity;
  let writes = Promise.resolve();
  // Notices handed to a window and not confirmed yet: key -> { id, at }. Never written: a restart offers them again.
  const claims = new Map();
  let nextClaim = 0;
  const write = () => {
    const value = {
      devices: devices.map((device) => ({ ...device })),
      removed: [...removed].map(([key, removedAt]) => ({ key, removedAt })),
    };
    const next = writes.then(() => writePrivate(file, value));
    writes = next.catch(() => {});
    return next;
  };

  // The older key list as nameless phones, or null when there is none to take over.
  async function legacyDevices() {
    let phones;
    try {
      assertPrivate(legacyFile);
      phones = JSON.parse(await fs.readFile(legacyFile, "utf8")).phones;
    } catch {
      return null;
    }
    if (!Array.isArray(phones)) return null;
    return phones
      .filter((key) => typeof key === "string")
      .slice(-MAX_DEVICES)
      .map((key) => ({ key, kind: "phone", name: null, pairedAt: null, lastSeen: null, isNew: false, announced: true }));
  }

  // Built in locals and swapped in at the end, so the store never reads as empty while the file is being read.
  async function read() {
    await writes;
    let value;
    try {
      assertPrivate(file);
      value = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      // Missing: maybe an older list to take over. Unreadable or not private: nothing is known, as before.
      const migrated = error.code === "ENOENT" ? await legacyDevices() : null;
      devices = migrated ?? [];
      removed = new Map();
      if (!migrated) return;
      try {
        await write();
        // Gone once copied: a downgraded daemon must not bring back a phone removed here.
        await fs.rm(legacyFile, { force: true });
      } catch {
        /* kept in memory; the next change writes it */
      }
      return;
    }
    const nextRemoved = new Map();
    for (const entry of Array.isArray(value?.removed) ? value.removed : [])
      if (typeof entry?.key === "string" && Number.isFinite(entry.removedAt)) nextRemoved.set(entry.key, entry.removedAt);
    devices = (Array.isArray(value?.devices) ? value.devices : []).map(readDevice).filter(Boolean).slice(-MAX_DEVICES);
    removed = nextRemoved;
  }
  const ready = () => (loaded ??= read());
  const find = (key) => devices.find((device) => device.key === key);

  return {
    load() {
      loaded = read();
      return loaded;
    },
    isKnown: (key) => devices.some((device) => device.key === key),
    count: () => devices.length,
    list: () => devices.map(shown),
    removedAt: (key) => removed.get(key) ?? null,
    /** The kind a device paired as ("phone" or "computer"), or null when it isn't paired. */
    kindOf: (key) => find(key)?.kind ?? null,
    async add(key, { kind = "phone", name = null } = {}) {
      if (!KINDS.has(kind)) throw new Error(`Unknown device kind: ${kind}`);
      await ready();
      const at = now();
      const previous = find(key);
      const phone = kind === "phone";
      const device = { key, kind, name: name ?? previous?.name ?? null, pairedAt: previous?.pairedAt ?? at, lastSeen: at, isNew: phone, announced: !phone };
      devices = [...devices.filter((item) => item.key !== key), device].slice(-MAX_DEVICES);
      removed.delete(key);
      // A pairing again is a new notice, whatever an earlier one of this key held.
      claims.delete(key);
      writtenAt = at;
      await write();
    },
    /** A known device said hello: when, and its name when it sent a new one. Unknown keys are ignored. */
    async seen(key, { name = null } = {}) {
      await ready();
      const device = find(key);
      if (!device) return;
      const at = now();
      const renamed = name !== null && name !== device.name;
      device.lastSeen = at;
      if (renamed) device.name = name;
      if (!renamed && at - writtenAt < SEEN_WRITE_MS) return;
      writtenAt = at;
      await write();
    },
    /**
     * The devices whose pairing no desktop has announced yet and no window holds, oldest first, claimed under `claim`
     * (null when there are none). However many windows or connections ask, each gets a pairing no other one holds.
     */
    async takeNotices() {
      await ready();
      // Chosen and claimed in one step, with no wait in between, so two callers never get the same device.
      const at = now();
      const due = devices.filter((device) => !device.announced && !(claims.has(device.key) && at - claims.get(device.key).at < CLAIM_MS));
      if (!due.length) return { claim: null, devices: [] };
      const claim = `n${++nextClaim}`;
      for (const device of due) claims.set(device.key, { id: claim, at });
      return { claim, devices: due.map(shown) };
    },
    /**
     * The window showed what it took under `claim`: they are announced, on disk. Returns how many. A claim that was
     * released or taken over by a newer one confirms nothing. A failed write keeps them pending on disk and in memory,
     * and the claim holds until it times out, so they are offered again then rather than lost.
     */
    async confirmNotices(claim) {
      await ready();
      const confirmed = devices.filter((device) => claims.get(device.key)?.id === claim && !device.announced);
      if (!confirmed.length) return 0;
      for (const device of confirmed) device.announced = true;
      try {
        await write();
      } catch (error) {
        for (const device of confirmed) device.announced = false;
        throw error;
      }
      for (const device of confirmed) if (claims.get(device.key)?.id === claim) claims.delete(device.key);
      return confirmed.length;
    },
    /** The window that took `claim` is gone without confirming: what it held is offered again at once. */
    releaseNotices(claim) {
      // Deleting the entry being visited is safe while iterating a Map.
      for (const [key, held] of claims) if (held.id === claim) claims.delete(key);
    },
    /**
     * The owner saw these devices in Settings › Phone & sharing: they are no longer New. Returns how many were. A failed write
     * leaves them New in memory too, so the next acknowledge writes them.
     */
    async acknowledge(keys) {
      await ready();
      const seenKeys = new Set(keys);
      const changed = devices.filter((device) => device.isNew && seenKeys.has(device.key));
      if (!changed.length) return 0;
      for (const device of changed) device.isNew = false;
      try {
        await write();
      } catch (error) {
        for (const device of changed) device.isNew = true;
        throw error;
      }
      return changed.length;
    },
    /** Forgets a device; false when it wasn't paired. */
    async remove(key) {
      await ready();
      if (!find(key)) return false;
      devices = devices.filter((device) => device.key !== key);
      removed.delete(key);
      removed.set(key, now());
      while (removed.size > MAX_DEVICES) removed.delete(removed.keys().next().value);
      await write();
      return true;
    },
    async clear() {
      await ready();
      devices = [];
      removed = new Map();
      claims.clear();
      await write();
    },
  };
}

module.exports = { createDevices, MAX_DEVICES, CLAIM_MS };
