// Repeatable desktop performance runs against the built app and a scripted `claude`. See scripts/perf/README.md.
//   npm run build:renderer --workspace milagre
//   node scripts/perf/run.cjs idle|stream|code|soak [--seconds n] [--turns n] [--state <.milagre>] [--out file]
//   node scripts/perf/run.cjs compare before.json after.json
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { parseArgs } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");

const root = path.resolve(__dirname, "../..");
const SCENARIOS = new Set(["idle", "stream", "code", "soak"]);
const round = (value, digits = 1) => Number(value.toFixed(digits));
const toMb = (bytes) => round(bytes / 1048576);

function electronPath() {
  const dist = path.join(root, "node_modules/electron/dist");
  if (process.platform === "darwin") return path.join(dist, "Electron.app/Contents/MacOS/Electron");
  return path.join(dist, process.platform === "win32" ? "electron.exe" : "electron");
}

async function until(read, description, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(200);
  }
  throw new Error(`Timed out: ${description}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await once(socket, "open", { signal: AbortSignal.timeout(20000) });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data);
    if (reply.method) listeners.get(reply.method)?.(reply.params);
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    if (reply.error) request.reject(new Error(reply.error.message));
    else request.resolve(reply.result);
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  return { call, evaluate, onEvent: (method, listener) => listeners.set(method, listener), close: () => socket.close() };
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A throwaway repository with one Claude Chat, or a copy of `state` with every Worktree on a path of its own. */
function seedRepo(work, state) {
  const repo = path.join(work, "repo");
  const data = path.join(repo, ".milagre");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".milagre\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=perf", "-c", "user.email=perf@example.com", "commit", "-q", "-m", "init");
  fs.mkdirSync(data);
  if (!state) {
    const worktree = { id: 1, project_id: 1, path: repo, name: "main" };
    const chat = { id: 2, worktree_id: 1, agent_name: "main", status: "Created", provider: "claude", generatedTitle: "Perf run" };
    // A Chat without messages stays out of the sidebar. The host moves these into chats.db on its first read.
    const messages = [
      { id: 3, session_id: 2, role: "user", body: "Perf run" },
      { id: 4, session_id: 2, role: "assistant", body: "Ready.", model: "claude-perf" },
    ];
    const empty = { connections: {}, events: [], messages, approvals: [], tasks: {}, artifacts: {}, outputs: [], conflicts: [] };
    const seeded = { next_id: 10, projects: { 1: { id: 1, name: "perf" } }, worktrees: { 1: worktree }, sessions: { 2: chat }, ...empty };
    fs.writeFileSync(path.join(data, "coordination.json"), JSON.stringify(seeded));
    return repo;
  }
  for (const name of ["chats.db", "coordination.json", "details", "subagents", "images"]) {
    const from = path.join(state, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(data, name), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  }
  const file = path.join(data, "coordination.json");
  const copy = JSON.parse(fs.readFileSync(file, "utf8"));
  const worktrees = Object.values(copy.worktrees);
  for (const [index, worktree] of worktrees.entries()) {
    if (index === 0) worktree.path = repo;
    else {
      worktree.path = path.join(work, "worktrees", String(worktree.id));
      git(repo, "worktree", "add", "-q", "-b", `perf-${worktree.id}`, worktree.path);
    }
  }
  // Without this a copied Chat would try to resume its real provider session.
  for (const chat of Object.values(copy.sessions)) delete chat.native_session_id;
  fs.writeFileSync(file, JSON.stringify(copy));
  return repo;
}

function bin(work) {
  const dir = path.join(work, "bin");
  fs.mkdirSync(dir);
  const stub = path.join(dir, "claude");
  fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, "fake-claude.cjs")}" "$@"\n`);
  fs.chmodSync(stub, 0o755);
  return dir;
}

const kindOf = (command) => {
  if (/--type=renderer/.test(command)) return "renderer";
  if (/--type=gpu/.test(command)) return "gpu";
  if (/--type=/.test(command)) return "utility";
  if (/cli\.cjs serve/.test(command)) return "host";
  return /fake-claude/.test(command) ? "stub" : "main";
};

