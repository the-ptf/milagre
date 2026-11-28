const fs = require("node:fs");
const path = require("node:path");
const { SECRET_LIMITS, secretNameProblem } = require("@milagre/shared/secrets");
const { recordSchema, tombstoneSchema, normalized } = require("./secrets-vault.cjs");

const BATCH = 20;
const RETRY_MS = 60_000;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Which of two versions of a secret wins on every computer alike: the higher version, then the higher computer name. */
function newer(candidate, current) {
  if (!current) return true;
  if (candidate.version !== current.version) return candidate.version > current.version;
  return String(candidate.changedOn) > String(current.changedOn);
}

function digestOf(state) {
  return [
    ...Object.entries(state.secrets).map(([name, secret]) => ({ name, version: secret.version, changedOn: secret.changedOn, deleted: false })),
    ...Object.entries(state.tombstones).map(([name, tombstone]) => ({ name, version: tombstone.version, changedOn: tombstone.changedOn, deleted: true })),
  ];
}

/**
 * The entries another computer lacks or holds older, by its digest. Only this computer's own secrets go: one received
 * from another computer is never passed on, so turning sharing off reaches every copy. Deletes carry no value and go
 * everywhere, so a computer that never had a secret can't take an older copy of it later.
 */
function outgoing(state, theirs) {
  const known = new Map(theirs.map((entry) => [entry.name, entry]));
  const entries = [];
  for (const [name, tombstone] of Object.entries(state.tombstones)) if (newer(tombstone, known.get(name))) entries.push({ name, tombstone });
  for (const [name, secret] of Object.entries(state.secrets)) if (!secret.from && newer(secret, known.get(name))) entries.push({ name, secret });
  return entries;
}

/** Whether a received secret passes the checks a secret saved here passes. */
function acceptable(state, name, secret) {
  if (!secret.value || Buffer.byteLength(secret.value, "utf8") > SECRET_LIMITS.valueBytes) return false;
  if (secret.kind === "file" && !(secret.fileName && FILE_NAME.test(secret.fileName))) return false;
  const held = state.secrets[name]?.login;
  if (held && secret.login && (held.origin !== secret.login.origin || held.username !== secret.login.username)) return false;
  return Boolean(state.secrets[name]) || Object.keys(state.secrets).length < SECRET_LIMITS.count;
}

/** Applies what a computer sent; a reserved or malformed entry is skipped, never stored. Returns the names it changed. */
function merge(state, entries, from) {
  const applied = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = entry?.name;
    if (secretNameProblem(name)) continue;
    const secret = entry.secret ? recordSchema.safeParse(entry.secret) : null;
    const tombstone = entry.tombstone ? tombstoneSchema.safeParse(entry.tombstone) : null;
    const incoming = secret?.success ? secret.data : tombstone?.success ? tombstone.data : null;
    if (!incoming || !newer(incoming, state.secrets[name] ?? state.tombstones[name])) continue;
    if (secret?.success) {
      if (!acceptable(state, name, incoming) || !normalized(incoming)) continue;
      state.secrets[name] = { ...incoming, fileName: incoming.kind === "file" ? incoming.fileName : null, from };
      delete state.tombstones[name];
    } else {
      delete state.secrets[name];
      state.tombstones[name] = incoming;
    }
    applied.push(name);
  }
  return applied;
}

/** Drops what one computer shared, without tombstones, so sharing again later brings it back. */
function forgetFrom(state, from) {
  const removed = Object.keys(state.secrets).filter((name) => state.secrets[name].from === from);
  for (const name of removed) delete state.secrets[name];
  return removed;
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return { shared: Array.isArray(value?.shared) ? value.shared : [], pendingForget: Array.isArray(value?.pendingForget) ? value.pendingForget : [] };
  } catch {
    return { shared: [], pendingForget: [] };
  }
}

const fromPeer = (peerKey) => {
  if (typeof peerKey !== "string" || !peerKey) throw new Error("Only a paired computer sends secrets here.");
  return peerKey;
};

/**
 * Sends this computer's secrets to the paired computers it shares them with, over the encrypted computer link. Push
 * only: another computer can send changes here, never read a value back. What arrives is kept under the sending
 * computer's paired key, which the link authenticated, never a name it sends. Turning sharing off asks that computer
 * to drop what came from here, and keeps asking, also while it is offline, until it has.
 */
