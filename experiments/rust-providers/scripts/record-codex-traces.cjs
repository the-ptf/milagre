#!/usr/bin/env node
// Records every call the Node test suites make to the Codex event mapper (events.cjs mapCodexNotification) and the
// subagent helpers (subagents.cjs codexSubagents / settleSubagents) as self-contained cases:
//   { fn, method?, params?, status?, before, clock, events, after }
// `before`/`after` are the mapper state with Maps and Sets tagged ({ $map: [[k, v]] }, { $set: [...] }); `clock` is
// every time the call read (Date.now or state.now), in order, so a port can replay them.
//
// Preloaded into the existing test files, which run unchanged (they spawn only the repo's fake app-server):
//   NODE_PATH=<checkout>/node_modules node experiments/rust-providers/scripts/record-codex-traces.cjs
// Writes tests/fixtures/conformance/codex-event-traces.json. Nothing outside it is written.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../../..");
const agents = path.join(root, "packages/core/src/agents");
const out = path.join(__dirname, "../tests/fixtures/conformance/codex-event-traces.json");
const TEST_FILES = ["events.test.cjs", "subagents.test.cjs", "codex-provider.test.cjs", "chat-subagent-recovery.test.cjs"];
// Sequences the suites don't reach (codex-event-scenarios.cjs), recorded the same way.
const SCENARIOS = path.join(__dirname, "codex-event-scenarios.cjs");

if (process.env.MILAGRE_TRACE_FILE) {
  install(process.env.MILAGRE_TRACE_FILE);
} else {
  const parts = [];
  for (const file of [...TEST_FILES, SCENARIOS]) {
    const part = path.join(require("node:os").tmpdir(), `milagre-trace-${process.pid}-${path.basename(file)}.json`);
    const run = spawnSync(process.execPath, ["--require", __filename, path.isAbsolute(file) ? file : path.join(agents, file)], {
      cwd: root,
      env: { ...process.env, MILAGRE_TRACE_FILE: part },
      encoding: "utf8",
      timeout: 300_000,
    });
    const summary = /pass (\d+)[\s\S]*fail (\d+)/.exec(run.stdout ?? "");
    console.log(`${path.basename(file)}: exit ${run.status}${summary ? `, pass ${summary[1]}, fail ${summary[2]}` : ""}`);
    if (run.status !== 0) process.stderr.write(run.stderr.slice(-2000));
    if (fs.existsSync(part)) {
      parts.push(...JSON.parse(fs.readFileSync(part, "utf8")));
      fs.rmSync(part);
    }
  }
  // Identical cases add nothing; keep the first of each.
  const seen = new Set();
  const cases = parts.filter((entry) => {
    const key = JSON.stringify([entry.fn, entry.method, entry.params, entry.status, entry.before, entry.clock]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  fs.writeFileSync(
    out,
    `${JSON.stringify({ generatedFrom: [...TEST_FILES.map((f) => `packages/core/src/agents/${f}`), "experiments/rust-providers/scripts/codex-event-scenarios.cjs"], cases })}\n`,
  );
  console.log(`wrote ${cases.length} cases to ${path.relative(root, out)}`);
}

function install(file) {
  const cases = [];
  const subagents = require(path.join(agents, "subagents.cjs"));
  let depth = 0;
  const record = (fn, call, state, extra) => {
    const before = snapshot(state);
    const clock = [];
    const realNow = Date.now;
    Date.now = () => {
      const value = realNow.call(Date);
      clock.push(value);
      return value;
    };
    const ownNow = state && Object.prototype.hasOwnProperty.call(state, "now") ? state.now : undefined;
    if (typeof ownNow === "function")
      state.now = () => {
        const value = ownNow();
        clock.push(value);
        return value;
      };
    depth += 1;
    let events;
    try {
      events = call();
    } finally {
      depth -= 1;
      Date.now = realNow;
      if (typeof ownNow === "function") state.now = ownNow;
    }
    if (depth === 0) cases.push({ fn, ...extra, before, clock, events: plain(events), after: snapshot(state) });
    return events;
  };
  const codexSubagents = subagents.codexSubagents;
  subagents.codexSubagents = (method, params, state) =>
    record("codexSubagents", () => codexSubagents(method, params, state), state, { method, params: plain(params) });
  const settle = subagents.settleSubagents;
  subagents.settleSubagents = (state, status) => record("settleSubagents", () => settle(state, status), state, { status });
  const events = require(path.join(agents, "events.cjs"));
  const map = events.mapCodexNotification;
  events.mapCodexNotification = (method, params, state) =>
    record("mapCodexNotification", () => map(method, params, state), state, { method, params: plain(params) });
  process.on("exit", () => fs.writeFileSync(file, JSON.stringify(cases)));
}

// JSON with Maps and Sets tagged; functions and undefined dropped.
function snapshot(value) {
  return plain(value);
}

function plain(value) {
  if (value === undefined || typeof value === "function") return undefined;
  if (value instanceof Map) return { $map: [...value.entries()].map(([k, v]) => [k, plain(v) ?? null]) };
  if (value instanceof Set) return { $set: [...value.values()].map((v) => plain(v) ?? null) };
  if (Array.isArray(value)) return value.map((v) => plain(v) ?? null);
  if (value && typeof value === "object") {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      const converted = plain(v);
      if (converted !== undefined) result[k] = converted;
    }
    return result;
  }
  return value;
}
