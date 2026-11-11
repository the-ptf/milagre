#!/usr/bin/env node
// Read-only collector: never starts/stops apps, changes their UI or starts an agent turn.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { createConnection } from "node:net";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseProcesses, selectProcessGroups, intervalCpu, summarize } from "./metrics.mjs";

const { values } = parseArgs({
  options: {
    "electron-app": { type: "string", default: "/Applications/Milagre.app" },
    "rust-app": { type: "string", default: join(homedir(), "Applications/Milagre Rust.app") },
    profile: { type: "string", default: join(homedir(), "Library/Application Support/Milagre") },
    "electron-pid": { type: "string" },
    "rust-pid": { type: "string" },
    "daemon-pid": { type: "string" },
    "electron-helper-pid": { type: "string", multiple: true, default: [] },
    "rust-helper-pid": { type: "string", multiple: true, default: [] },
    "helper-evidence": { type: "string" },
    "observer-pid": { type: "string", multiple: true, default: [] },
    "matched-workload": { type: "boolean", default: false },
    "workload-description": { type: "string", default: "Existing running apps; UI, visibility, open windows and agent activity were not controlled." },
    samples: { type: "string", default: "7" },
    "interval-ms": { type: "string", default: "1000" },
    "startup-observations": { type: "string" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    'Usage: node perf/collect.mjs [--samples 7] [--interval-ms 1000] [--output /tmp/milagre-performance.json]\nOptional: --electron-pid PID --rust-pid PID --daemon-pid PID\nExplicit attributed XPC helpers: --rust-helper-pid PID --helper-evidence "How ownership was verified"\nSee perf/README.md for workload matching, startup observations and measurement limits.',
  );
  process.exit(0);
}
if (process.platform !== "darwin") throw new Error("This collector currently supports macOS ps and app bundles only.");
const integer = (value, name, min, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
};
const count = integer(values.samples, "samples", 2, 300);
const interval = integer(values["interval-ms"], "interval-ms", 250, 60000);
const pid = (value) => (value === undefined ? null : integer(value, "PID", 1, 2147483647));
const path = (value) => resolve(value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
const shell = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"], timeout: 15000 }).trim();
const optional = (command, args) => {
  try {
    return shell(command, args);
  } catch {
    return null;
  }
};
const readProcesses = () => parseProcesses(shell("/bin/ps", ["-axo", "pid=,ppid=,rss=,time=,lstart=,comm="]));

function bundle(directory) {
  const app = path(directory);
  const executableName = optional("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", join(app, "Contents/Info.plist")]);
  const size = optional("/usr/bin/du", ["-sk", app]);
  return {
    path: app,
    exists: existsSync(app),
    version: optional("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(app, "Contents/Info.plist")]),
    executable: executableName ? join(app, "Contents/MacOS", executableName) : null,
    allocatedKiB: size ? Number(size.split(/\s+/)[0]) : null,
  };
}

async function daemonStatus() {
  try {
    const profile = realpathSync(path(values.profile));
    const digest = createHash("sha256").update(profile).digest("hex").slice(0, 24);
    const socketPath = join("/tmp", `milagre-${process.getuid()}`, `${digest}.sock`);
    return await new Promise((resolveStatus, reject) => {
      const socket = createConnection(socketPath);
      socket.setEncoding("utf8");
      let text = "";
      let settled = false;
      let timer;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) {
          reject(error);
          return;
        }
        resolveStatus(result);
      };
      timer = setTimeout(() => finish(new Error("Status timeout")), 2500);
      socket.once("error", (error) => finish(error));
      socket.once("connect", () => socket.write(JSON.stringify({ v: 1, id: 1, method: "daemon:status", args: [] }) + "\n"));
      socket.on("data", (chunk) => {
        text += chunk;
        if (text.length > 16 * 1024 * 1024) {
          finish(new Error("Status frame too large"));
          return;
        }
        while (text.includes("\n")) {
          const end = text.indexOf("\n");
          const line = text.slice(0, end);
          text = text.slice(end + 1);
          try {
            const frame = JSON.parse(line);
            if (frame.id === 1) {
              if (frame.error) finish(new Error(frame.error.message));
              else finish(null, frame.result);
              return;
            }
          } catch (error) {
            finish(error);
            return;
          }
        }
      });
      socket.once("end", () => finish(new Error("Status socket ended")));
    });
  } catch (error) {
    return { unavailable: error.message };
  }
}

const electron = bundle(values["electron-app"]);
const rust = bundle(values["rust-app"]);
const status = await daemonStatus();
const initial = readProcesses();
const daemonPid = pid(values["daemon-pid"]) || (Number.isInteger(status.pid) ? status.pid : null);
function findMain(info, explicit) {
  if (explicit) {
    const row = initial.find((item) => item.pid === explicit);
    if (!row) throw new Error(`PID ${explicit} is not running`);
    if (info.executable && row.executable !== info.executable) throw new Error(`PID ${explicit} does not match the supplied app bundle`);
    return { pid: explicit, source: "explicit PID" };
  }
  const candidates = initial.filter((row) => row.executable === info.executable && row.pid !== daemonPid);
  return candidates.length === 1
    ? { pid: candidates[0].pid, source: "unique bundle executable match" }
    : { pid: null, source: "unmeasured", reason: candidates.length ? "Multiple matching processes; provide an explicit PID" : "App process not found" };
}
const roots = { electron: findMain(electron, pid(values["electron-pid"])), rust: findMain(rust, pid(values["rust-pid"])) };
const electronHelpers = values["electron-helper-pid"].map(pid);
const rustHelpers = values["rust-helper-pid"].map(pid);
const helperPids = [...electronHelpers, ...rustHelpers];
if (helperPids.length && !values["helper-evidence"]?.trim())
  throw new Error("Explicit helper PIDs require --helper-evidence describing ownership attribution.");
if (new Set(helperPids).size !== helperPids.length) throw new Error("A helper PID cannot belong to both apps or be repeated.");
for (const helper of helperPids) {
  if (!initial.some((row) => row.pid === helper)) throw new Error(`Helper PID ${helper} is not running`);
  if ([roots.electron.pid, roots.rust.pid, daemonPid].includes(helper)) throw new Error("A root/daemon PID cannot also be a helper.");
}
if (values["matched-workload"] && (!values["workload-description"]?.trim() || values["workload-description"].startsWith("Existing running apps;")))
  throw new Error("A matched workload needs a description.");
const observerPids = values["observer-pid"].map(pid);
const config = { electronPid: roots.electron.pid, rustPid: roots.rust.pid, daemonPid, electronHelpers, rustHelpers, observerPid: process.pid, observerPids };
const initialIdentities = new Map(initial.map((row) => [row.pid, `${row.started}|${row.executable}`]));
const started = new Date().toISOString();
const samples = [];
for (let index = 0; index < count; index++) {
  if (index) await delay(interval);
  const began = performance.now();
  const rows = readProcesses();
  const monotonicMs = (began + performance.now()) / 2;
  const alive = (id) => !id || rows.some((row) => row.pid === id && initialIdentities.get(id) === `${row.started}|${row.executable}`);
  const lost = [config.electronPid, config.rustPid, config.daemonPid, ...helperPids].filter((id) => id && !alive(id));
  const groups = selectProcessGroups(rows, {
    ...config,
    electronPid: alive(config.electronPid) ? config.electronPid : null,
    rustPid: alive(config.rustPid) ? config.rustPid : null,
    daemonPid: alive(config.daemonPid) ? config.daemonPid : null,
    electronHelpers: electronHelpers.filter(alive),
    rustHelpers: rustHelpers.filter(alive),
  });
  // Losing the known shared host makes the Electron tree ambiguous. Do not
  // silently begin charging restarted host/agent processes to the desktop shell.
  if (config.daemonPid && !alive(config.daemonPid)) groups.electronShell = [];
  const grouped = Object.fromEntries(
    Object.entries(groups).map(([name, processes]) => {
      const previous = samples.at(-1);
      const cpu = processes.length
        ? intervalCpu(previous?.groups[name].processes, processes, previous ? (monotonicMs - previous.monotonicMs) / 1000 : 0)
        : { value: null, reason: "No attributed running process" };
      return [
        name,
        {
          pids: processes.map((row) => row.pid),
          rssKiB: processes.length ? processes.reduce((sum, row) => sum + row.rssKiB, 0) : null,
          cpuPercentOfOneCore: cpu.value,
          cpuUnmeasuredReason: cpu.reason,
          processes,
        },
      ];
    }),
  );
  const associated = new Set(
    Object.values(groups)
      .flat()
      .map((row) => row.pid),
  );
  samples.push({
    index,
    takenAt: new Date().toISOString(),
    monotonicMs,
    groups: grouped,
    attributionLostPids: lost,
    unassociatedWebKitProcesses: rows.filter((row) => row.executable.includes("/WebKit.framework/") && !associated.has(row.pid)).length,
  });
}
const summaries = Object.fromEntries(
  Object.keys(samples[0].groups).map((name) => [
    name,
    {
      rssKiB: summarize(samples.map((sample) => sample.groups[name].rssKiB)),
      cpuPercentOfOneCore: summarize(samples.map((sample) => sample.groups[name].cpuPercentOfOneCore)),
      membershipChanged: samples.some((sample) => sample.groups[name].cpuUnmeasuredReason === "Process membership changed during interval"),
    },
  ]),
);
let startup = { status: "unmeasured", reason: "Collector never launches or restarts apps. Supply independently recorded startup observations." };
if (values["startup-observations"]) {
  const supplied = JSON.parse(readFileSync(path(values["startup-observations"]), "utf8"));
  if (!Array.isArray(supplied)) throw new Error("Startup observations must be a JSON array.");
  for (const row of supplied) {
    if (
      !["electron", "rust"].includes(row.app) ||
      !["cold", "warm"].includes(row.kind) ||
      !Number.isFinite(row.milliseconds) ||
      row.milliseconds < 0 ||
      typeof row.method !== "string" ||
      !row.method.trim()
    )
      throw new Error("Invalid startup observation: require app, kind, nonnegative milliseconds and method.");
  }
  startup = {
    status: "externally supplied",
    observations: supplied,
    summaries: Object.fromEntries(
      ["electron", "rust"].flatMap((app) =>
        ["cold", "warm"].map((kind) => [
          `${app}:${kind}`,
          summarize(supplied.filter((row) => row.app === app && row.kind === kind).map((row) => row.milliseconds)),
        ]),
      ),
    ),
  };
}
const report = {
  schemaVersion: 1,
  startedAt: started,
  finishedAt: new Date().toISOString(),
  machine: {
    platform: process.platform,
    osVersion: optional("/usr/bin/sw_vers", ["-productVersion"]),
    architecture: process.arch,
    model: optional("/usr/sbin/sysctl", ["-n", "hw.model"]),
    chip: optional("/usr/sbin/sysctl", ["-n", "machdep.cpu.brand_string"]),
    memoryBytes: Number(optional("/usr/sbin/sysctl", ["-n", "hw.memsize"])) || null,
    physicalCores: Number(optional("/usr/sbin/sysctl", ["-n", "hw.physicalcpu"])) || null,
    logicalCores: Number(optional("/usr/sbin/sysctl", ["-n", "hw.logicalcpu"])) || null,
  },
  workload: {
    matched: values["matched-workload"],
    attestation: values["matched-workload"] ? "operator supplied; not independently verified" : "unmatched observation only",
    description: values["workload-description"],
    samplingChangesUi: false,
    startsProviderTurns: false,
  },
  bundles: { electron, rust },
  attribution: {
    roots,
    excludedCollectorPid: process.pid,
    excludedObserverPids: observerPids,
    sharedDaemon: {
      pid: daemonPid,
      source: values["daemon-pid"] ? "explicit PID" : status.pid ? "live daemon:status" : "unmeasured",
      version: status.version || null,
    },
    electronHelperPids: electronHelpers,
    rustHelperPids: rustHelpers,
    helperEvidence: values["helper-evidence"] || null,
    rustFullFootprint: "unmeasured: no automatic attribution of launchd WebKit/GPU/network helpers; supplied helpers may still be incomplete",
    electronFullFootprint: daemonPid
      ? "observed process-tree RSS; external/reparented services may be missing"
      : "unmeasured: shared daemon PID unknown; shell process tree may contain shared work",
  },
  sampleCount: count,
  requestedIntervalMs: interval,
  summaries,
  samples,
  startup,
  unmeasured: {
    physicalFootprint: "RSS is not physical footprint, PSS or unique resident memory.",
    scrollFrameTimes: "No animation/frame-time instrumentation.",
    streamingLatency: "No provider turn is started.",
    fullRustBackend: "The same Node daemon serves both shells; this is not an all-Rust backend comparison.",
  },
  comparison: {
    speedup: null,
    memoryReduction: null,
    verdict: "No speedup or total memory reduction inferred. Inspect workload parity, process attribution and per-process samples first.",
  },
  caveats: [
    "RSS sums can count shared pages more than once; kernel compressed memory and GPU allocations are not captured.",
    "CPU is cumulative process CPU-time delta divided by wall time, 100% equals one core; ps CPU counters have finite precision.",
    "First CPU interval and any interval with process membership changes are unmeasured.",
    "The shared daemon and its children are separate costs; exclude agent processes from shell comparisons.",
    "Other running apps, thermal state, background agent activity and hidden windows can change results.",
    "Allocated bundle size includes exactly the installed files (including debug maps if packaged), not download size or final production release size.",
  ],
};
const json = JSON.stringify(report, null, 2) + "\n";
if (values.output) {
  const output = path(values.output);
  writeFileSync(output, json, { mode: 0o600 });
  console.log(output);
} else process.stdout.write(json);
