const { powershell, powershellEnvironment } = require("./private-files.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");

// When a live process with this pid started, or null when there is none (or it can't be read).
function processStartTime(pid, { platform = process.platform, execFileSyncImpl = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "win32") {
      const script = `[Console]::Write((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o'))`;
      const started = execFileSyncImpl(
        powershell(),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { env: powershellEnvironment(), encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      const time = Date.parse(started);
      return Number.isNaN(time) ? null : time;
    }
    const started = execFileSyncImpl("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const time = Date.parse(started);
    return Number.isNaN(time) ? null : time;
  } catch {
    return null;
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

// A lock is stale only when its owner is certainly gone: no process has its pid, or the one that does started after
// the owner did (the pid was reused). Anything unclear (no readable record, another computer's record, a start time
// that can't be read) counts as live: a live owner's lock is never removed.
function staleOwner(lockPath) {
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return null;
  }
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null;
  if (owner.host !== undefined && owner.host !== os.hostname()) return null;
  const startedAt = Date.parse(owner.processStartedAt ?? owner.startedAt);
  if (Number.isNaN(startedAt)) return null;
  if (alive(owner.pid)) {
    // ps reports whole seconds, rounded down, so a reused pid started within the owner's own second still counts as live.
    const running = processStartTime(owner.pid);
    if (running === null || running <= startedAt) return null;
  }
  return owner;
}

// An owner writes its record right after making the lock, so an empty lock older than a minute was left by a crash
// between the two (or during a release) and has no owner to protect.
function abandoned(lockPath) {
  try {
    return fs.readdirSync(lockPath).length === 0 && Date.now() - fs.statSync(lockPath).mtimeMs > 60_000;
  } catch {
    return false;
  }
}

// Removes a stale lock. A second directory makes the takeover itself exclusive, so two processes that both found the
// lock stale can't remove the one the other has just taken. A takeover left behind by a crash expires after a minute.
function clearStale(lockPath) {
  const takeover = `${lockPath}.takeover`;
  try {
    fs.mkdirSync(takeover, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      if (Date.now() - fs.statSync(takeover).mtimeMs > 60_000) fs.rmdirSync(takeover);
    } catch {}
    return false;
  }
  try {
    // Read again inside the takeover: the lock may have changed hands since it was first found stale.
    if (!staleOwner(lockPath) && !abandoned(lockPath)) return false;
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } finally {
    fs.rmdirSync(takeover);
  }
}

// mkdir is the atomic ownership decision. A lock left by an owner that has certainly exited (see staleOwner) is taken
// over; any other existing lock stays, and its path is reported for the operator.
function acquireOwnership(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!clearStale(lockPath))
      throw new Error(
        `Milagre state is already owned. Close its other runtime. If it crashed, verify the process in ${path.join(lockPath, "owner.json")} has exited before removing ${lockPath}.`,
        { cause: error },
      );
    return acquireOwnership(lockPath);
  }
  const owner = {
    pid: process.pid,
    token: randomUUID(),
    startedAt: new Date().toISOString(),
    processStartedAt: new Date(performance.timeOrigin).toISOString(),
    host: os.hostname(),
  };
  const file = path.join(lockPath, "owner.json");
  try {
    fs.writeFileSync(file, JSON.stringify(owner, null, 2), { mode: 0o600, flag: "wx" });
  } catch (error) {
    fs.rmSync(lockPath, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      let current;
      try {
        current = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        // The record is already gone (removed by hand or by a cleanup), so there is no ownership left to give up.
        // Throwing here would fail the host's close forever. The empty lock is left for abandoned() to take over:
        // removing it could race a new owner that made the directory but has not written its record yet.
        released = true;
        return;
      }
      if (current.token !== owner.token) throw new Error(`Milagre ownership changed: ${lockPath}`);
      fs.unlinkSync(file);
      fs.rmdirSync(lockPath);
      released = true;
    },
  };
}

module.exports = { acquireOwnership, staleOwner, processStartTime };
