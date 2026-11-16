const fs = require("node:fs");
const path = require("node:path");

const PROVIDERS = require("@milagre/shared/providers").PROVIDERS.toReversed();

const emptyState = () => Object.fromEntries(PROVIDERS.map((provider) => [provider, { last: null, blocked: null }]));

function cleanWindow(item) {
  if (!item || typeof item !== "object") return null;
  const { id, label, shortLabel, usedPercent, resetsAt } = item;
  if (typeof id !== "string" || typeof label !== "string" || typeof shortLabel !== "string") return null;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
  return { id, label, shortLabel, usedPercent, resetsAt: typeof resetsAt === "string" ? resetsAt : null };
}

function cleanLast(last) {
  if (!last || !Array.isArray(last.windows) || typeof last.updatedAt !== "string") return null;
  if (Number.isNaN(Date.parse(last.updatedAt))) return null;
  const windows = last.windows.map(cleanWindow);
  if (windows.length === 0 || windows.includes(null)) return null;
  const banked = Number.isInteger(last.bankedResets) && last.bankedResets > 0 ? { bankedResets: last.bankedResets } : {};
  return { windows, updatedAt: last.updatedAt, ...banked };
}

function cleanBlocked(blocked) {
  if (!blocked || typeof blocked.until !== "number" || !Number.isFinite(blocked.until)) return null;
  return { until: blocked.until, message: typeof blocked.message === "string" ? blocked.message : "Claude is rate limiting usage checks." };
}

function load(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Object.fromEntries(
      PROVIDERS.map((provider) => [provider, { last: cleanLast(parsed?.[provider]?.last), blocked: cleanBlocked(parsed?.[provider]?.blocked) }]),
    );
  } catch {
    return emptyState();
  }
}

function createUsageStore({ file } = {}) {
  const state = file ? load(file) : emptyState();
  let writing = Promise.resolve();

  function persist() {
    if (!file) return;
    const body = JSON.stringify(state);
    writing = writing
      .then(async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const temp = `${file}.tmp`;
        await fs.promises.writeFile(temp, body);
        await fs.promises.rename(temp, file);
      })
      .catch(() => {});
  }

  return {
    get(provider) {
      return state[provider] ?? { last: null, blocked: null };
    },
    setLast(provider, last) {
      const clean = cleanLast(last);
      if (!clean || !state[provider]) return;
      state[provider].last = clean;
      persist();
    },
    setBlocked(provider, blocked) {
      const entry = state[provider];
      if (!entry || (!entry.blocked && !blocked)) return;
      entry.blocked = cleanBlocked(blocked);
      persist();
    },
    idle: () => writing,
  };
}

function cachedSnapshot(store, nowMs) {
  const providers = [];
  for (const provider of PROVIDERS) {
    const { last } = store.get(provider);
    if (!last) continue;
    const windows = last.windows.filter((item) => !item.resetsAt || Date.parse(item.resetsAt) > nowMs);
    if (!windows.length) continue;
    const banked = last.bankedResets ? { bankedResets: last.bankedResets } : {};
    providers.push({ provider, status: "ok", windows, updatedAt: last.updatedAt, ...banked });
  }
  return { providers };
}

module.exports = { createUsageStore, cachedSnapshot };
