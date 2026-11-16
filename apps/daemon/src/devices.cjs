const { assertPrivate } = require("@milagre/core/private-files");
const fs = require("node:fs/promises");
const path = require("node:path");
const { writePrivate } = require("./relay-identity.cjs");

const MAX_DEVICES = 32;
const KINDS = new Set(["phone", "computer"]);
const SEEN_WRITE_MS = 60_000;
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
    isNew: value.isNew === true,
    announced: value.announced !== false,
  };
}
const shown = ({ announced: _announced, ...device }) => ({ ...device });

function createDevices(dataDir, { now = Date.now } = {}) {
  const file = path.join(dataDir, "devices.json");
  const legacyFile = path.join(dataDir, "relay-phones.json");
  let devices = [];
  let removed = new Map();
  let loaded = null;
  let writtenAt = -Infinity;
  let writes = Promise.resolve();
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

  async function read() {
    await writes;
    let value;
    try {
      assertPrivate(file);
      value = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      const migrated = error.code === "ENOENT" ? await legacyDevices() : null;
      devices = migrated ?? [];
      removed = new Map();
      if (!migrated) return;
      try {
        await write();
        await fs.rm(legacyFile, { force: true });
      } catch {}
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
      claims.delete(key);
      writtenAt = at;
      await write();
    },
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
    async takeNotices() {
      await ready();
      const at = now();
      const due = devices.filter((device) => !device.announced && !(claims.has(device.key) && at - claims.get(device.key).at < CLAIM_MS));
      if (!due.length) return { claim: null, devices: [] };
      const claim = `n${++nextClaim}`;
      for (const device of due) claims.set(device.key, { id: claim, at });
      return { claim, devices: due.map(shown) };
    },
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
    releaseNotices(claim) {
      for (const [key, held] of claims) if (held.id === claim) claims.delete(key);
    },
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
