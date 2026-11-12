#!/usr/bin/env node
// Owner takeover coverage: which daemon commands the GPUI Preview calls, and how many of them the Rust owner serves.
//
//   node experiments/rust-desktop/owner-coverage.mjs --gpui <rust-gpui dir> [--served <file>] [--list]
//
// "Calls" are the command names quoted in the GPUI live client and adapter sources that Electron's preload also
// sends (experiments/rust-daemon-client/src/renderer_commands.rs), plus the daemon-only names GPUI uses through
// InstalledOwner (project:open, daemon:snapshot, computers:*). "Served" is either a file with one method per line
// (for example a Rust owner's daemon:status methods) or, by default, the quoted names in the Rust runtime's actor and
// configured services. Both are literal-name scans: a name counts once whatever its arguments, so this measures
// the command surface, not behavior parity. Each served method still needs its own Node differential test.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
const experiments = path.dirname(here);
const NAME = /"([a-z]+(?:-[a-z]+)*:[a-z]+(?:-[a-z]+)*(?::[a-z-]+)?)"/g;
const DAEMON_ONLY = /^(project:open|daemon:[a-z-]+|computers:[a-z-]+)$/;
// Event channels, not commands.
const EVENTS = new Set(["computers:changed", "computers:event", "computers:pending", "computers:forgotten"]);
// Served by the shared wire server (rust-owner-wire) for every Rust composition.
const WIRE = ["daemon:status", "daemon:snapshot", "daemon:snapshot-page", "daemon:result-page", "daemon:stop"];

function rustFiles(target) {
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { recursive: true })
    .filter((name) => name.endsWith(".rs"))
    .map((name) => path.join(target, name));
}
function names(files) {
  const found = new Set();
  for (const file of files) for (const match of readFileSync(file, "utf8").matchAll(NAME)) found.add(match[1]);
  return found;
}

const { values } = parseArgs({ options: { gpui: { type: "string" }, served: { type: "string" }, list: { type: "boolean" } } });
if (!values.gpui) throw new Error("Pass --gpui <path to experiments/rust-gpui>");
const renderer = names([path.join(experiments, "rust-daemon-client/src/renderer_commands.rs")]);
const used = names(["live/src", "daemon-check/src"].map((dir) => path.join(values.gpui, dir)).flatMap(rustFiles));
const calls = [...used].filter((name) => !EVENTS.has(name) && (renderer.has(name) || DAEMON_ONLY.test(name))).sort();
const runtime = path.join(experiments, "rust-runtime/src");
const served = values.served
  ? new Set(
      readFileSync(values.served, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    )
  : new Set([
      ...WIRE,
      ...names(
        readdirSync(runtime)
          .filter((name) => /^(actor|chat_runtime|configured_.*)\.rs$/.test(name))
          .map((name) => path.join(runtime, name)),
      ),
    ]);
const covered = calls.filter((name) => served.has(name));
const missing = calls.filter((name) => !served.has(name));
console.log(
  JSON.stringify(
    { gpuiCalls: calls.length, served: covered.length, percent: Math.round((100 * covered.length) / calls.length), ...(values.list ? { missing } : {}) },
    null,
    2,
  ),
);
