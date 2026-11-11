// A computer's memory and disk, and how much of each Milagre takes: the Devices page, a paired desktop's Computer page
// and the phone's computer page read it, and load balancing will. Bytes throughout. Nothing here leaves the host but
// numbers and fixed category names: no path, project or command line.
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

// Measuring the folders walks every worktree (about 45 s for 54 GB), so a measure is kept this long.
const DISK_TTL = 30 * 60_000;
// A measure that failed (no du, killed at its timeout) waits this long before the next try, instead of every read.
const DISK_RETRY = 5 * 60_000;

/**
 * Runs a command for its output. `allowFailure` accepts the output of a command that exited non-zero on its own (du
 * exits 1 when one file can't be read, after printing every total it could); a command killed by its timeout, a signal
 * or the output limit always fails, since what it printed is cut short.
 */
function run(file, args, { allowFailure = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, timeout: 120_000, signal }, (error, stdout) => {
      const cutShort = error && (error.killed || error.signal || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || error.name === "AbortError");
      if (error && (cutShort || !allowFailure || !stdout)) reject(error);
      else resolve(String(stdout));
    });
  });
}

/**
 * Memory the system can hand out now. os.freemem() leaves out the cache the system gives back on demand, so it reads
 * near zero on a healthy Mac and low on Linux: macOS has the kernel's memory status level (the free share its pressure
 * graph uses), Linux has MemAvailable.
 */
async function availableMemory(total, { platform = process.platform, exec = run, readFile = fs.readFile } = {}) {
  if (platform === "darwin") {
    const text = (await exec("sysctl", ["-n", "kern.memorystatus_level"]).catch(() => "")).trim();
    const level = text === "" ? Number.NaN : Number(text);
    if (Number.isFinite(level) && level >= 0 && level <= 100) return Math.round((total * level) / 100);
  }
  if (platform === "linux") {
    const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => "");
    const kib = Number(/^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo)?.[1]);
    if (Number.isFinite(kib)) return kib * 1024;
  }
  return os.freemem();
}

/** `ps -axww -o pid=,ppid=,rss=,args=` lines as processes; rss is in KiB, `args` the whole command line. */
function parseProcesses(text) {
  const processes = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) processes.push({ pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]) * 1024, args: match[4].trim() });
  }
  return processes;
}

// What a process is, from its command line: an agent, a terminal's shell, or (null) Milagre itself. The whole line,
// because an agent can run under its interpreter (Antigravity's .par under Python, an npm Claude Code under node).
const KINDS = [
  ["claude", /(^|\/)claude(\s|$)|@anthropic-ai\/claude-code\//],
  ["codex", /(^|\/)codex[\w-]*(\s|$)|@openai\/codex\//],
  ["antigravity", /agy_acp_server|localharness/],
  ["kiro", /(^|\/)kiro-cli-chat(\s|$)/],
];
const SHELL = /^-?(zsh|bash|fish|sh|nu|pwsh|tcsh|ksh)$/;
const PART_ORDER = ["claude", "codex", "antigravity", "kiro", "terminals", "app"];

function kindOf(args) {
  const agent = KINDS.find(([, pattern]) => pattern.test(args))?.[0];
  if (agent) return agent;
  return SHELL.test(path.basename(args.split(/\s/, 1)[0] ?? "")) ? "terminals" : null;
}

/**
 * Resident memory of the processes Milagre owns: the app, when this daemon runs inside it (its parent is the same
 * executable), or this daemon alone, with every agent, terminal and server below it. When the app is a bundle
 * (Milagre.app), its processes count too after the daemon outlived an earlier app and the new one isn't its parent.
 * Shared pages count in each process, so it reads a little above Activity Monitor. Each part counts a whole subtree:
 * an agent's shells and MCP servers are that agent's, and everything outside an agent or a terminal is the app.
 * `count` is how many agents or terminals run.
 */
function treeMemory(processes, { pid, execPath }) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  // The parent as this snapshot has it: the daemon's own ppid can be stale, or a reused pid, after the app quits.
  const ppid = byPid.get(pid)?.ppid ?? 0;
  const parent = byPid.get(ppid);
  const sameExecutable = (args) => args.startsWith(execPath);
  const roots = [parent && ppid > 1 && sameExecutable(parent.args) ? ppid : pid];
  const bundle = /^(.*?\.app)\//.exec(execPath)?.[1];
  if (bundle)
    for (const entry of processes) if (entry.args.startsWith(`${bundle}/`) && !byPid.get(entry.ppid)?.args.startsWith(`${bundle}/`)) roots.push(entry.pid);
  const children = new Map();
  for (const entry of processes) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry.pid);
    children.set(entry.ppid, list);
  }
  const parts = new Map(PART_ORDER.map((kind) => [kind, { kind, bytes: 0, count: 0 }]));
  let total = 0;
  // Breadth first from the roots, so a process takes its nearest-to-root agent or terminal.
  const queue = roots.map((root) => [root, null, true]);
  const seen = new Set();
  for (let index = 0; index < queue.length; index += 1) {
    const [next, inherited, isRoot] = queue[index];
    if (seen.has(next)) continue;
    seen.add(next);
    const entry = byPid.get(next);
    if (!entry) continue;
    const own = isRoot ? null : kindOf(entry.args);
    const kind = inherited ?? own;
    const part = parts.get(kind ?? "app");
    part.bytes += entry.rss;
    if (!inherited && own) part.count += 1;
    total += entry.rss;
    for (const child of children.get(next) ?? []) queue.push([child, kind, false]);
  }
  return { total, parts: [...parts.values()].filter((part) => part.bytes > 0) };
}

