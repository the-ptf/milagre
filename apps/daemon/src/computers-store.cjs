const fs = require("node:fs/promises");
const { helloName } = require("@milagre/shared/relay-crypto");
const { writePrivate } = require("./relay-identity.cjs");

// lastSeen moves with every connection; the file follows at most this often.
const SEEN_WRITE_MS = 60_000;
const MAX_LAN_ROUTES = 4;
const HOST_ID = /^[A-Za-z0-9_-]{22}$/;
// A computer's id here; no "|", which PR 4's stored chat keys use (`${computerId}|${key}`).
const ID = /^[A-Za-z0-9-]{1,64}$/;
// A LAN route: a private or Tailscale (100.64.0.0/10) address, as the phone takes (apps/mobile/src/lan-route.ts). This Mac's own loopback reaches only
// this Mac, so only the end-to-end tests (allowLocalRelay) take it; it would still have to pass the probe's host id and
// the hello's pinned key.
const LAN_ROUTE = /^ws:\/\/(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}:\d{1,5}$/;
const LOOPBACK_ROUTE = /^ws:\/\/127\.0\.\d{1,3}\.\d{1,3}:\d{1,5}$/;

const lanRoutesOf = (value, allowLoopback) =>
  Array.isArray(value)
    ? value.filter((url) => typeof url === "string" && (LAN_ROUTE.test(url) || (allowLoopback && LOOPBACK_ROUTE.test(url)))).slice(0, MAX_LAN_ROUTES)
    : [];
const time = (value) => (Number.isFinite(value) ? value : null);
const copy = (computer) => ({ ...computer, lanRoutes: [...computer.lanRoutes] });

function readComputer(value, allowLoopback) {
  if (!value || typeof value.id !== "string" || !ID.test(value.id) || !HOST_ID.test(String(value.hostId)) || typeof value.relay !== "string") return null;
  return {
    id: value.id,
    hostId: String(value.hostId),
    name: helloName(value.name) ?? "Computer",
    relay: value.relay,
    lanRoutes: lanRoutesOf(value.lanRoutes, allowLoopback),
    addedAt: time(value.addedAt),
    lastSeen: time(value.lastSeen),
  };
}

/** The LAN routes in a computer's peer:routes answer, only when it names the Mac pinned at pairing; null otherwise. */
function lanRoutesFrom(answer, { hostId, hostKey, allowLocalRelay = false }) {
  if (!answer || answer.hostId !== hostId || answer.key !== hostKey) return null;
  return lanRoutesOf(answer.lan, allowLocalRelay);
}

/**
 * The computers this Mac drives, oldest first, in `<userData>/computers.json` (0600): `[{ id, hostId, name, relay,
 * lanRoutes, addedAt, lastSeen }]`. `name` is this Mac's label ("Show it as"), sent nowhere. The Mac's pinned key and its
 * pairing token are secrets and live in computer-keys.cjs. Writes land in call order.
 */
function createComputersStore({ file, now = Date.now, allowLocalRelay = false }) {
  let computers = [];
  let writes = Promise.resolve();
  const seenWritten = new Map();
  const write = () => {
    const value = computers.map(copy);
    const next = writes.then(() => writePrivate(file, value));
    writes = next.catch(() => {});
    return next;
  };
  const find = (id) => computers.find((computer) => computer.id === id);
  const list = () => computers.map(copy);
  return {
    async load() {
      try {
        const value = JSON.parse(await fs.readFile(file, "utf8"));
        computers = (Array.isArray(value) ? value : []).map((item) => readComputer(item, allowLocalRelay)).filter((computer) => computer !== null);
      } catch {
        computers = [];
      }
      return list();
    },
    list,
    get(id) {
      const computer = find(id);
      return computer ? copy(computer) : null;
    },
    async add({ id, hostId, name, relay, lanRoutes = /** @type {string[]} */ ([]) }) {
      const computer = readComputer({ id, hostId, name, relay, lanRoutes, addedAt: now(), lastSeen: now() }, allowLocalRelay);
      if (!computer) throw new Error("That computer's link is damaged.");
      const before = computers;
      const after = [...computers.filter((item) => item.id !== id), computer];
      computers = after;
      try {
        await write();
      } catch (error) {
        // What is shown must be what is on disk.
        if (computers === after) computers = before;
        throw error;
      }
      return copy(computer);
    },
    async rename(id, name) {
      const computer = find(id);
      if (!computer) throw new Error("That computer was removed.");
      const next = helloName(name);
      if (!next) throw new Error("Give it a name.");
      const before = computer.name;
      computer.name = next;
      try {
        await write();
      } catch (error) {
        if (computer.name === next) computer.name = before;
        throw error;
      }
      return copy(computer);
    },
    async setLanRoutes(id, routes) {
      const computer = find(id);
      if (!computer) return;
      const next = lanRoutesOf(routes, allowLocalRelay);
      if (JSON.stringify(next) === JSON.stringify(computer.lanRoutes)) return;
      computer.lanRoutes = next;
      await write();
    },
    async seen(id) {
      const computer = find(id);
      if (!computer) return;
      const at = now();
      computer.lastSeen = at;
      if (at - (seenWritten.get(id) ?? -Infinity) < SEEN_WRITE_MS) return;
      seenWritten.set(id, at);
      await write();
    },
    async remove(id) {
      if (!find(id)) return false;
      const before = computers;
      const after = computers.filter((computer) => computer.id !== id);
      computers = after;
      seenWritten.delete(id);
      try {
        await write();
      } catch (error) {
        if (computers === after) computers = before;
        throw error;
      }
      return true;
    },
  };
}

module.exports = { createComputersStore, lanRoutesFrom };
