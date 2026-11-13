// Launch time of the desktop app: from spawning it to its window, first paint and first sidebar row. See scripts/perf/README.md.
//   node scripts/perf/launch.cjs [--app /path/Milagre.app] [--runs 6] [--out file]
//   node scripts/perf/launch.cjs compare before.json after.json
// The first run starts the background host as a first launch does; later runs find it running, as most launches do.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { once } = require("node:events");
const { parseArgs } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { connect, electronPath, processes, seedRepo, bin, stop, round } = require("./run.cjs");

const root = path.resolve(__dirname, "../..");

/** The executable and its leading arguments: a packaged .app, or Electron on apps/desktop with the built renderer. */
function target(app) {
  if (!app) {
    const dist = path.join(root, "apps/desktop/dist/index.html");
    if (!fs.existsSync(dist)) throw new Error("No built renderer: run `npm run build:renderer --workspace milagre` first.");
    return { command: electronPath(), args: [path.join(root, "apps/desktop")], env: { MILAGRE_DEV_SERVER_URL: `file://${dist}` } };
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

async function launchOnce(work, repo, launcher, binDir) {
  const env = {
    HOME: path.join(work, "home"),
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: path.join(work, "tmp"),
    LANG: "en_US.UTF-8",
    MILAGRE_BACKGROUND: "1",
    MILAGRE_CHATS_HOME: path.join(work, "chats"),
    ...launcher.env,
  };
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
    return {
      windowMs: Math.round(shown.origin - started),
      firstPaintMs: Math.round(painted.origin + painted.fcp - started),
      sidebarMs: Math.round(shown.now - started),
    };
  } finally {
    // Quit the app only: the host keeps running for the next launch, as it does after a real quit.
    void browser?.call("Browser.close").catch(() => {});
    if (app.exitCode === null) await Promise.race([once(app, "exit"), delay(8000)]);
    for (const row of processes(work)) {
      if (row.kind === "host") continue;
      try {
        process.kill(row.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    browser?.close();
    await delay(1000);
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function run(options) {
  const launcher = target(options.app);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "milagre-launch-")));
  try {
    const repo = seedRepo(work);
    for (const dir of ["home", "profile", "chats", "tmp", "marks"]) fs.mkdirSync(path.join(work, dir));
    const binDir = bin(work);
    const runs = [];
    for (let index = 0; index < options.runs; index++) {
      const result = await launchOnce(work, repo, launcher, binDir);
      runs.push(result);
      console.log(
        `launch ${index + 1}/${options.runs}${index === 0 ? " (host starting)" : ""}: window ${result.windowMs} ms, paint ${result.firstPaintMs} ms, sidebar ${result.sidebarMs} ms`,
      );
    }
    const warm = runs.slice(1);
    const summary = (key) => (warm.length ? median(warm.map((item) => item[key])) : null);
    return {
      scenario: "launch",
      date: new Date().toISOString(),
      commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      app: options.app ?? "unpackaged",
      appArchiveMb: options.app ? archiveMb(options.app) : null,
      loadAverage: round(os.loadavg()[0]),
      firstLaunch: runs[0],
      windowMs: summary("windowMs"),
      firstPaintMs: summary("firstPaintMs"),
      sidebarMs: summary("sidebarMs"),
      runs,
    };
  } finally {
    await stop(null, null, work);
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

function archiveMb(app) {
  const file = path.join(app, "Contents/Resources/app.asar");
  return fs.existsSync(file) ? round(fs.statSync(file).size / 1048576) : null;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { app: { type: "string" }, runs: { type: "string", default: "6" }, out: { type: "string" } },
  });
  if (positionals[0] === "compare") {
    const [before, after] = positionals.slice(1).map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
    for (const key of ["appArchiveMb", "windowMs", "firstPaintMs", "sidebarMs"]) {
      const [was, now] = [before[key], after[key]];
      const change = typeof was === "number" && was ? `${now >= was ? "+" : ""}${round(((now - was) / was) * 100)}%` : "";
      console.log(`${key.padEnd(14)} ${String(was).padStart(8)} ${String(now).padStart(8)} ${change.padStart(9)}`);
    }
    return;
  }
  const result = await run({ app: values.app && path.resolve(values.app), runs: Math.max(2, Number(values.runs)) });
  const out = values.out ?? path.join(os.tmpdir(), `milagre-perf-launch-${Date.now()}.json`);
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, runs: undefined }, null, 2));
  console.log(`Saved ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
