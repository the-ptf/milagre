// Real production store oracle. All writes use a new private temporary directory.
// No Node behavior is reimplemented and no intentional Rust refusal is called parity.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const manifest = require("../store-oracle-manifest.json");
const root = path.resolve(__dirname, "../../..");
assert.equal(process.argv.length, 2, "Store oracle accepts no path or executable arguments");
assert.equal(Object.keys(manifest.sources).length, 15, "Complete source pin inventory");
for (const [file, digest] of Object.entries({ ...manifest.sources, ...manifest.copiedSources }))
  assert.equal(
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(root, file)))
      .digest("hex"),
    digest,
    `Source drift: ${file}`,
  );
for (const [name, version] of [
  ["node", process.version],
  ["icu", process.versions.icu],
  ["tz", process.versions.tz],
])
  assert.equal(version, manifest[name], `Oracle ${name} version drift`);
const requireStore = createRequire(path.join(root, "packages/core/src/routines/store.cjs"));
for (const [name, file] of Object.entries(manifest.resolvedModules))
  assert.equal(fs.realpathSync(requireStore.resolve(name)), fs.realpathSync(path.join(root, file)), `Unexpected resolved module: ${name}`);
const { createRoutineStore } = requireStore("./store.cjs");
const allowed = new Set([
  "create",
  "upsertHeartbeat",
  "update",
  "list",
  "get",
  "runs",
  "remove",
  "claimDue",
  "startRun",
  "finishRun",
  "expireDue",
  "complete",
  "recoverInterrupted",
  "pause",
  "setLastError",
  "getRun",
  "hasRun",
  "runningCount",
  "hasPending",
  "wasRemoved",
  "attachChat",
  "setRunTitle",
]);
const MAX_LINE = 4 * 1024 * 1024;
const MAX_RESULT = 32 * 1024 * 1024;
const nativeWrite = fs.writeFileSync;
const nativeRename = fs.renameSync;
let directory;
let file;
let store;
let now;
let ids = 0;
let saves = 0;
let effects = [];
let fault;
let faultReached = false;
const tracked = new Set();
const remember = (bytes) => {
  if (bytes === null) return;
  let value;
  try {
    value = JSON.parse(bytes);
  } catch {
    return;
  }
  if (Array.isArray(value?.routines)) for (const routine of value.routines) if (typeof routine?.id === "string") tracked.add(routine.id);
  for (const field of ["runs", "removed"])
    if (value?.[field] && typeof value[field] === "object" && !Array.isArray(value[field])) for (const id of Object.keys(value[field])) tracked.add(id);
};
const image = () => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const options = () => ({
  file,
  now: () => now,
  id: () => `id${++ids}`,
  onPurged: (value) => effects.push({ kind: "purged", value: structuredClone(value) }),
  onRunsDropped: (value) => effects.push({ kind: "dropped", value: structuredClone(value) }),
  onEnded: (value) => effects.push({ kind: "ended", value: structuredClone(value) }),
});
fs.writeFileSync = function (target, ...args) {
  if (fault === "write" && String(target).startsWith(`${file}.`) && String(target).endsWith(".tmp")) {
    fault = undefined;
    faultReached = true;
    nativeWrite.call(fs, target, "{", { mode: 0o600 });
    throw Object.assign(new Error("EIO: injected writeFileSync failure"), { code: "EIO" });
  }
  return nativeWrite.call(fs, target, ...args);
};
fs.renameSync = function (from, to) {
  if (to === file && fault === "rename") {
    fault = undefined;
    faultReached = true;
    throw Object.assign(new Error("EIO: injected renameSync failure"), { code: "EIO" });
  }
  const result = nativeRename.call(fs, from, to);
  if (to === file) saves += 1;
  return result;
};
function perform(command) {
  assert.ok(command && typeof command === "object" && !Array.isArray(command), "Expected one command object");
  assert.ok(command.fail === undefined || command.fail === "write" || command.fail === "rename", "Unknown injected fault");
  if (command.now !== undefined) {
    assert.ok(Number.isSafeInteger(command.now), "Fixture clock must be integer milliseconds");
    now = command.now;
  }
  effects = [];
  fault = command.fail;
  faultReached = false;
  let result;
  try {
    let value;
    if (command.op === "open") {
      assert.equal(directory, undefined, "Only the first command can open a store");
      assert.ok(Number.isSafeInteger(now), "Initial clock missing");
      assert.ok(command.seed === null || typeof command.seed === "string", "Seed must be null or raw JSON text");
      directory = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-routine-oracle-"));
      fs.chmodSync(directory, 0o700);
      file = path.join(directory, "routines.json");
      if (command.seed !== null) {
        assert.ok(Buffer.byteLength(command.seed) <= MAX_LINE, "Seed image bound");
        nativeWrite.call(fs, file, command.seed, { mode: 0o600 });
        remember(command.seed);
      }
      store = createRoutineStore(options());
      value = null;
    } else {
      assert.ok(store, "Open the store before commands");
      if (command.op === "reload") {
        remember(image());
        store = createRoutineStore(options());
        value = null;
      } else {
        assert.ok(allowed.has(command.op), "Unsupported harness command");
        assert.ok(Array.isArray(command.args ?? []), "Command arguments must be an array");
        value = store[command.op](...(command.args ?? []));
      }
    }
    result = value === undefined ? { ok: null, undefined: true } : { ok: value };
  } catch (error) {
    if (error.name === "AssertionError") throw error;
    result = { error: error.message };
  } finally {
    fault = undefined;
  }
  // The production writer must remove its own partial temporary file after either failure.
  if (faultReached) assert.ok(!fs.readdirSync(directory).some((name) => name.endsWith(".tmp")), "Failed Node write leaked its temp file");
  const bytes = image();
  remember(bytes);
  if (!store) return { result };
  const list = store.list();
  for (const routine of list) tracked.add(routine.id);
  return {
    result,
    file: bytes,
    list,
    views: [...tracked]
      .sort()
      .map((id) => ({ id, routine: store.get(id), runs: store.runs(id), pending: store.hasPending(id), removed: store.wasRemoved(id) })),
    runningCount: store.runningCount(),
    effects,
    saves,
    idCalls: ids,
  };
}
async function main() {
  let pending = Buffer.alloc(0);
  let lines = 0;
  const line = async (bytes) => {
    assert.ok(bytes.length > 0 && bytes.length <= MAX_LINE, "Oracle line bound");
    assert.ok(++lines <= 4096, "Oracle command count bound");
    const result = `${JSON.stringify(perform(JSON.parse(bytes.toString("utf8"))))}\n`;
    assert.ok(Buffer.byteLength(result) <= MAX_RESULT, "Oracle observation bound");
    if (!process.stdout.write(result)) await new Promise((resolve) => process.stdout.once("drain", resolve));
  };
  for await (const chunk of process.stdin) {
    let start = 0;
    for (let end; (end = chunk.indexOf(10, start)) !== -1; start = end + 1) {
      assert.ok(pending.length + end - start <= MAX_LINE, "Oracle line bound");
      await line(Buffer.concat([pending, chunk.subarray(start, end)]));
      pending = Buffer.alloc(0);
    }
    assert.ok(pending.length + chunk.length - start <= MAX_LINE, "Oracle line bound");
    pending = Buffer.concat([pending, chunk.subarray(start)]);
  }
  if (pending.length) await line(pending);
  assert.ok(lines > 0, "Empty oracle input");
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.writeFileSync = nativeWrite;
    fs.renameSync = nativeRename;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });
