const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const stub = path.join(__dirname, "fake-claude.cjs");

/** Sends `frames` to a stub and collects what it writes until it has answered `until` results. */
function converse(frames, { env = {}, until = 1 } = {}) {
  const child = spawn(process.execPath, [stub], { env: { ...process.env, PERF_INTERVAL_MS: "1", ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const seen = [];
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      seen.push(JSON.parse(line));
      if (seen.filter((frame) => frame.type === "result").length === until) child.stdin.end();
    });
    child.on("close", () => resolve(seen));
    for (const frame of frames) child.stdin.write(`${JSON.stringify(frame)}\n`);
  });
}

const deltas = (frames) =>
  frames
    .filter((frame) => frame.event?.type === "content_block_delta")
    .map((frame) => frame.event.delta.text)
    .join("");

test("answers initialize and model discovery as Claude Code does", async () => {
  const frames = await converse(
    [
      { type: "control_request", request_id: "a", request: { subtype: "initialize" } },
      { type: "control_request", request_id: "b", request: { subtype: "list_models" } },
      { type: "user", message: { content: "title this" } },
    ],
    { until: 1 },
  );
  const [initialized, init, models] = frames;
  assert.equal(initialized.response.request_id, "a");
  assert.equal(init.subtype, "init");
  assert.equal(models.response.response.models[0].value, "claude-perf");
});

test("a perf prompt streams a reply sized to the run and marks its turn", async () => {
  const marks = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-perf-test-"));
  try {
    const frames = await converse([{ type: "user", message: { content: "perf-run:mix:3" } }], {
      env: { PERF_SECONDS: "0.2", PERF_CHARS: "50", PERF_MARK_DIR: marks },
    });
    const text = deltas(frames);
    assert.ok(text.startsWith("perf-reply-3"));
    assert.equal(text.length, 200 * 50);
    assert.equal(frames.at(-1).result, text);
    assert.deepEqual(fs.readdirSync(marks).sort(), ["turn-3-end", "turn-3-start"]);
  } finally {
    fs.rmSync(marks, { recursive: true, force: true });
  }
});

test("a code run is one open fence, so the whole reply is a single growing block", async () => {
  const frames = await converse([{ type: "user", message: { content: "perf-run:code:1" } }], { env: { PERF_SECONDS: "0.2", PERF_CHARS: "50" } });
  assert.equal(deltas(frames).match(/```/g).length, 1);
});

test("any other prompt gets one line, so title and model probes don't stream for a whole run", async () => {
  const frames = await converse([{ type: "user", message: { content: "name this Chat" } }]);
  assert.equal(deltas(frames), "Perf stub.");
});

test("--version answers without reading input", async () => {
  const child = spawn(process.execPath, [stub, "--version"], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (data) => (out += data));
  await new Promise((resolve) => child.on("close", resolve));
  assert.match(out, /Claude Code perf stub/);
});
