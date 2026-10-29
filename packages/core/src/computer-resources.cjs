// A computer's memory and disk, and how much of each Milagre takes: the Devices page, a paired desktop's Computer page
// and the phone's computer page read it, and load balancing will. Bytes throughout.
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// Measuring the folders walks every worktree (about 40 s for 40 GB), so a measure is kept this long.
const DISK_TTL = 30 * 60_000;

function run(file, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, timeout: 120_000 }, (error, stdout) => {
      // du exits 1 when one file can't be read, after printing every total it could.
      if (error && !(allowFailure && stdout)) reject(error);
      else resolve(String(stdout));
    });
  });
}

/**
 * Memory the system can hand out now. os.freemem() leaves out the cached and inactive pages macOS gives back on demand,
 * so it reads near zero on a healthy Mac; the kernel's memory status level is the free share its pressure graph uses.
 */
async function availableMemory(total, { platform = process.platform, exec = run } = {}) {
  if (platform === "darwin") {
    const level = Number((await exec("sysctl", ["-n", "kern.memorystatus_level"]).catch(() => "")).trim());
    if (Number.isFinite(level) && level >= 0 && level <= 100) return Math.round((total * level) / 100);
  }
  return os.freemem();
}

/** `ps -axo pid=,ppid=,rss=,comm=` lines as processes; rss is in KiB. */
function parseProcesses(text) {
  const processes = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]) * 1024, command: match[4].trim() });
  }
  return processes;
}

/**
 * Resident memory of the processes Milagre owns: the app, when this daemon runs inside it (its parent is the same
 * executable), or this daemon alone, with every agent, terminal and server below it. Shared pages count in each
 * process, so it reads a little above Activity Monitor.
 */
function treeMemory(processes, { pid, ppid, execPath }) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const parent = byPid.get(ppid);
  // Linux cuts a command to its first 15 characters.
  const sameExecutable = (command) => Boolean(command) && (command === execPath || path.basename(execPath).startsWith(path.basename(command)));
  const root = parent && ppid > 1 && sameExecutable(parent.command) ? ppid : pid;
  const children = new Map();
  for (const entry of processes) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry.pid);
    children.set(entry.ppid, list);
  }
  let total = 0;
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const next = queue.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    total += byPid.get(next)?.rss ?? 0;
    queue.push(...(children.get(next) ?? []));
  }
  return total;
}

/** The folders Milagre writes: its worktrees and shares under ~/.milagre, and the app's data folder when it sits elsewhere. */
function milagreFolders({ homeDir, dataDir }) {
  const folders = [...new Set([path.join(homeDir, ".milagre"), dataDir].filter(Boolean).map((folder) => path.resolve(folder)))];
  return folders.filter((folder) => !folders.some((other) => folder.startsWith(`${other}${path.sep}`)));
}

/** `du -sk` totals in bytes. */
function parseDu(text) {
  let total = 0;
  for (const line of text.split("\n")) {
    const match = /^(\d+)\s/.exec(line);
    if (match) total += Number(match[1]) * 1024;
  }
  return total;
}

function createComputerResources({
  dataDir,
  homeDir = os.homedir(),
  exec = run,
  statfs = fs.statfs,
  access = fs.access,
  platform = process.platform,
  now = Date.now,
  totalMemory = os.totalmem,
  self = { pid: process.pid, ppid: process.ppid, execPath: process.execPath },
} = {}) {
  let disk = { bytes: null, measuredAt: null };
  let measuring = null;

  function measureDisk() {
    measuring ??= (async () => {
      const folders = [];
      for (const folder of milagreFolders({ homeDir, dataDir }))
        if (
          await access(folder).then(
            () => true,
            () => false,
          )
        )
          folders.push(folder);
      const bytes = folders.length ? parseDu(await exec("du", ["-sk", ...folders], { allowFailure: true })) : 0;
      disk = { bytes, measuredAt: now() };
    })()
      .catch(() => {})
      .finally(() => {
        measuring = null;
      });
    return measuring;
  }

  async function memory() {
    const total = totalMemory();
    const [available, milagre] = await Promise.all([
      availableMemory(total, { platform, exec }),
      platform === "win32"
        ? null
        : exec("ps", ["-axo", "pid=,ppid=,rss=,comm="]).then(
            (text) => treeMemory(parseProcesses(text), self),
            () => null,
          ),
    ]);
    return { total, available: Math.min(available, total), milagre };
  }

  async function space() {
    const stats = await statfs(homeDir);
    return { total: stats.blocks * stats.bsize, available: stats.bavail * stats.bsize };
  }

  return {
    /**
     * What the computer has now. The folders are measured in the background: the first read after a while has
     * `measuring` set and the last measure (or none), and a read a minute later has the new one.
     */
    async read() {
      if (disk.measuredAt === null || now() - disk.measuredAt > DISK_TTL) void measureDisk();
      const [memoryNow, spaceNow] = await Promise.all([memory(), space().catch(() => null)]);
      return {
        memory: memoryNow,
        disk: spaceNow && { ...spaceNow, milagre: disk.bytes, measuredAt: disk.measuredAt, measuring: measuring !== null },
      };
    },
    measureDisk,
  };
}

module.exports = { createComputerResources, availableMemory, parseProcesses, treeMemory, milagreFolders, parseDu, DISK_TTL };
