// @ts-check
// Which update feed this install follows. Lives in userData because the check runs before the renderer loads.
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
const OWNER = "the-ptf";
const REPO = "milagre-ade";
const GITHUB_FEED = { provider: "github", owner: OWNER, repo: REPO, releaseType: "release" };

/**
 * Points the updater at its channel. Stable asks GitHub for the latest release, which is never a draft or a
 * prerelease. Beta reads the feed of `betaFeedUrl` (see resolveBetaFeed); without one it falls back to GitHub's own
 * lookup, which reads the releases atom feed.
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

/** The feed file electron-updater reads for `channel` on `platform`. */
const channelFile = (/** @type {string} */ channel, /** @type {string} */ platform) =>
  platform === "darwin" ? `${channel}-mac.yml` : platform === "linux" ? `${channel}-linux.yml` : `${channel}.yml`;

/** vX.Y.Z or vX.Y.Z-beta.N as numbers; a stable release sorts after every beta of its version. */
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
 * Where beta installs read their update: the newest published release that carries this platform's beta feed file.
 * GitHub's atom feed, which electron-updater reads for prereleases, also lists every tag; the release candidates
 * cut on each main push are tagged drafts with no files, so the updater would read their missing feed and see
 * nothing. The REST API lists published releases only. Resolves to null when none carries the file; rejects when
 * GitHub can't be read.
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
    if (release.draft || !key || !release.assets?.some((asset) => asset.name === file)) continue;
    if (!best || compareKeys(key, best.key) > 0) best = { key, tag: release.tag_name };
  }
  return best ? `https://github.com/${OWNER}/${REPO}/releases/download/${best.tag}` : null;
}

/**
 * Configures the updater for a check on `channel`, resolving the beta feed first. A failed lookup keeps beta on
 * GitHub's own lookup rather than failing the check.
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
