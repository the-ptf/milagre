const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { parseArgs } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { connect, electronPath, processes, seedRepo, bin, stop, round } = require("./run.cjs");

const root = path.resolve(__dirname, "../..");
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** The executable and its leading arguments: a packaged .app, or Electron on a checkout's apps/desktop with a built renderer. */
function target(app, checkout = root, distDir = path.join(checkout, "apps/desktop/dist")) {
  if (!app) {
    const dist = path.join(distDir, "index.html");
    if (!fs.existsSync(dist)) throw new Error("No built renderer: run `npm run build:renderer --workspace milagre` first.");
    const electron = path.join(checkout, path.relative(root, electronPath()));
    return { command: electron, args: [path.join(checkout, "apps/desktop")], env: { MILAGRE_DEV_SERVER_URL: `file://${dist}` } };
  }
  const macos = path.join(app, "Contents/MacOS");
  const command = fs.existsSync(macos) ? path.join(macos, fs.readdirSync(macos)[0]) : app;
  return { command, args: [], env: {} };
}

async function poll(read, description, timeoutMs = 60000, everyMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read().catch(() => null);
    if (value) return value;
    await delay(everyMs);
  }
  throw new Error(`Timed out: ${description}`);
}

const cpuOf = (rows) => rows.reduce((sum, row) => sum + row.cpu, 0);

