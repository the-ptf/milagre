#!/usr/bin/env node
// Reads two existing capture reports, verifies the visible scenario, then samples
// the already-running processes. Does not launch or operate either application.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { summarize } from "./metrics.mjs";

const { values } = parseArgs({
  options: {
    "electron-report": { type: "string" },
    "rust-smoke": { type: "string" },
    "rust-pid": { type: "string" },
    "webkit-evidence": { type: "string" },
    output: { type: "string" },
    runs: { type: "string", default: "5" },
    "warmup-ms": { type: "string", default: "30000" },
  },
});
const read = (path) => JSON.parse(readFileSync(path, "utf8"));
for (const name of ["electron-report", "rust-smoke", "rust-pid", "webkit-evidence", "output"]) if (!values[name]) throw new Error(`Missing --${name}`);
const runs = Number(values.runs),
  warmup = Number(values["warmup-ms"]);
if (!Number.isInteger(runs) || runs < 1 || runs > 20 || !Number.isInteger(warmup) || warmup < 30000 || warmup > 300000)
  throw new Error("Invalid run count or warmup");
const electron = read(values["electron-report"]),
  rust = read(values["rust-smoke"]),
  webkit = read(values["webkit-evidence"]);
if (electron.stage !== "holding" || !electron.captures?.length || !rust.comparison?.passed)
  throw new Error("Both capture reports must be ready; Electron must be holding its final surface");
if (webkit.app?.pid !== Number(values["rust-pid"]) || webkit.matchingRootCount !== 1 || !webkit.suggestedHelperPids?.length)
  throw new Error("WebKit evidence does not identify this unique Rust root");
const a = electron.captures.at(-1),
  b = rust.comparison.captures.at(-1);
const match = {};
for (const name of ["chatKey", "panel"]) match[name] = a[name] === b[name];
for (const name of ["viewport", "font", "colors", "title", "panels", "devicePixelRatio"])
  match[name] = JSON.stringify(a.state[name]) === JSON.stringify(b.state[name]);
if (Object.values(match).some((value) => !value)) throw new Error(`Visible scenario mismatch: ${JSON.stringify(match)}`);
// Both native windows are hidden. Electron's paintWhenInitiallyHidden keeps its
// DOM visible while WebKit reports hidden; record that difference, never spoof it.
const visibility = { electron: a.state.visibility, rust: b.state.visibility, equal: a.state.visibility === b.state.visibility };
const directory = resolve(values.output);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const script = dirname(fileURLToPath(import.meta.url));
const checkout = resolve(script, "../../..");
const scenario = {
  chatKey: a.chatKey,
  panel: a.panel,
  title: a.state.title,
  viewport: a.state.viewport,
  font: a.state.font,
  colors: a.state.colors,
  visibility,
  nativeWindowsBackgrounded: true,
  displayScale: a.state.devicePixelRatio,
  match,
  provenance: "Electron limited capture shell and installed Rust app, actual shared production renderer and existing saved data",
  warmupMs: warmup,
};
const limitations = [
  "Current visible state matches; complete workloads do not. Electron capture shell omits production native services.",
  "Both windows are backgrounded; Chromium and WebKit can throttle differently. Foreground performance is unmeasured.",
  `DOM visibility is Electron=${visibility.electron}, Rust=${visibility.rust}; the current capture settings do not equalize engine scheduling.`,
  "Process ages and prior navigation differ. Root builds/tests were paused; other agents and backend builds may remain active.",
  "Shared Node host and tools are separate. This is not an all-Rust backend result or a standalone replacement comparison.",
  "RSS can double-count shared pages and does not measure total physical footprint, GPU memory or compressed memory.",
  "LaunchServices helper labels are explicit attribution evidence, not proof every external service is counted.",
];
console.log(JSON.stringify({ stage: "warming", scenario, electronPid: electron.pid, rustPid: Number(values["rust-pid"]), warmupMs: warmup }));
await delay(warmup);
const results = [],
  runFiles = [];
for (let index = 1; index <= runs; index++) {
  if (read(values["electron-report"]).stage !== "holding") throw new Error("Electron capture shell stopped before sampling completed");
  const output = join(directory, `run-${index}.json`);
  await promisify(execFile)(
    process.execPath,
    [
      join(script, "collect.mjs"),
      "--electron-app",
      join(checkout, "node_modules/electron/dist/Electron.app"),
      "--electron-pid",
      String(electron.pid),
      "--rust-pid",
      values["rust-pid"],
      "--observer-pid",
      String(process.pid),
      ...webkit.suggestedHelperPids.flatMap((pid) => ["--rust-helper-pid", String(pid)]),
      "--helper-evidence",
      `Exact LaunchServices Rust service identities in ${values["webkit-evidence"]}`,
      "--samples",
      "11",
      "--interval-ms",
      "1000",
      "--workload-description",
      `Same visible saved ${a.panel} at1440x900 in two background shells; native-service scope, process history and other backend work differ.`,
      "--output",
      output,
    ],
    { timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  const result = read(output);
  for (const group of ["electronShell", "rustShell", "sharedDaemon"]) {
    if (result.summaries[group].rssKiB.count !== 11 || result.summaries[group].membershipChanged)
      throw new Error(`Incomplete or changed ${group} attribution in run ${index}`);
  }
  results.push(result);
  runFiles.push(output);
  console.log(JSON.stringify({ stage: "sampled", run: index, runs }));
}
const summaries = {};
for (const group of ["electronShell", "rustShell", "sharedDaemon", "sharedDaemonChildren"]) {
  summaries[group] = {};
  for (const metric of ["rssKiB", "cpuPercentOfOneCore"]) {
    const series = results.map((result) => result.summaries[group][metric]);
    summaries[group][metric] = {
      runMedians: series.map((item) => item.median),
      medianOfRunMedians: summarize(series.map((item) => item.median)).median,
      observedMin: summarize(series.map((item) => item.min)).min,
      observedMax: summarize(series.map((item) => item.max)).max,
      measuredSamples: series.reduce((sum, item) => sum + item.count, 0),
    };
  }
}
const report = {
  schemaVersion: 1,
  startedAt: results[0].startedAt,
  finishedAt: results.at(-1).finishedAt,
  scenario,
  machine: results[0].machine,
  attribution: results[0].attribution,
  runs,
  samplesPerRun: 11,
  intervalMs: 1000,
  runFiles,
  summaries,
  limitations,
  startup: null,
  foregroundLatency: null,
  speedup: null,
  totalMemoryReduction: null,
};
writeFileSync(join(directory, "summary.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(join(directory, "summary.json"));