function createSecretsSync({ vault, remote, dataDir, retryMs = RETRY_MS }) {
  const file = path.join(dataDir, "secrets-sharing.json");
  let settings = readJson(file);
  const save = () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(settings), { mode: 0o600 });
  };
  const online = () => new Map((remote?.list?.() ?? []).filter((computer) => computer.online !== false).map((computer) => [computer.id, computer]));
  const running = new Map();
  const again = new Set();
  const retries = new Map();

  async function pushTo(id) {
    const theirs = await remote.invoke(id, "secrets:digest", []);
    let entries = [];
    await vault.transact((state) => {
      entries = outgoing(state, Array.isArray(theirs) ? theirs : []);
      return null;
    });
    for (let index = 0; index < entries.length && settings.shared.includes(id); index += BATCH)
      await remote.invoke(id, "secrets:push", [{ entries: entries.slice(index, index + BATCH) }]);
  }

  async function forgetOn(id) {
    await remote.invoke(id, "secrets:forget-from", [{}]);
    settings = { ...settings, pendingForget: settings.pendingForget.filter((item) => item !== id) };
    save();
  }

  const wanted = (id) => settings.shared.includes(id) || settings.pendingForget.includes(id);

  function retryLater(id) {
    clearTimeout(retries.get(id));
    const timer = setTimeout(() => {
      retries.delete(id);
      if (wanted(id)) void syncOne(id);
    }, retryMs);
    timer.unref?.();
    retries.set(id, timer);
  }

  function syncOne(id) {
    if (running.has(id)) {
      again.add(id);
      return running.get(id);
    }
    const work = (async () => {
      do {
        again.delete(id);
        if (settings.pendingForget.includes(id)) await forgetOn(id);
        if (settings.shared.includes(id) && (await vault.status()).unlocked) await pushTo(id);
      } while (again.has(id));
      clearTimeout(retries.get(id));
      retries.delete(id);
    })()
      .catch((error) => {
        console.warn(`Secrets didn't reach ${id}:`, error.message);
        again.delete(id);
        retryLater(id);
      })
      .finally(() => running.delete(id));
    running.set(id, work);
    return work;
  }

  let timer = null;
  const syncAll = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const id of online().keys()) if (wanted(id)) void syncOne(id);
    }, 300);
    timer.unref?.();
  };
  vault.onChange(syncAll);
  remote?.onOnline?.((id) => void syncOne(id));

  return {
    digest: async () => digestOf(await snapshot(vault)),
    async receive({ entries } = {}, peerKey) {
      const from = fromPeer(peerKey);
      let applied = [];
      await vault.transact((state) => {
        applied = merge(state, entries, from);
        return applied.length ? state : null;
      });
      return { applied };
    },
    async forgetFrom(_request, peerKey) {
      const from = fromPeer(peerKey);
      let removed = [];
      await vault.transact((state) => {
        removed = forgetFrom(state, from);
        return removed.length ? state : null;
      });
      return { removed };
    },
    sharing() {
      const live = online();
      return (remote?.list?.() ?? []).map((computer) => ({
        id: computer.id,
        name: computer.name,
        online: live.has(computer.id),
        shared: settings.shared.includes(computer.id),
        pendingRemoval: settings.pendingForget.includes(computer.id),
      }));
    },
    async share({ computer, on } = {}) {
      if (!(remote?.list?.() ?? []).some((item) => item.id === computer)) throw new Error("That computer isn't paired with this one.");
      const shared = settings.shared.filter((item) => item !== computer);
      const pendingForget = settings.pendingForget.filter((item) => item !== computer);
      settings = on ? { shared: [...shared, computer], pendingForget } : { shared, pendingForget: [...pendingForget, computer] };
      save();
      if (online().has(computer)) await syncOne(computer);
      else if (!on) retryLater(computer);
      return this.sharing();
    },
    syncOne,
  };
}

async function snapshot(vault) {
  let copy = null;
  await vault.transact((state) => {
    copy = state;
    return null;
  });
  return copy;
}

module.exports = { createSecretsSync, newer, outgoing, merge, forgetFrom, digestOf };
