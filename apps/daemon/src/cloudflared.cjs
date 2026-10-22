const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

// Update the release and its artifact hashes together. Never execute an unverified download.
const VERSION = "2026.10.0";
const ARTIFACTS = {
  "darwin-x64": {
    name: "cloudflared-darwin-amd64.tgz",
    sha256: "903845b81828c8cb3c5d13d816a2de71c06a3da5785469df8eb0e1b736d92f9f",
    binarySha256: "0560c9ab7281ac3f746055323623ed23bc0405b6dab9400474020cba33a978da",
  },
  "darwin-arm64": {
    name: "cloudflared-darwin-arm64.tgz",
    sha256: "a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70",
    binarySha256: "72edfd3eea463aef4d5cb89e2e209cecb048cc756c2b01915de2e0ad7cb39830",
  },
  "linux-x64": { name: "cloudflared-linux-amd64", sha256: "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db" },
  "linux-arm64": { name: "cloudflared-linux-arm64", sha256: "e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08" },
  "win32-x64": { name: "cloudflared-windows-amd64.exe", sha256: "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c" },
};
function artifactFor(platform, arch) {
  const artifact = ARTIFACTS[`${platform}-${arch}`];
  if (!artifact) throw new Error(`Phone access is not supported on ${platform}/${arch}.`);
  return artifact;
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const installing = new Map();

async function installCloudflared({
  target,
  artifact,
  download = async () => {
    const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${artifact.name}`, {
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  },
}) {
  // Concurrent tunnel starts in this host share one install; failed attempts can be retried.
  if (installing.has(target)) return installing.get(target);
  const work = (async () => {
    try {
      if (hash(await fs.readFile(target)) === (artifact.binarySha256 ?? artifact.sha256)) {
        await fs.chmod(target, 0o700);
        return target;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = await fs.mkdtemp(path.join(path.dirname(target), ".cloudflared-"));
    try {
      const bytes = await download();
      if (hash(bytes) !== artifact.sha256) throw new Error("cloudflared download checksum mismatch.");
      let executable = bytes;
      if (artifact.name.endsWith(".tgz")) {
        const archive = path.join(temporary, "download.tgz");
        await fs.writeFile(archive, bytes, { mode: 0o600 });
        await promisify(execFile)("/usr/bin/tar", ["-xzf", archive, "-C", temporary, "cloudflared"]);
        executable = await fs.readFile(path.join(temporary, "cloudflared"));
        if (hash(executable) !== artifact.binarySha256) throw new Error("cloudflared executable checksum mismatch.");
      }
      const staged = path.join(temporary, "verified");
      await fs.writeFile(staged, executable, { mode: 0o700 });
      await fs.rename(staged, target);
      return target;
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  })();
  installing.set(target, work);
  try {
    return await work;
  } finally {
    installing.delete(target);
  }
}

async function ensureCloudflared({
  platform = process.platform,
  arch = process.arch,
  bundledDir = process.env.MILAGRE_BUNDLED_BIN_DIR ?? (process.resourcesPath ? path.join(process.resourcesPath, "bin") : undefined),
  cacheDir = path.join(os.homedir(), ".milagre", "bin"),
  artifact,
  download,
} = {}) {
  const filename = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  if (bundledDir) {
    const bundled = path.join(bundledDir, filename);
    try {
      // macOS signing changes the binary hash. The signed app protects its bundled copy.
      if ((await fs.stat(bundled)).isFile()) {
        await fs.access(bundled, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return bundled;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  try {
    return await installCloudflared({
      target: path.join(cacheDir, VERSION, `${platform}-${arch}`, filename),
      artifact: artifact ?? artifactFor(platform, arch),
      download,
    });
  } catch (error) {
    throw new Error(`Milagre couldn't prepare phone access: ${error.message} Try enabling phone access again.`, { cause: error });
  }
}
module.exports = { ensureCloudflared, installCloudflared, artifactFor };
