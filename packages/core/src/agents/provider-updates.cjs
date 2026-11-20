const { inspectCli, parseVersion, isAtLeast } = require("./cli.cjs");
const { installChannel, channelRelease, updateCommand } = require("./cli-channel.cjs");

const PROVIDERS = ["claude", "codex"];
const CHECK_MS = 30 * 60_000;
const RETRY_MS = 60_000;
const releaseVersion = (value) => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);

function createProviderUpdates({
  inspect = inspectCli,
  fetchImpl = fetch,
  now = Date.now,
  ready = () => {},
  antigravity,
  channelOf = installChannel,
  release = (provider, channel) => channelRelease(provider, channel, { fetchImpl }),
} = {}) {
  const cache = new Map();
  const latest = (provider, channel) => {
    const key = `${provider}:${channel.kind}:${channel.token ?? ""}`;
    const cached = cache.get(key);
    if (cached && now() < cached.until) return cached.promise;
    const entry = { until: now() + CHECK_MS, promise: null };
    entry.promise = Promise.resolve().then(async () => {
      try {
        const { version } = await release(provider, channel);
        if (!releaseVersion(version)) throw new Error("Invalid release version");
        return version;
      } catch {
        entry.until = now() + RETRY_MS;
        return null;
      }
    });
    cache.set(key, entry);
    return entry.promise;
  };
  return async () => {
    await ready();
    const updates = await Promise.all(
      PROVIDERS.map(async (provider) => {
        const current = await inspect(provider).catch(() => null);
        if (!current?.command || !releaseVersion(current.version)) return null;
        const channel = channelOf(provider, current.command);
        const version = await latest(provider, channel);
        if (!version || isAtLeast(parseVersion(current.version), version)) return null;
        return { provider, installedVersion: current.version, version, channel: channel.kind, command: updateCommand(provider, channel) };
      }),
    );
    const current = antigravity?.resolve();
    const pinned = antigravity?.pinned();
    if (current && pinned && antigravity.updateAvailable())
      updates.push({ provider: "antigravity", installedVersion: current.version, version: pinned.version, channel: "milagre", command: null });
    return updates.filter(Boolean);
  };
}

module.exports = { createProviderUpdates, releaseVersion };
