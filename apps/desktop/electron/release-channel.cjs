// @ts-check
const fs = require("node:fs");
const CHANNELS = /** @type {const} */ (["stable", "beta"]);
/**
 * @param {{ file: string }} options
 * @returns {{ get(): "stable" | "beta", set(channel: string): "stable" | "beta" }}
 */
function createReleaseChannelStore({ file }) {
  /** @type {"stable" | "beta"} */
  let channel = "stable";
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")).channel;
    if (saved === "stable" || saved === "beta") channel = saved;
  } catch {}
  return {
    get: () => channel,
    set(next) {
      if (next !== "stable" && next !== "beta") throw new Error(`Unknown release channel: ${next}; one of ${CHANNELS.join(", ")}`);
      fs.writeFileSync(file, JSON.stringify({ channel: next }));
      channel = next;
      return channel;
    },
  };
}
const { owner: OWNER, repo: REPO } = require("@milagre/shared/repository");
const GITHUB_FEED = { provider: "github", owner: OWNER, repo: REPO, releaseType: "release" };

/**
 * @param {{ channel?: string | null, allowPrerelease?: boolean, allowDowngrade?: boolean, setFeedURL(options: object): void }} autoUpdater
 * @param {string} channel
 * @param {string | null} [betaFeedUrl]
 */
function configureUpdater(autoUpdater, channel, betaFeedUrl = null) {
  const beta = channel === "beta";
  autoUpdater.setFeedURL(beta && betaFeedUrl ? { provider: "generic", url: betaFeedUrl, channel: "beta" } : GITHUB_FEED);
  autoUpdater.channel = beta ? "beta" : "latest";
  autoUpdater.allowPrerelease = beta;
  autoUpdater.allowDowngrade = false;
}

const channelFile = (/** @type {string} */ channel, /** @type {string} */ platform) =>
  platform === "darwin" ? `${channel}-mac.yml` : platform === "linux" ? `${channel}-linux.yml` : `${channel}.yml`;

function versionKey(/** @type {string} */ tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(tag);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])];
}
function compareKeys(/** @type {number[]} */ a, /** @type {number[]} */ b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/**
 * @param {{ fetch?: typeof globalThis.fetch, platform?: string }} [options]
 * @returns {Promise<string | null>}
 */
async function resolveBetaFeed({ fetch = globalThis.fetch, platform = process.platform } = {}) {
  const file = channelFile("beta", platform);
  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=30`, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub releases answered ${response.status}`);
  /** @type {{ tag_name: string, draft: boolean, assets?: { name: string }[] }[]} */
  const releases = await response.json();
  let best = null;
  for (const release of releases) {
    const key = versionKey(release.tag_name);
    if (release.draft || !key || key[3] === Infinity || !release.assets?.some((asset) => asset.name === file)) continue;
    if (!best || compareKeys(key, best.key) > 0) best = { key, tag: release.tag_name };
  }
  return best ? `https://github.com/${OWNER}/${REPO}/releases/download/${best.tag}` : null;
}

/**
 * @param {Parameters<typeof configureUpdater>[0]} autoUpdater
 * @param {string} channel
 * @param {Parameters<typeof resolveBetaFeed>[0]} [options]
 */
async function prepareUpdater(autoUpdater, channel, options) {
  const feed = channel === "beta" ? await resolveBetaFeed(options).catch(() => null) : null;
  configureUpdater(autoUpdater, channel, feed);
}

/** @param {any} error */
const isChannelNotPublished = (error) => error?.code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND";
function isNewerRelease(version, current) {
  const next = versionKey(`v${version}`),
    previous = versionKey(`v${current}`);
  return next && previous ? compareKeys(next, previous) > 0 : version !== current;
}
module.exports = { createReleaseChannelStore, configureUpdater, isChannelNotPublished, resolveBetaFeed, prepareUpdater, isNewerRelease };
