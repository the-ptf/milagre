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

// What a process is, from its executable's name: an agent, a terminal's shell, or (null) Milagre itself. Linux cuts a
// command to its first 15 characters, so names match by their start.
const KINDS = [
  ["claude", (name) => name === "claude"],
  ["codex", (name) => name.startsWith("codex")],
  ["antigravity", (name) => name.startsWith("agy_acp_server") || name.startsWith("localharness")],
  ["terminals", (name) => /^-?(zsh|bash|fish|sh|nu|pwsh|tcsh|ksh)$/.test(name)],
];
const PART_ORDER = ["claude", "codex", "antigravity", "terminals", "app"];

function kindOf(command) {
  const name = path.basename(command).toLowerCase();
  return KINDS.find(([, matches]) => matches(name))?.[0] ?? null;
}

/**
 * Resident memory of the processes Milagre owns: the app, when this daemon runs inside it (its parent is the same
 * executable), or this daemon alone, with every agent, terminal and server below it. Shared pages count in each
 * process, so it reads a little above Activity Monitor. Each part counts a whole subtree: an agent's shells and MCP
 * servers are that agent's, and everything outside an agent or a terminal is the app. `count` is how many agents or
 * terminals run.
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
  const parts = new Map(PART_ORDER.map((kind) => [kind, { kind, bytes: 0, count: 0 }]));
  let total = 0;
  // Breadth first from the root, so a process takes its nearest-to-root agent or terminal.
  const queue = [[root, null]];
  const seen = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const [next, inherited] = queue[index];
    if (seen.has(next)) continue;
    seen.add(next);
    const entry = byPid.get(next);
    const own = next === root || !entry ? null : kindOf(entry.command);
    const kind = inherited ?? own;
    const part = parts.get(kind ?? "app");
    part.bytes += entry?.rss ?? 0;
    if (!inherited && own) part.count += 1;
    total += entry?.rss ?? 0;
    for (const child of children.get(next) ?? []) queue.push([child, kind]);
  }
  return { total, parts: [...parts.values()].filter((part) => part.bytes > 0) };
}

/** The folders Milagre writes: its worktrees and shares under ~/.milagre, and the app's data folder when it sits elsewhere. */
function milagreFolders({ homeDir, dataDir }) {
  const folders = [...new Set([path.join(homeDir, ".milagre"), dataDir].filter(Boolean).map((folder) => path.resolve(folder)))];
  return folders.filter((folder) => !folders.some((other) => folder.startsWith(`${other}${path.sep}`)));
}

/**
 * `du -k -d 3` over Milagre's folders, in bytes: the folders' total, the worktrees folder's size and how many
 * worktrees it holds (one level of Projects, then one folder per worktree).
 */
function parseDu(text, { folders, worktrees }) {
  let total = 0;
  let worktreeBytes = 0;
  let count = 0;
  for (const line of text.split("\n")) {
    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const bytes = Number(match[1]) * 1024;
    const folder = path.resolve(match[2]);
    if (folders.includes(folder)) total += bytes;
    else if (folder === worktrees) worktreeBytes = bytes;
    else if (path.dirname(path.dirname(folder)) === worktrees) count += 1;
  }
  return {
    total,
    parts: [
      { kind: "worktrees", bytes: Math.min(worktreeBytes, total), count },
      { kind: "data", bytes: Math.max(total - worktreeBytes, 0), count: 0 },
    ].filter((part) => part.bytes > 0),
  };
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
  let disk = { bytes: null, parts: null, measuredAt: null };
  const worktrees = path.join(homeDir, ".milagre", "worktrees");
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
      const measured = folders.length
        ? parseDu(await exec("du", ["-k", "-d", "3", ...folders], { allowFailure: true }), { folders, worktrees })
        : { total: 0, parts: [] };
      disk = { bytes: measured.total, parts: measured.parts, measuredAt: now() };
    })()
      .catch(() => {})
      .finally(() => {
        measuring = null;
      });
    return measuring;
  }

  async function memory() {
    const total = totalMemory();
    const [available, tree] = await Promise.all([
      availableMemory(total, { platform, exec }),
      platform === "win32"
        ? null
        : exec("ps", ["-axo", "pid=,ppid=,rss=,comm="]).then(
            (text) => treeMemory(parseProcesses(text), self),
            () => null,
          ),
    ]);
    return { total, available: Math.min(available, total), milagre: tree?.total ?? null, parts: tree?.parts ?? null };
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
        disk: spaceNow && { ...spaceNow, milagre: disk.bytes, parts: disk.parts, measuredAt: disk.measuredAt, measuring: measuring !== null },
      };
    },
    measureDisk,
  };
}

module.exports = { createComputerResources, availableMemory, parseProcesses, treeMemory, milagreFolders, parseDu, DISK_TTL };
