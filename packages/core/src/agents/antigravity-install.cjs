const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// Milagre installs Google's Antigravity ACP agent itself (docs/providers.md): a zip of two files,
// the agent (`agy_acp_server.par`, `agy_acp_server.exe` on Windows) and `localharness_external` (`.exe` on
// Windows), which the agent starts on its own. Each release is pinned here with the size and SHA-256 of its
// archive, so a download is only ever kept when it is byte for byte the one that was checked. The ACP registry
// lists every platform's URL but publishes no hashes, so only a platform whose archive was downloaded and
// hashed by hand is listed (the same hashes T3 Code pins). Others are unsupported rather than guessed at.
//
//   <data dir>/tools/antigravity/<platform>-<arch>/versions/<sha256>/   the two files
//   <data dir>/tools/antigravity/<platform>-<arch>/active.json          which version runs

const AGENT_NAME = "antigravity-acp";
const COMMAND = "agy_acp_server.par";
const HARNESS = "localharness_external";
const OVERRIDE_ENV = "MILAGRE_ANTIGRAVITY_PATH";
const VALIDATE_TIMEOUT_MS = 90_000;

// The agent's own names per platform: Windows archives hold `.exe` files, the others a Python archive and a binary.
const WINDOWS_COMMAND = "agy_acp_server.exe";
const WINDOWS_HARNESS = "localharness_external.exe";
const memberNames = (platform = process.platform) =>
  platform === "win32" ? { command: WINDOWS_COMMAND, harness: WINDOWS_HARNESS } : { command: COMMAND, harness: HARNESS };

// Linux's agent needs `--uid=` (docs/providers.md); the other platforms start it without arguments.
const LINUX_ARGS = Object.freeze(["--uid="]);
const argsFor = (platform = process.platform) => (platform === "linux" ? LINUX_ARGS : Object.freeze([]));

const RELEASE_VERSION = "1.3.0";
const BASE = "https://dl.google.com/agy-extensions/releases";
const pin = ({ platform, os, file, bytes, sha256, command, harness }) =>
  Object.freeze({
    version: RELEASE_VERSION,
    url: `${BASE}/${os}/agy-acp-server-${RELEASE_VERSION}-${file}.zip`,
    bytes,
    sha256,
    args: argsFor(platform),
    // Exactly these entries, with exactly these unpacked sizes.
    files: Object.freeze({ [memberNames(platform).command]: command, [memberNames(platform).harness]: harness }),
  });

// Keys are Node's `${process.platform}-${process.arch}`; URLs are the registry's (its names are x86_64 and arm64).
const RELEASES = Object.freeze({
  "darwin-arm64": pin({
    platform: "darwin",
    os: "macos",
    file: "darwin-arm64",
    bytes: 111_456_962,
    sha256: "7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88",
    command: 278_535_456,
    harness: 118_611_392,
  }),
  "darwin-x64": pin({
    platform: "darwin",
    os: "macos",
    file: "darwin-x86_64",
    bytes: 117_245_544,
    sha256: "bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646",
    command: 282_840_688,
    harness: 124_175_392,
  }),
  "linux-x64": pin({
    platform: "linux",
    os: "linux",
    file: "linux-x86_64",
    bytes: 333_727_150,
    sha256: "9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96",
    command: 926_533_965,
    harness: 130_388_040,
  }),
  "linux-arm64": pin({
    platform: "linux",
    os: "linux",
    file: "linux-arm64",
    bytes: 321_690_363,
    sha256: "500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf",
    command: 930_848_992,
    harness: 123_224_968,
  }),
  "win32-x64": pin({
    platform: "win32",
    os: "windows",
    file: "windows-x86_64",
    bytes: 124_509_787,
    sha256: "65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9",
    command: 81_437_336,
    harness: 145_548_952,
  }),
  "win32-arm64": pin({
    platform: "win32",
    os: "windows",
    file: "windows-arm64",
    bytes: 124_654_803,
    sha256: "4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3",
    command: 85_893_472,
    harness: 135_640_216,
  }),
});

