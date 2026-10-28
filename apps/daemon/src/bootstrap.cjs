const { preparePrivateDirectory } = require("@milagre/core/private-files");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { connect } = require("./client.cjs");
const { staleOwner } = require("@milagre/core/ownership");

// A connection that failed this way has no host behind it. ECONNRESET, EPIPE and DAEMON_CLOSED are a host still exiting
// (after a force quit or a crash): its socket accepted the connection, then closed it before the status reply, and which
// of the three the desktop sees depends on whether its request was already written.
const HOST_GONE = ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE", "DAEMON_CLOSED"];

async function compatibleClient(dataDir, timeoutMs = 30000) {
  const client = await connect({ dataDir, timeoutMs });
  try {
    const status = await client.call("daemon:status");
    // result-pages-v1 is optional: an older host still serves the desktop, and fails only on very large Projects.
    const required = ["desktop-v1", "snapshot-pages-v1"];
    if (!required.every((capability) => status.capabilities?.includes(capability)) || !Array.isArray(status.methods)) {
      throw Object.assign(new Error("The running Milagre host is older than this desktop. Stop the host cleanly, then reopen Milagre."), {
        code: "INCOMPATIBLE_DAEMON",
      });
    }
    client.status = status;
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}

function numbers(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  return match ? match.slice(1).map(Number) : null;
}

// A host from another app version is replaced, unless it is certainly newer: an older desktop reusing a newer host keeps
// working while its capabilities allow. A host with no version predates this check.
function hostIsStale(hostVersion, appVersion) {
  if (!hostVersion) return true;
  if (hostVersion === appVersion) return false;
  const host = numbers(hostVersion);
  const app = numbers(appVersion);
  if (!host || !app) return true;
  for (let index = 0; index < 3; index++) if (host[index] !== app[index]) return host[index] < app[index];
  return true;
}

const failure = () =>
  Object.assign(new Error("A previous Milagre host is still running and did not stop. Quit Milagre, then run: pkill -f 'milagre.* serve'"), {
    code: "STALE_DAEMON",
  });

// Stops the host the way an update does (it saves running chats, which the next host resumes), then waits for it to go.
async function stopStaleHost(client, timeoutMs) {
  let timer;
  let onClose;
  const closed = new Promise((resolve, reject) => {
    onClose = resolve;
    client.once("close", onClose);
    timer = setTimeout(() => reject(failure()), timeoutMs);
  });
  try {
    // A failed call is not fatal by itself: another desktop may have stopped the host first. Only the close counts.
    await Promise.all([client.call("daemon:stop").catch(() => {}), closed]);
  } finally {
    clearTimeout(timer);
    client.off("close", onClose);
    client.close();
  }
}

// Only connection establishment is retried. A caller must never replay a command
// that may already have reached the runtime.
async function ensureDaemon({
  dataDir,
  version,
  cwd = process.cwd(),
  worktreeRoot,
  executable = process.execPath,
  entry = path.join(__dirname, "cli.cjs"),
  env = process.env,
  startupTimeoutMs = 15000,
} = {}) {
  if (!path.isAbsolute(dataDir ?? "")) throw new Error("Use an absolute data directory");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") preparePrivateDirectory(dataDir);
  try {
    const existing = await compatibleClient(dataDir);
    // A host whose close failed (closing) still answers but refuses every command: stop it again, which retries its
    // close, rather than reuse it.
    if (!existing.status.closing && !hostIsStale(existing.status.version, version)) return existing;
    await stopStaleHost(existing, startupTimeoutMs);
  } catch (error) {
    if (!HOST_GONE.includes(error.code)) throw error;
  }
  const logPath = path.join(dataDir, "daemon.log");
  let child;
  let launchError;
  // An existing lock may be a concurrent launch; wait for it to listen. One whose owner has certainly exited (a crash)
  // doesn't stop a start: the new host takes it over (see acquireOwnership). It is checked on every wait, since a
  // crashed host can still look alive for a moment while it exits.
  const lockPath = path.join(dataDir, "runtime.lock");
  function launch() {
    if (fs.existsSync(logPath) && !fs.lstatSync(logPath).isFile()) throw new Error(`Daemon log must be a regular file: ${logPath}`);
    const log = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const args = [entry, "serve", "--data-dir", dataDir, "--app-version", version, "--cwd", cwd];
      if (worktreeRoot) args.push("--worktree-root", worktreeRoot);
      child = spawn(executable, args, {
        cwd,
        env: {
          ...env,
          // Electron's Node mode may not expose resourcesPath. Pass the desktop's bundled binaries to its host.
          ...(process.resourcesPath ? { MILAGRE_BUNDLED_BIN_DIR: path.join(process.resourcesPath, "bin") } : {}),
          ELECTRON_RUN_AS_NODE: "1",
        },
        detached: true,
        stdio: ["ignore", log, log],
      });
      child.on("error", (error) => {
        launchError = error;
      });
      child.unref();
    } finally {
      fs.closeSync(log);
    }
  }
  const until = Date.now() + startupTimeoutMs;
  do {
    if (!child && (!fs.existsSync(lockPath) || staleOwner(lockPath))) launch();
    try {
      return await compatibleClient(dataDir);
    } catch (error) {
      if (!HOST_GONE.includes(error.code)) throw error;
    }
    if (launchError) throw launchError;
    await delay(50);
  } while (Date.now() < until);
  throw new Error(`Milagre host could not start. Check ${logPath} and ${path.join(lockPath, "owner.json")}. Never remove a live owner's lock.`);
}

module.exports = { ensureDaemon, compatibleClient, HOST_GONE };