/** Every process on the computer: its parent and CPU seconds. */
function processTable() {
  const rows = execFileSync("ps", ["-Ao", "pid=,ppid=,time="], { encoding: "utf8", maxBuffer: 1e8 }).split("\n");
  const table = new Map();
  for (const row of rows) {
    const match = /^\s*(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?/.exec(row);
    if (!match) continue;
    const [, pid, ppid, days, hours, minutes, seconds, fraction] = match;
    const cpu = Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(`${seconds}.${fraction ?? 0}`);
    table.set(Number(pid), { ppid: Number(ppid), cpu });
  }
  return table;
}

function subtreeCpu(table, pid) {
  let total = table.get(pid)?.cpu ?? 0;
  for (const [child, row] of table) if (row.ppid === pid) total += subtreeCpu(table, child);
  return total;
}

const seconds = (text) => {
  const match = /(\d+)m([\d.]+)s/.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
};

/**
 * The child processes the main process and the host started since `since` (trace-spawns.cjs): exited ones with the CPU
 * trace-exec.sh measured for them and their descendants, running ones with their process tree's so far.
 */
function spawnsOf(traceDir, since, until, table) {
  const starts = [];
  const ends = new Map();
  for (const name of fs.readdirSync(traceDir).filter((file) => file.startsWith("spawns-"))) {
    for (const line of fs.readFileSync(path.join(traceDir, name), "utf8").split("\n").filter(Boolean)) {
      const entry = JSON.parse(line);
      if (entry.file) starts.push(entry);
      else ends.set(entry.pid, entry.ended);
    }
  }
  const measured = new Map();
  const cpuLog = path.join(traceDir, "cpu.log");
  for (const line of fs.existsSync(cpuLog) ? fs.readFileSync(cpuLog, "utf8").split("\n").filter(Boolean) : []) {
    const [pid, status, user, sys] = line.split(" ");
    measured.set(Number(pid), { status: Number(status), cpuMs: Math.round((seconds(user) + seconds(sys)) * 1000) });
  }
  return starts
    .filter((entry) => entry.started >= since && entry.started < until && entry.wrapped !== false)
    .map((entry) => {
      const ended = ends.get(entry.pid) ?? entry.ended;
      const cpuMs = measured.get(entry.pid)?.cpuMs ?? (entry.pid ? Math.round(subtreeCpu(table, entry.pid) * 1000) : 0);
      return {
        role: entry.role,
        command: [path.basename(entry.file), ...entry.args].join(" ").slice(0, 200),
        atMs: entry.started - since,
        wallMs: ended ? ended - entry.started : null,
        cpuMs,
        running: !ended,
        status: measured.get(entry.pid)?.status ?? null,
        caller: entry.caller,
      };
    })
    .sort((a, b) => a.atMs - b.atMs);
}

async function launchOnce(work, repo, launcher, binDir, options) {
  const traceDir = options.trace ? path.join(work, "trace") : null;
  if (traceDir) fs.mkdirSync(traceDir, { recursive: true });
  const env = {
    HOME: path.join(work, "home"),
    PATH: options.realClis ? LAUNCHD_PATH : `${binDir}:${LAUNCHD_PATH}`,
    TMPDIR: path.join(work, "tmp"),
    LANG: "en_US.UTF-8",
    MILAGRE_BACKGROUND: "1",
    MILAGRE_CHATS_HOME: path.join(work, "chats"),
    ...(traceDir
      ? {
          NODE_OPTIONS: `--require ${path.join(__dirname, "trace-spawns.cjs")}`,
          PERF_TRACE_DIR: traceDir,
          PERF_TRACE_WRAPPER: path.join(__dirname, "trace-exec.sh"),
        }
      : {}),
    ...launcher.env,
  };
  const hostBefore = cpuOf(processes(work).filter((row) => row.kind === "host"));
  const flags = [`--user-data-dir=${path.join(work, "profile")}`, "--remote-debugging-port=0", "--use-mock-keychain", "--proxy-server=http://127.0.0.1:9"];
  const started = Date.now();
  const app = spawn(launcher.command, [...launcher.args, ...flags], { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] });
  let port;
  app.stderr.on("data", (data) => {
    port ??= /ws:\/\/127\.0\.0\.1:(\d+)/.exec(String(data))?.[1];
  });
  let browser;
  try {
    const page = await poll(async () => {
      if (!port) return null;
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((reply) => reply.json());
      return list.find((item) => item.type === "page" && item.url.includes("index.html") && !item.url.includes("floating"));
    }, "the app window");
    const { webSocketDebuggerUrl } = await fetch(`http://127.0.0.1:${port}/json/version`).then((reply) => reply.json());
    browser = await connect(webSocketDebuggerUrl);
    const contents = await connect(page.webSocketDebuggerUrl);
    const probe = `(() => ({
      origin: performance.timeOrigin,
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
      row: !!document.querySelector("button[data-inbox-row]"),
      now: performance.timeOrigin + performance.now(),
    }))()`;
    const shown = await poll(async () => {
      const value = await contents.evaluate(probe);
      return value.row ? value : null;
    }, "a sidebar row");
    const painted = await poll(async () => {
      const value = await contents.evaluate(probe);
      return value.fcp === null ? null : value;
    }, "first paint");
    contents.close();
    await delay(Math.max(0, started + options.windowSeconds * 1000 - Date.now()));
    const table = processTable();
    const cpu = {};
    for (const row of processes(work)) if (row.kind !== "trace") cpu[row.kind] = (cpu[row.kind] ?? 0) + row.cpu;
    cpu.host = (cpu.host ?? 0) - hostBefore;
    const children = traceDir ? spawnsOf(traceDir, started, Date.now(), table) : [];
    for (const child of children) cpu[`${child.role}Children`] = (cpu[`${child.role}Children`] ?? 0) + child.cpuMs / 1000;
    for (const kind of Object.keys(cpu)) cpu[kind] = round(cpu[kind], 3);
    cpu.total = round(
      Object.values(cpu).reduce((sum, value) => sum + value, 0),
      3,
    );
    return {
      windowMs: Math.round(shown.origin - started),
      firstPaintMs: Math.round(painted.origin + painted.fcp - started),
      sidebarMs: Math.round(shown.now - started),
      loadAverage: round(os.loadavg()[0]),
      cpu,
      ...(traceDir ? { children } : {}),
    };
  } finally {
    void browser?.call("Browser.close").catch(() => {});
    if (app.exitCode === null) await Promise.race([once(app, "exit"), delay(8000)]);
    for (const row of processes(work)) {
      if (row.kind === "host" || row.kind === "trace") continue;
      try {
        process.kill(row.pid, "SIGKILL");
      } catch {}
    }
    browser?.close();
    await delay(1000);
  }
}