/** The folders Milagre writes: ~/.milagre, the worktrees wherever they live, and the app's data folder. */
function milagreFolders({ homeDir, dataDir, worktreeRoot }) {
  const folders = [...new Set([path.join(homeDir, ".milagre"), worktreeRoot, dataDir].filter(Boolean).map((folder) => path.resolve(folder)))];
  return folders.filter((folder) => !folders.some((other) => folder.startsWith(`${other}${path.sep}`)));
}

// What a folder right inside the app's data folder holds, by its name. Anything not named here is the app's other data.
const DATA_KINDS = Object.freeze({
  checkpoints: "checkpoints",
  Partitions: "browser",
  dictation: "speech",
  accounts: "agents",
  tools: "agents",
  artifacts: "designs",
  "design-kits": "designs",
  "design-page-shares": "designs",
  "page-comments": "designs",
  links: "chats",
  Cache: "caches",
  "Code Cache": "caches",
  GPUCache: "caches",
  GPUPersistentCache: "caches",
  DawnGraphiteCache: "caches",
  DawnWebGPUCache: "caches",
  GraphiteDawnCache: "caches",
  "Shared Dictionary": "caches",
  "Service Worker": "caches",
  blob_storage: "caches",
  shared_proto_db: "caches",
});
const DISK_ORDER = ["worktrees", "chats", "checkpoints", "agents", "browser", "speech", "designs", "caches", "data"];

/**
 * `du -k -d 3` over Milagre's folders, in bytes: the folders' total split by what they hold, how many worktrees the
 * worktrees folder has (one level of Projects, then one folder per worktree) and each one's size. `chatFolders` are the
 * Projects' own `.milagre` folders (their Chats' history), measured beside the rest. Throws when no folder's total came
 * back.
 */
function parseDu(text, { folders, worktrees, dataDir = null, chatsHome = null, chatFolders = [] }) {
  const tops = new Set([...folders, ...chatFolders]);
  const chatTops = new Set(chatFolders);
  const data = dataDir && path.resolve(dataDir);
  const home = chatsHome && path.resolve(chatsHome);
  const bytesOf = new Map(DISK_ORDER.map((kind) => [kind, 0]));
  const sizes = {};
  let total = 0;
  let found = 0;
  let count = 0;
  for (const line of text.split("\n")) {
    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const bytes = Number(match[1]) * 1024;
    const folder = path.resolve(match[2]);
    if (tops.has(folder)) {
      total += bytes;
      if (folders.includes(folder)) found += 1;
    }
    if (folder === worktrees) bytesOf.set("worktrees", bytes);
    else if (path.dirname(path.dirname(folder)) === worktrees) {
      count += 1;
      sizes[folder] = bytes;
    } else if (chatTops.has(folder) || folder === home) bytesOf.set("chats", bytesOf.get("chats") + bytes);
    else if (data && path.dirname(folder) === data && DATA_KINDS[path.basename(folder)]) {
      const kind = DATA_KINDS[path.basename(folder)];
      bytesOf.set(kind, bytesOf.get(kind) + bytes);
    }
  }
  if (folders.length && !found) throw new Error("du printed no folder's total");
  // Clones and hard links can make the parts add past the total: the parts are cut to fit, worktrees first.
  let left = total;
  for (const kind of DISK_ORDER.slice(0, -1)) {
    const bytes = Math.min(bytesOf.get(kind), left);
    bytesOf.set(kind, bytes);
    left -= bytes;
  }
  bytesOf.set("data", left);
  return {
    total,
    parts: DISK_ORDER.map((kind) => ({ kind, bytes: bytesOf.get(kind), count: kind === "worktrees" ? count : 0 })).filter((part) => part.bytes > 0),
    sizes,
  };
}

