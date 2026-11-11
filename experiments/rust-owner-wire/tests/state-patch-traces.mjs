// Record run-state projections from the real Node ChatHost with scripted providers.
// All writes stay in fresh temporary Projects, never an existing profile.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("../../rust-owner/fixtures/chat-node.cjs", import.meta.url));
const fixture = fileURLToPath(new URL("../../rust-owner/fixtures/chat-traces.json", import.meta.url));
const traces = JSON.parse(readFileSync(fixture, "utf8"));
const root = mkdtempSync(join(tmpdir(), "milagre-patch-traces-"));
const pairs = [];
try {
  for (const [index, trace] of traces.entries()) {
    const project = join(root, String(index));
    const run = (command) =>
      execFileSync(process.execPath, [driver, command, fixture, trace.name, project], {
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    run("seed");
    let before = { runs: {} };
    for (const line of run("run").trim().split("\n")) {
      const row = JSON.parse(JSON.parse(line).line);
      const after = { runs: row.runs };
      pairs.push({ before, after, trace: trace.name, op: row.op });
      before = after;
    }
  }
  process.stdout.write(JSON.stringify(pairs));
} finally {
  rmSync(root, { recursive: true, force: true });
}
