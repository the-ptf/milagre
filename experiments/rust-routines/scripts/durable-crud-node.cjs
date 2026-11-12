// Actual production store in a fresh temporary directory. No host or scheduler.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRoutineStore } = require("../../../packages/core/src/routines/store.cjs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-routine-crud-node-"));
const file = path.join(root, "routines.json");
let now = input.now;
let calls = 0;
const observations = [];
try {
  const store = createRoutineStore({ file, now: () => now, id: () => input.ids[calls++] });
  for (const operation of input.operations) {
    now = operation.now;
    let result;
    try {
      const value =
        operation.method === "createPaused" ? store.update(store.create(...operation.args).id, { enabled: false }) : store[operation.method](...operation.args);
      result = { ok: value === undefined ? null : value };
    } catch (error) {
      result = { error: error.message };
    }
    observations.push({ result, file: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null });
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ observations, idCalls: calls, rootRemoved: !fs.existsSync(root) }));
