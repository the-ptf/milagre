const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PACKAGES = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };
const LOOKUP_TIMEOUT_MS = 8000;

/**
 * How a CLI got onto this computer, read from where its binary really lives. Homebrew owns the file on PATH for its
 * casks and formulae, so npm can't overwrite it and the update has to come from Homebrew, at Homebrew's version.
 */
function installChannel(name, command, { realpath = fs.realpathSync, platform = process.platform, home = os.homedir() } = {}) {
  if (!command || platform === "win32") return { kind: "other" };
  let real = command;
  try {
    real = realpath(command);
  } catch {}
  const cask = real.match(/^(.*)\/Caskroom\/([^/]+)\//);
  if (cask) return { kind: "homebrew-cask", token: cask[2], brew: path.join(cask[1], "bin", "brew") };
  const formula = real.match(/^(.*)\/Cellar\/([^/]+)\//);
  if (formula) return { kind: "homebrew-formula", token: formula[2], brew: path.join(formula[1], "bin", "brew") };
  if (PACKAGES[name] && real.includes(`/node_modules/${PACKAGES[name]}/`)) return { kind: "npm" };
  if (name === "claude" && real.startsWith(path.join(home, ".local/share/claude/"))) return { kind: "installer" };
  return { kind: "other" };
}

const isHomebrew = (channel) => channel?.kind === "homebrew-cask" || channel?.kind === "homebrew-formula";
const brewArgs = (channel) => (channel.kind === "homebrew-cask" ? ["upgrade", "--cask", channel.token] : ["upgrade", channel.token]);

/** The command a person would type for this update, shown while it runs and offered when it fails. */
function updateCommand(name, channel) {
  if (isHomebrew(channel)) return ["brew", ...brewArgs(channel)].join(" ");
  if (name === "claude") return "claude install latest";
  if (name === "codex") return "codex update";
  return null;
}

// Homebrew's cask page names the macOS arm64 download first; Intel Macs and Linux get theirs from `variations`.
function caskUrl(cask, platform, arch) {
  const variations = cask.variations || {};
  if (platform === "linux") return variations[`${arch === "arm64" ? "arm64" : "x86_64"}_linux`]?.url ?? null;
  if (platform !== "darwin") return null;
  if (arch === "arm64") return cask.url ?? null;
  const intel = Object.entries(variations).find(([key, value]) => !key.includes("linux") && !key.startsWith("arm64") && value?.url);
  return intel ? intel[1].url : null;
}

/** The newest release this channel would install: Homebrew's own version for a Homebrew install, npm's otherwise. */
async function channelRelease(name, channel, { fetchImpl = fetch, platform = process.platform, arch = process.arch } = {}) {
  const signal = AbortSignal.timeout(LOOKUP_TIMEOUT_MS);
  if (isHomebrew(channel)) {
    const kind = channel.kind === "homebrew-cask" ? "cask" : "formula";
    const response = await fetchImpl(`https://formulae.brew.sh/api/${kind}/${encodeURIComponent(channel.token)}.json`, { signal });
    if (!response.ok) throw new Error("Release lookup failed");
    const body = await response.json();
    const version = String((kind === "cask" ? body.version : body.versions?.stable) ?? "").split(",")[0];
    return { version, url: kind === "cask" ? caskUrl(body, platform, arch) : null };
  }
  const response = await fetchImpl(`https://registry.npmjs.org/${PACKAGES[name]}/latest`, { signal });
  if (!response.ok) throw new Error("Release lookup failed");
  const { version } = await response.json();
  return { version, url: null };
}

function brewCacheDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.HOMEBREW_CACHE) return env.HOMEBREW_CACHE;
  if (platform === "darwin") return path.join(home, "Library", "Caches", "Homebrew");
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "Homebrew");
}

async function downloadSize(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    const total = Number(response.headers.get("content-length"));
    return response.ok && total > 0 ? total : null;
  } catch {
    return null;
  }
}

/**
 * Homebrew prints no progress when it isn't on a terminal, but it downloads into `<cache>/downloads/<hash>--<file>.incomplete`
 * and renames the file when done. Reports that file's size against the release's, then `install` once it is renamed.
 */
function watchBrewDownload({ url, total, onProgress, cacheDir = brewCacheDir(), interval = 250, fsImpl = fs, now = Date.now }) {
  const suffix = `--${path.basename(new URL(url).pathname)}.incomplete`;
  const dir = path.join(cacheDir, "downloads");
  const since = now() - 1000;
  let seen = false;
  let installing = false;
  const timer = setInterval(() => {
    if (installing) return;
    let size = null;
    try {
      for (const entry of fsImpl.readdirSync(dir)) {
        if (!entry.endsWith(suffix)) continue;
        const stat = fsImpl.statSync(path.join(dir, entry));
        if (stat.mtimeMs >= since) size = Math.max(size ?? 0, stat.size);
      }
    } catch {}
    if (size !== null) {
      seen = true;
      onProgress({ phase: "download", received: Math.min(size, total), total });
    } else if (seen) {
      installing = true;
      onProgress({ phase: "install" });
    }
  }, interval);
  return () => clearInterval(timer);
}

module.exports = { installChannel, isHomebrew, brewArgs, updateCommand, channelRelease, caskUrl, brewCacheDir, downloadSize, watchBrewDownload };
