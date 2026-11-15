const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUpdateLog } = require("./update-log.cjs");

test("updates.log keeps one timestamped line per step, rolls over when full, and never throws", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "updates.log");
  const log = createUpdateLog(file, { now: () => new Date("2026-11-15T06:00:27.000Z"), maxBytes: 200 });
  log.line("installing 0.232.0-beta.35");
  log.logger.error(new Error("Code signature at URL\nfile:///x did not pass validation"));
  log.logger.info({ version: "0.232.0-beta.35" });
  assert.deepEqual(fs.readFileSync(file, "utf8").trim().split("\n"), [
    "2026-11-15T06:00:27.000Z installing 0.232.0-beta.35",
    "2026-11-15T06:00:27.000Z electron-updater error: Code signature at URL file:///x did not pass validation",
    '2026-11-15T06:00:27.000Z electron-updater: {"version":"0.232.0-beta.35"}',
  ]);
  log.line("x".repeat(300));
  log.line("after the roll");
  assert.ok(fs.existsSync(`${file}.1`), "the full log moved aside");
  assert.equal(fs.readFileSync(file, "utf8").trim(), "2026-11-15T06:00:27.000Z after the roll");
  // A folder where the log should be: the write fails quietly.
  const broken = createUpdateLog(dir);
  assert.doesNotThrow(() => broken.line("ignored"));
});
