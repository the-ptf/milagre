#!/usr/bin/env node
// Read-only LaunchServices evidence. Never assigns all WebKit processes to Rust.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { parseProcesses } from "./metrics.mjs";

const { values } = parseArgs({ options: { "rust-pid": { type: "string" }, output: { type: "string" } } });
const rootPid = Number(values["rust-pid"]);
if (!Number.isSafeInteger(rootPid) || rootPid < 1) throw new Error("Supply --rust-pid PID for the running installed Rust shell.");
const run = (program, args) => execFileSync(program, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const processes = parseProcesses(run("/bin/ps", ["-axo", "pid=,ppid=,rss=,time=,lstart=,comm="]));
const root = processes.find((item) => item.pid === rootPid);
if (!root) throw new Error("Rust PID is not running.");
function appInfo(process) {
  try {
    const identity = run("/usr/bin/lsappinfo", ["find", `pid=${process.pid}`]);
    if (!identity.startsWith("ASN:")) return null;
    const details = run("/usr/bin/lsappinfo", ["info", identity]);
    return { ...process, identity, details };
  } catch {
    return null;
  }
}
const app = appInfo(root);
if (!app?.details.includes('bundleID="com.milagre.rust-poc"')) throw new Error("LaunchServices does not identify this PID as Milagre Rust.");
const matchingRoots = processes.filter((item) => item.executable === root.executable);
const candidates = processes
  .filter((item) => /com\.apple\.WebKit\.(GPU|WebContent|Networking)$/.test(item.executable))
  .map(appInfo)
  .filter(Boolean);
const namedHelpers = candidates.filter((item) => /-"Milagre_Rust_(Graphics_and_Media|Web_Content|Networking)":?$/.test(item.identity));
const report = {
  schemaVersion: 1,
  at: new Date().toISOString(),
  method: "Targeted lsappinfo find pid=PID then lsappinfo info ASN. Only exact Milagre_Rust service labels selected.",
  app,
  matchingRootCount: matchingRoots.length,
  helpers: namedHelpers,
  suggestedHelperPids: matchingRoots.length === 1 ? namedHelpers.map((item) => item.pid) : [],
  excludedOtherWebKitCount: candidates.length - namedHelpers.length,
  limitations: [
    "LaunchServices names identify which app each helper advertises. They are attribution evidence, not direct IPC ownership proof.",
    "More than one Rust root makes the evidence ambiguous; no helper PIDs suggested then.",
    "Processes can restart. Re-run immediately before collection; collect.mjs rejects PID identity changes.",
    "The OS responsibility API can inherit the launching Electron agent as owner even for Rust helpers. It must not be used alone.",
    "This discovery does not make an unmatched UI workload a valid speed or total memory comparison.",
  ],
};
const json = JSON.stringify(report, null, 2) + "\n";
if (values.output) writeFileSync(values.output, json, { mode: 0o600 });
else process.stdout.write(json);