/** The fake home gets the user's own Claude Code where its native installer puts it, so the host finds the real CLI, signed out. */
function linkRealClis(work) {
  const found = path.join(os.homedir(), ".local/bin/claude");
  if (!fs.existsSync(found)) return;
  const local = path.join(work, "home/.local/bin");
  fs.mkdirSync(local, { recursive: true });
  fs.symlinkSync(fs.realpathSync(found), path.join(local, "claude"));
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function run(options) {
  const launcher = target(options.app, options.root, options.dist);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-launch-")));
  try {
    const repo = seedRepo(work);
    for (const dir of ["home", "profile", "chats", "tmp", "marks"]) fs.mkdirSync(path.join(work, dir));
    const binDir = bin(work);
    if (options.realClis) linkRealClis(work);
    const runs = [];
    for (let index = 0; index < options.runs; index++) {
      const result = await launchOnce(work, repo, launcher, binDir, options);
      runs.push(result);
      console.log(
        `launch ${index + 1}/${options.runs}${index === 0 ? " (host starting)" : ""}: window ${result.windowMs} ms, paint ${result.firstPaintMs} ms, sidebar ${result.sidebarMs} ms, CPU ${result.cpu.total} s`,
      );
    }
    const warm = runs.slice(1);
    const summary = (key) => (warm.length ? median(warm.map((item) => item[key])) : null);
    const kinds = [...new Set(warm.flatMap((item) => Object.keys(item.cpu)))];
    return {
      scenario: "launch",
      date: new Date().toISOString(),
      commit: commitOf(options.root),
      app: options.app ?? "unpackaged",
      checkout: options.root,
      dist: options.dist ?? null,
      clis: options.realClis ? "real" : "stub",
      windowSeconds: options.windowSeconds,
      appArchiveMb: options.app ? archiveMb(options.app) : null,
      loadAverage: round(os.loadavg()[0]),
      firstLaunch: runs[0],
      windowMs: summary("windowMs"),
      firstPaintMs: summary("firstPaintMs"),
      sidebarMs: summary("sidebarMs"),
      cpu: Object.fromEntries(kinds.map((kind) => [kind, median(warm.map((item) => item.cpu[kind] ?? 0))])),
      runs,
    };
  } finally {
    await stop(null, null, work);
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

function commitOf(checkout) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return path.basename(checkout);
  }
}

function archiveMb(app) {
  const file = path.join(app, "Contents/Resources/app.asar");
  return fs.existsSync(file) ? round(fs.statSync(file).size / 1048576) : null;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      app: { type: "string" },
      runs: { type: "string", default: "6" },
      out: { type: "string" },
      root: { type: "string" },
      dist: { type: "string" },
      trace: { type: "boolean", default: false },
      "real-clis": { type: "boolean", default: false },
      window: { type: "string", default: "8" },
    },
  });
  if (positionals[0] === "compare") {
    const [before, after] = positionals.slice(1).map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    const read = (result, key) => (key.startsWith("cpu.") ? result.cpu?.[key.slice(4)] : result[key]);
    for (const key of ["appArchiveMb", "windowMs", "firstPaintMs", "sidebarMs", ...Object.keys(after.cpu ?? {}).map((kind) => `cpu.${kind}`)]) {
      const [was, now] = [read(before, key), read(after, key)];
      const change = typeof was === "number" && was ? `${now >= was ? "+" : ""}${round(((now - was) / was) * 100)}%` : "";
      console.log(`${key.padEnd(18)} ${String(was).padStart(8)} ${String(now).padStart(8)} ${change.padStart(9)}`);
    }
    return;
  }
  const result = await run({
    app: values.app && path.resolve(values.app),
    runs: Math.max(2, Number(values.runs)),
    root: values.root ? path.resolve(values.root) : root,
    dist: values.dist && path.resolve(values.dist),
    trace: values.trace,
    realClis: values["real-clis"],
    windowSeconds: Number(values.window),
  });
  const out = values.out ?? path.join(os.tmpdir(), `milagre-perf-launch-${Date.now()}.json`);
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, runs: undefined, firstLaunch: { ...result.firstLaunch, children: undefined } }, null, 2));
  console.log(`Saved ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
