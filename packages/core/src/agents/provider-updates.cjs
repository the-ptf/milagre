const { inspectCli, parseVersion, isAtLeast } = require("./cli.cjs");

const PACKAGES = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };
const CHECK_MS = 30 * 60_000;
const RETRY_MS = 60_000;
const releaseVersion = (value) => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);

// Advisory only: a failed release lookup never changes whether a provider can run.
function createProviderUpdates({ inspect = inspectCli, fetchImpl = fetch, now = Date.now, ready = () => {}, antigravity } = {}) {
  const cache = new Map();
  const latest = (provider) => {
    const cached = cache.get(provider);
    if (cached && now() < cached.until) return cached.promise;
    const entry = { until: now() + CHECK_MS, promise: null };
    entry.promise = Promise.resolve().then(async () => {
      try {
        const response = await fetchImpl(`https://registry.npmjs.org/${PACKAGES[provider]}/latest`, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error("Release lookup failed");
        const { version } = await response.json();
        if (!releaseVersion(version)) throw new Error("Invalid release version");
        return version;
      } catch {
        entry.until = now() + RETRY_MS;
        return null;
      }
    });
    cache.set(provider, entry);
    return entry.promise;
  };
  return async () => {
    await ready();
    const updates = await Promise.all(
      Object.keys(PACKAGES).map(async (provider) => {
        const current = await inspect(provider).catch(() => null);
        if (!current?.command || !releaseVersion(current.version)) return null;
        const version = await latest(provider);
        return version && !isAtLeast(parseVersion(current.version), version) ? { provider, installedVersion: current.version, version } : null;
      }),
    );
    const current = antigravity?.resolve();
    const pinned = antigravity?.pinned();
    if (current && pinned && antigravity.updateAvailable())
      updates.push({ provider: "antigravity", installedVersion: current.version, version: pinned.version });
    return updates.filter(Boolean);
  };
}

module.exports = { createProviderUpdates, releaseVersion };