/** This run's processes. The scratch directory is unique and in every one's command line, so nothing else matches. */
function processes(work) {
  const rows = execFileSync("ps", ["-Ao", "pid=,time=,rss=,command="], { encoding: "utf8", maxBuffer: 1e8 }).split("\n");
  return rows.flatMap((row) => {
    const match = /^\s*(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?\s+(\d+)\s+(.*)$/.exec(row);
    if (!match || !match[8].includes(work)) return [];
    const [, pid, days, hours, minutes, seconds, fraction, rss, command] = match;
    const cpu = Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(`${seconds}.${fraction ?? 0}`);
    return [{ pid: Number(pid), kind: kindOf(command), cpu, rss: Number(rss) * 1024 }];
  });
}

const cpuByKind = (rows) => {
  const totals = {};
  for (const row of rows) totals[row.kind] = (totals[row.kind] ?? 0) + row.cpu;
  return totals;
};

const cpuPercent = (before, after, seconds) =>
  Object.fromEntries(Object.entries(after).map(([kind, used]) => [kind, round(((used - (before[kind] ?? 0)) / seconds) * 100)]));

/** Physical footprint where macOS can report it, resident size elsewhere. */
function footprintMb(row) {
  if (process.platform !== "darwin") return toMb(row.rss);
  try {
    const out = execFileSync("footprint", ["-p", String(row.pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const match = /Footprint: ([\d.]+) (KB|MB|GB)/.exec(out);
    return match ? round(Number(match[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2]]) : toMb(row.rss);
  } catch {
    return toMb(row.rss);
  }
}

async function memory(page, work) {
  await page.call("HeapProfiler.collectGarbage");
  const heap = await page.call("Runtime.getHeapUsage");
  const counters = await page.call("Memory.getDOMCounters");
  const renderers = processes(work).filter((row) => row.kind === "renderer");
  const largest = renderers.reduce((best, row) => (row.rss > (best?.rss ?? 0) ? row : best), null);
  return {
    jsHeapMb: toMb(heap.usedSize),
    domNodes: counters.nodes,
    listeners: counters.jsEventListeners,
    rendererFootprintMb: largest ? footprintMb(largest) : null,
  };
}

const FRAME_PROBE = `(() => {
  const state = (window.__perf = { long: [], frames: [], run: true });
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) state.long.push(entry.duration); }).observe({ type: "longtask" });
  let last = performance.now();
  const tick = (now) => { state.frames.push(now - last); last = now; if (state.run) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})()`;

async function frames(page) {
  const { long, gaps } = await page.evaluate(`(() => { const s = window.__perf; s.run = false; return { long: s.long, gaps: s.frames }; })()`);
  const sorted = gaps.filter((gap) => gap > 0).sort((a, b) => a - b);
  const at = (share) => round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0);
  return {
    longTasks: long.length,
    longTaskMs: Math.round(long.reduce((sum, value) => sum + value, 0)),
    longestTaskMs: Math.round(Math.max(0, ...long)),
    frameP50Ms: at(0.5),
    frameP95Ms: at(0.95),
    frameP99Ms: at(0.99),
    framesOver50Ms: sorted.filter((gap) => gap > 50).length,
  };
}

async function send(page, text) {
  await page.evaluate(`document.querySelector('[contenteditable=true][aria-label="Prompt"]').focus()`);
  await page.call("Input.insertText", { text });
  await delay(150);
  const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await page.call("Input.dispatchKeyEvent", { type: "keyDown", ...enter, text: "\r" });
  await page.call("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
}

async function turn(page, work, kind, number, seconds) {
  const sent = Date.now();
  await send(page, `perf-run:${kind}:${number}`);
  const firstText = `perf-reply-${number}`;
  await until(() => page.evaluate(`document.body.innerText.includes(${JSON.stringify(firstText)})`), `first text of turn ${number}`, 120000);
  const firstTextMs = Date.now() - sent;
  await until(() => fs.existsSync(path.join(work, "marks", `turn-${number}-end`)), `end of turn ${number}`, (seconds + 60) * 1000);
  // The last batch and its settled highlight land just after the stub's result.
  await delay(1500);
  return firstTextMs;
}

async function scenario(name, page, work, options) {
  const seconds = options.seconds;
  if (name === "idle") {
    const before = cpuByKind(processes(work));
    await delay(seconds * 1000);
    return { cpuPercent: cpuPercent(before, cpuByKind(processes(work)), seconds), ...(await memory(page, work)) };
  }
  const kind = name === "code" ? "code" : "mix";
  await page.evaluate(FRAME_PROBE);
  if (name === "soak") {
    if (options.heap) await heapSnapshot(page, `${options.heap}-before.heapsnapshot`);
    const samples = [await memory(page, work)];
    for (let number = 1; number <= options.turns; number++) {
      const firstTextMs = await turn(page, work, kind, number, seconds);
      samples.push({ firstTextMs, ...(await memory(page, work)) });
      console.log(`turn ${number}/${options.turns}: first text ${firstTextMs} ms, JS ${samples.at(-1).jsHeapMb} MB, ${samples.at(-1).domNodes} nodes`);
    }
    if (options.heap) await heapSnapshot(page, `${options.heap}-after.heapsnapshot`);
    const first = samples[0];
    const last = samples.at(-1);
    return {
      jsHeapMbPerTurn: round((last.jsHeapMb - first.jsHeapMb) / options.turns, 2),
      footprintMbPerTurn: first.rendererFootprintMb === null ? null : round((last.rendererFootprintMb - first.rendererFootprintMb) / options.turns, 2),
      domNodesPerTurn: Math.round((last.domNodes - first.domNodes) / options.turns),
      samples,
      ...(await frames(page)),
    };
  }
  const before = await memory(page, work);
  const cpuBefore = cpuByKind(processes(work));
  const started = Date.now();
  const firstTextMs = await turn(page, work, kind, 1, seconds);
  const elapsed = (Date.now() - started) / 1000;
  const cpu = cpuPercent(cpuBefore, cpuByKind(processes(work)), elapsed);
  const measured = await frames(page);
  const after = await memory(page, work);
  return { cpuPercent: cpu, firstTextMs, ...measured, ...after, jsHeapGrowthMb: round(after.jsHeapMb - before.jsHeapMb) };
}

async function stop(browser, app, work) {
  // The browser exits instead of answering, so this call never settles.
  void browser?.call("Browser.close").catch(() => {});
  if (app && app.exitCode === null) await Promise.race([once(app, "exit"), delay(5000)]);
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const row of processes(work)) {
      try {
        process.kill(row.pid, signal);
      } catch {
        // Already gone.
      }
    }
    await delay(1500);
  }
}

async function run(name, options) {
  const dist = path.join(root, "apps/desktop/dist/index.html");
  if (!fs.existsSync(dist)) throw new Error("No built renderer: run `npm run build:renderer --workspace milagre` first.");
  // macOS resolves the temporary directory through /private; Git and the host report that real path.
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-perf-")));
  let app;
  let browser;
  try {
    const repo = seedRepo(work, options.state);
    for (const dir of ["home", "profile", "chats", "tmp", "marks"]) fs.mkdirSync(path.join(work, dir));
    const env = {
      HOME: path.join(work, "home"),
      PATH: `${bin(work)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: path.join(work, "tmp"),
      LANG: "en_US.UTF-8",
      MILAGRE_BACKGROUND: "1",
      MILAGRE_CHATS_HOME: path.join(work, "chats"),
      MILAGRE_DEV_SERVER_URL: `file://${dist}`,
      PERF_MARK_DIR: path.join(work, "marks"),
      PERF_SECONDS: String(options.seconds),
    };
    const flags = [
      `--user-data-dir=${path.join(work, "profile")}`,
      "--remote-debugging-port=0",
      "--use-mock-keychain",
      "--proxy-server=http://127.0.0.1:9",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
    ];
    app = spawn(electronPath(), [path.join(root, "apps/desktop"), ...flags], { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] });
    let port;
    app.stderr.on("data", (data) => {
      port ??= /ws:\/\/127\.0\.0\.1:(\d+)/.exec(String(data))?.[1];
    });
    const target = await until(async () => {
      if (!port) return null;
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(
        (reply) => reply.json(),
        () => [],
      );
      return list.find((item) => item.type === "page" && item.url.includes("index.html") && !item.url.includes("floating"));
    }, "the app window");
    const { webSocketDebuggerUrl } = await fetch(`http://127.0.0.1:${port}/json/version`).then((reply) => reply.json());
    browser = await connect(webSocketDebuggerUrl);
    const page = await connect(target.webSocketDebuggerUrl);
    await page.call("HeapProfiler.enable");
    await page.call("Runtime.enable");
    const opened = await until(
      () => page.evaluate(`(() => { const row = document.querySelector('button[data-inbox-row]'); row?.click(); return !!row; })()`),
      "a Chat row",
    );
    await until(() => page.evaluate(`!!document.querySelector('[contenteditable=true][aria-label="Prompt"]')`), "the composer");
    await delay(options.settle * 1000);
    const measured = await scenario(name, page, work, options);
    page.close();
    return {
      scenario: name,
      date: new Date().toISOString(),
      commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      loadAverage: round(os.loadavg()[0]),
      seconds: options.seconds,
      turns: name === "soak" ? options.turns : undefined,
      state: options.state ? "copied" : "synthetic",
      opened,
      ...measured,
    };
  } finally {
    await stop(browser, app, work);
    browser?.close();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Writes a V8 heap snapshot, the file Chrome DevTools' Memory tab opens. */
async function heapSnapshot(page, file) {
  await page.call("HeapProfiler.collectGarbage");
  const out = fs.createWriteStream(file);
  page.onEvent("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => out.write(chunk));
  await page.call("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  await new Promise((resolve) => out.end(resolve));
}

function flatten(result, prefix = "") {
  return Object.entries(result).flatMap(([key, value]) => {
    if (typeof value === "number") return [[prefix + key, value]];
    return value && typeof value === "object" && !Array.isArray(value) ? flatten(value, `${prefix}${key}.`) : [];
  });
}

function compare(beforeFile, afterFile) {
  const [before, after] = [beforeFile, afterFile].map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  if (before.scenario !== after.scenario) console.warn(`Different scenarios: ${before.scenario} and ${after.scenario}.`);
  const values = new Map(flatten(before));
  for (const [key, value] of flatten(after)) {
    if (!values.has(key)) continue;
    const was = values.get(key);
    const change = was === 0 ? "" : `${value >= was ? "+" : ""}${round(((value - was) / was) * 100)}%`;
    console.log(`${key.padEnd(30)} ${String(was).padStart(10)} ${String(value).padStart(10)} ${change.padStart(9)}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      seconds: { type: "string" },
      turns: { type: "string", default: "10" },
      settle: { type: "string", default: "5" },
      state: { type: "string" },
      out: { type: "string" },
      heap: { type: "string" },
    },
  });
  const [name, ...files] = positionals;
  if (name === "compare" && files.length === 2) return compare(...files);
  if (!SCENARIOS.has(name)) throw new Error("Usage: run.cjs idle|stream|code|soak [options], or run.cjs compare before.json after.json");
  const seconds = Number(values.seconds ?? (name === "soak" ? 15 : name === "idle" ? 60 : 45));
  const result = await run(name, { seconds, turns: Number(values.turns), settle: Number(values.settle), state: values.state, heap: values.heap });
  const out = values.out ?? path.join(os.tmpdir(), `milagre-perf-${name}-${Date.now()}.json`);
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, samples: undefined }, null, 2));
  console.log(`Saved ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