function createComputerResources({
  dataDir,
  worktreeRoot,
  chatsHome = null,
  // The Projects' own `.milagre` folders, read at each measure: the Projects change while the app runs.
  chatFolders = async () => [],
  homeDir = os.homedir(),
  exec = run,
  readFile = fs.readFile,
  statfs = fs.statfs,
  access = fs.access,
  realpath = fs.realpath,
  platform = process.platform,
  now = Date.now,
  totalMemory = os.totalmem,
  self = { pid: process.pid, execPath: process.execPath },
} = {}) {
  let disk = { bytes: null, parts: null, sizes: {}, measuredAt: null, failedAt: null };
  // A cleanup asked for a new measure while one ran: it runs again once that one ends.
  let again = false;
  const worktrees = path.resolve(worktreeRoot ?? path.join(homeDir, ".milagre", "worktrees"));
  let measuring = null;
  let sampling = null;
  let closed = false;
  const stop = new AbortController();

  const exists = (folder) =>
    access(folder).then(
      () => true,
      () => false,
    );

  // A new measure even when one runs: what it walks may predate a cleanup, so another follows it.
  function remeasure() {
    if (measuring) again = true;
    return measureDisk();
  }

  function measureDisk() {
    if (closed) return Promise.resolve();
    if (measuring) return measuring;
    measuring = (async () => {
      const folders = [];
      for (const folder of milagreFolders({ homeDir, dataDir, worktreeRoot: worktrees })) if (await exists(folder)) folders.push(folder);
      const chats = [];
      for (const folder of await Promise.resolve(chatFolders()).catch(() => []))
        if (typeof folder === "string" && !folders.some((top) => folder === top || folder.startsWith(top + path.sep)) && (await exists(folder)))
          chats.push(path.resolve(folder));
      const measured = folders.length
        ? parseDu(await exec("du", ["-k", "-d", "3", ...folders, ...chats], { allowFailure: true, signal: stop.signal }), {
            folders,
            worktrees,
            dataDir,
            chatsHome,
            chatFolders: chats,
          })
        : { total: 0, parts: [], sizes: {} };
      // git names a worktree by its real path; du by the one it was given, which may run through a symlink.
      const real = await realpath(worktrees).catch(() => worktrees);
      const sizes = { ...measured.sizes };
      if (real !== worktrees) for (const [folder, bytes] of Object.entries(measured.sizes)) sizes[path.join(real, path.relative(worktrees, folder))] = bytes;
      disk = { bytes: measured.total, parts: measured.parts, sizes, measuredAt: now(), failedAt: null };
    })()
      .catch(() => {
        // The last good measure stays; the next try waits.
        disk = { ...disk, failedAt: now() };
      })
      .finally(() => {
        measuring = null;
        if (again && !closed) {
          again = false;
          void measureDisk();
        }
      });
    return measuring;
  }

  const due = () => {
    if (disk.failedAt !== null && now() - disk.failedAt < DISK_RETRY) return false;
    return disk.measuredAt === null || now() - disk.measuredAt > DISK_TTL;
  };

  async function sample() {
    const total = totalMemory();
    const [available, tree] = await Promise.all([
      availableMemory(total, { platform, exec, readFile }),
      platform === "win32"
        ? null
        : exec("ps", ["-axww", "-o", "pid=,ppid=,rss=,args="]).then(
            (text) => treeMemory(parseProcesses(text), self),
            () => null,
          ),
    ]);
    return { total, available: Math.min(available, total), milagre: tree?.total ?? null, parts: tree?.parts ?? null };
  }

  // Every client polls every 15 seconds; reads that arrive together share one sample.
  function memory() {
    sampling ??= sample().finally(() => {
      sampling = null;
    });
    return sampling;
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
    async read(options) {
      if (options?.fresh === true) void remeasure();
      else if (due()) void measureDisk();
      const [memoryNow, spaceNow] = await Promise.all([memory(), space().catch(() => null)]);
      return {
        platform: process.platform,
        memory: memoryNow,
        disk: spaceNow && { ...spaceNow, milagre: disk.bytes, parts: disk.parts, measuredAt: disk.measuredAt, measuring: measuring !== null },
      };
    },
    measureDisk,
    remeasure,
    /** A worktree's size at the last measure, or null when it wasn't measured (made since, or outside the folder). */
    worktreeBytes: (folder) => disk.sizes[path.resolve(folder)] ?? null,
    /** When the folders were last measured, or null. */
    measuredAt: () => disk.measuredAt,
    /** Stops a measure still running, so a closing daemon doesn't wait on du or leave it walking the disk. */
    close() {
      closed = true;
      stop.abort();
    },
  };
}

module.exports = { DATA_KINDS, createComputerResources, availableMemory, parseProcesses, treeMemory, milagreFolders, parseDu, run, DISK_TTL, DISK_RETRY };