const SHA256 = /^[0-9a-f]{64}$/;
const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;

// Variables that would make the agent use another account or storage than the profile it is given.
const AMBIENT_ENV = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "ANTIGRAVITY_HARNESS_PATH",
  "BROWSER",
  "PYTHONUNBUFFERED",
  "ELECTRON_RUN_AS_NODE",
];

const unlink = (file) => fs.promises.rm(file, { force: true });
const rmDir = (dir) => fs.promises.rm(dir, { recursive: true, force: true });

function writeJsonAtomic(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

// A minimal JSON-RPC `initialize` against the unpacked agent. It must answer as Antigravity at the pinned
// version. The agent unpacks large files into TMPDIR on launch, so it gets the staging folder, and a
// GEMINI_HOME of its own so ~/.gemini is never touched.
function validateAgent({ command, harness, args, cwd, version, timeoutMs = VALIDATE_TIMEOUT_MS, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const name of AMBIENT_ENV) delete env[name];
    Object.assign(env, {
      GEMINI_HOME: path.join(cwd, "profile"),
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      PYTHONUNBUFFERED: "1",
      TMPDIR: path.join(cwd, "tmp"),
      ANTIGRAVITY_HARNESS_PATH: harness,
    });
    fs.mkdirSync(env.TMPDIR, { recursive: true });
    fs.mkdirSync(env.GEMINI_HOME, { recursive: true, mode: 0o700 });
    let child;
    try {
      child = spawnImpl(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (error) {
      reject(new Error(`Antigravity didn't start: ${error.message}`));
      return;
    }
    let settled = false;
    let buffer = "";
    let stderr = "";
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Antigravity didn't answer its first request in time.")), timeoutMs);
    timer.unref?.();
    child.on("error", (error) => finish(new Error(`Antigravity didn't start: ${error.message}`)));
    child.on("exit", (code, signal) =>
      finish(
        new Error(
          `Antigravity stopped before answering${signal ? ` (signal ${signal})` : code ? ` (exit ${code})` : ""}${stderr.trim() ? `: ${stderr.trim().split("\n").at(-1)}` : ""}.`,
        ),
      ),
    );
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message?.id !== 1) continue;
        const info = message.result?.agentInfo;
        if (info?.name !== AGENT_NAME) finish(new Error(`The download isn't Antigravity (it answered as "${info?.name ?? "nothing"}").`));
        else if (info.version !== version) finish(new Error(`Expected Antigravity ${version}, but the download is ${info.version ?? "of unknown version"}.`));
        else finish();
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientInfo: { name: "milagre", title: "Milagre", version: "install-check" }, clientCapabilities: {} },
      })}\n`,
    );
  });
}

// Streams the archive to `file`, counting and hashing the decoded bytes (fetch undoes any gzip). Resolves
// when exactly `release.bytes` bytes with the pinned SHA-256 arrived.
async function download(release, file, { signal, onProgress, fetchImpl = fetch }) {
  const response = await fetchImpl(release.url, { signal, redirect: "follow", headers: { "user-agent": "milagre" } });
  if (!response.ok || !response.body) throw new Error(`Downloading Antigravity failed (HTTP ${response.status}).`);
  const hash = crypto.createHash("sha256");
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      if (received > release.bytes) {
        done(new Error("The Antigravity download is larger than expected."));
        return;
      }
      hash.update(chunk);
      onProgress?.({ phase: "download", received, total: release.bytes });
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(file, { mode: 0o600 }), { signal });
  if (received !== release.bytes) throw new Error("The Antigravity download is incomplete.");
  if (hash.digest("hex") !== release.sha256) throw new Error("The Antigravity download doesn't match its checksum, so it was discarded.");
}

const run = (file, args, options = {}, execFileImpl = execFile) =>
  new Promise((resolve, reject) => {
    execFileImpl(file, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error)
        reject(
          new Error(
            String(stderr || error.message)
              .trim()
              .split("\n")
              .at(-1) || error.message,
          ),
        );
      else resolve(String(stdout));
    });
  });

// The tool that lists and unpacks a zip. macOS and most Linux systems have `unzip`; Windows has no unzip, but
// since Windows 10 it ships bsdtar as System32\tar.exe, which reads zip archives.
function archiveCommands(platform, archive, into, { env = process.env, exists = fs.existsSync } = {}) {
  if (platform === "win32") {
    const file = path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "tar.exe");
    return { file, list: ["-tf", archive], extract: ["-xf", archive, "-C", into] };
  }
  const file = ["/usr/bin/unzip", "/bin/unzip", "/usr/local/bin/unzip"].find((candidate) => exists(candidate)) ?? "/usr/bin/unzip";
  return { file, list: ["-Z1", archive], extract: ["-q", "-o", archive, "-d", into] };
}

// Unpacks the archive into `into`, which must start empty. The listing must be exactly the expected files
// (so a name can never carry a path), they are unpacked by the system's zip tool, and their sizes are checked
// afterwards; anything that isn't a plain file of the expected size is refused.
async function extract(release, archive, into, { execFileImpl, platform = process.platform, env = process.env } = {}) {
  const tool = archiveCommands(platform, archive, into, { env });
  const names = (await run(tool.file, tool.list, { windowsHide: true }, execFileImpl))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .toSorted();
  const expected = Object.keys(release.files).toSorted();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index]))
    throw new Error("The Antigravity download has unexpected contents, so it was discarded.");
  await run(tool.file, tool.extract, { windowsHide: true }, execFileImpl);
  for (const [name, size] of Object.entries(release.files)) {
    const stat = fs.lstatSync(path.join(into, name));
    if (!stat.isFile() || stat.size !== size) throw new Error(`${name} in the Antigravity download has the wrong size, so it was discarded.`);
    fs.chmodSync(path.join(into, name), 0o755);
  }
  const extra = fs.readdirSync(into).filter((name) => !(name in release.files));
  if (extra.length) throw new Error("The Antigravity download has unexpected contents, so it was discarded.");
}

// One install at a time per tools folder, however many installers point at it.
const running = new Map();

/**
 * @param {object} options
 * @param {string} options.dataDir  the host data directory
 * @param {Record<string, object>} [options.releases]  the pinned table (tests inject their own)
 */
function createAntigravity({
  dataDir,
  releases = RELEASES,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  validate = validateAgent,
  fetchImpl,
  execFileImpl,
} = {}) {
  const key = platformKey(platform, arch);
  const root = path.join(dataDir, "tools", "antigravity", key);
  const activeFile = path.join(root, "active.json");
  const release = Object.hasOwn(releases, key) ? releases[key] : null;
  const names = memberNames(platform);

  function fromFolder(folder, extra) {
    const command = path.join(folder, names.command);
    const harness = path.join(folder, names.harness);
    if (!isExecutableFile(command) || !isExecutableFile(harness)) return null;
    return { command, harness, args: release?.args ?? argsFor(platform), ...extra };
  }

  /** { command, harness, args, version, source } for the agent Milagre can run, or null. */
  function resolve() {
    const override = env[OVERRIDE_ENV];
    if (override) {
      // The path of the agent (.par, .exe on Windows); its harness sits beside it. A wrong path counts as not installed.
      const found = fromFolder(path.dirname(path.resolve(override)), { version: null, source: "env" });
      return found && path.basename(override) === names.command ? { ...found, command: path.resolve(override) } : null;
    }
    try {
      const active = JSON.parse(fs.readFileSync(activeFile, "utf8"));
      if (typeof active?.sha256 !== "string" || !SHA256.test(active.sha256) || typeof active.version !== "string") return null;
      return fromFolder(path.join(root, "versions", active.sha256), { version: active.version, sha256: active.sha256, source: "install" });
    } catch {
      return null;
    }
  }

  const supported = () => release !== null;
  /** The release this Milagre installs, or null when the platform has none. */
  const pinned = () => (release ? { version: release.version, sha256: release.sha256, bytes: release.bytes } : null);
  /** True when nothing runs yet, or what runs isn't the pinned release. An env override is never replaced. */
  function updateAvailable() {
    if (!release || env[OVERRIDE_ENV]) return false;
    return resolve()?.sha256 !== release.sha256;
  }

  async function installNow({ signal, onProgress }) {
    if (!release) throw new Error(`Antigravity isn't available for ${platform} ${arch} yet.`);
    if (env[OVERRIDE_ENV]) throw new Error(`${OVERRIDE_ENV} is set, so Antigravity is not managed by Milagre.`);
    const target = path.join(root, "versions", release.sha256);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    // Leftovers of an install that was interrupted.
    for (const name of fs.readdirSync(root)) if (name.startsWith("staging-")) await rmDir(path.join(root, name));
    const staging = path.join(root, `staging-${crypto.randomBytes(6).toString("hex")}`);
    fs.mkdirSync(staging, { mode: 0o700 });
    try {
      const existing = fromFolder(target, {});
      if (!existing) {
        const archive = path.join(staging, "archive.zip");
        await download(release, archive, { signal, onProgress, fetchImpl });
        onProgress?.({ phase: "extract" });
        const unpacked = path.join(staging, "files");
        fs.mkdirSync(unpacked, { mode: 0o700 });
        await extract(release, archive, unpacked, { execFileImpl, platform, env });
        await unlink(archive);
        onProgress?.({ phase: "validate" });
        signal?.throwIfAborted();
        await validate({
          command: path.join(unpacked, names.command),
          harness: path.join(unpacked, names.harness),
          args: release.args,
          cwd: staging,
          version: release.version,
        });
        // The validation run left its own folders beside the files.
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await rmDir(target);
        fs.renameSync(unpacked, target);
      }
      writeJsonAtomic(activeFile, { version: release.version, sha256: release.sha256 });
      // Older versions are not needed any more.
      const versions = path.join(root, "versions");
      for (const name of fs.readdirSync(versions)) if (name !== release.sha256) await rmDir(path.join(versions, name));
      onProgress?.({ phase: "done" });
      return { version: release.version, changed: !existing };
    } finally {
      await rmDir(staging);
    }
  }

  /**
   * Downloads, checks, unpacks and validates the pinned release, then makes it the active one. Calls made
   * while an install runs wait for that one. Throws an Error whose message is meant for the user.
   * `onProgress` gets { phase: "download", received, total }, then { phase: "extract" | "validate" | "done" }.
   */
  function install({ onProgress, signal } = {}) {
    const current = running.get(root);
    if (current) {
      current.listeners.add(onProgress);
      return current.promise;
    }
    const entry = { listeners: new Set([onProgress]) };
    entry.promise = installNow({
      signal,
      onProgress: (event) => {
        for (const listener of entry.listeners) {
          try {
            listener?.(event);
          } catch {}
        }
      },
    }).finally(() => running.delete(root));
    running.set(root, entry);
    return entry.promise;
  }

  return { resolve, install, supported, pinned, updateAvailable, root, platform: key };
}

// The profile directory's token marks a signed-in account; the file holds secrets and is never read.
const tokenFile = (home) => path.join(home, AGENT_NAME, "acp_token.json");
const hasToken = (home) => fs.existsSync(tokenFile(home));

module.exports = {
  AGENT_NAME,
  AMBIENT_ENV,
  COMMAND,
  HARNESS,
  OVERRIDE_ENV,
  RELEASES,
  archiveCommands,
  argsFor,
  createAntigravity,
  hasToken,
  memberNames,
  platformKey,
  tokenFile,
  validateAgent,
};
