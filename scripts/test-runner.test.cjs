const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { shouldRetry, discoverUnitTests, discoverElectronChecks, selectTests, parseArgs, MANIFEST } = require("./test-runner.cjs");
const root = path.join(__dirname, "..");

test("discovers every node:test file and every Electron check", () => {
  const unit = discoverUnitTests(root);
  assert.ok(unit.includes("packages/shared/src/chats.test.ts"));
  assert.ok(unit.includes("apps/relay/src/room.test.mjs"));
  assert.ok(unit.includes("scripts/monorepo.test.cjs"));
  assert.ok(!unit.some((file) => file.includes("node_modules")));
  const electron = discoverElectronChecks(root);
  assert.ok(electron.includes("scripts/test-chat-titles.cjs"));
  assert.deepEqual(electron, [...electron].sort());
  assert.ok(!electron.includes("scripts/test-runner.cjs") && !electron.includes("scripts/test-runner.test.cjs"));
});

test("--only narrows by name and an unmatched name fails loudly", () => {
  const selected = selectTests({
    unit: ["a/b.test.ts"],
    electron: ["scripts/test-chat-titles.cjs", "scripts/test-ports.cjs"],
    filters: { ...parseArgs(["--only", "chat-titles"]), platform: "darwin", commandExists: () => true },
  });
  assert.deepEqual(selected.electron, ["scripts/test-chat-titles.cjs"]);
  assert.deepEqual(selected.unit, []);
  assert.throws(
    () => selectTests({ unit: [], electron: [], filters: { ...parseArgs(["--only", "nothing"]), platform: "darwin", commandExists: () => true } }),
    /no test matched "nothing"/,
  );
});

test("--workspace keeps that workspace only", () => {
  const selected = selectTests({
    unit: ["packages/core/src/a.test.cjs", "apps/mobile/src/b.test.ts"],
    electron: [],
    filters: { ...parseArgs(["--workspace", "core"]), platform: "darwin", commandExists: () => true },
  });
  assert.deepEqual(selected.unit, ["packages/core/src/a.test.cjs"]);
});

test("platform and tool prerequisites skip checks with a reason instead of failing them", () => {
  const electron = ["scripts/test-windows-cli.cjs", "scripts/test-ports.cjs", "scripts/test-desktop.cjs"];
  const onLinuxWithoutLsof = selectTests({
    unit: [],
    electron,
    filters: { ...parseArgs(["--electron"]), platform: "linux", commandExists: (name) => name !== "lsof" },
  });
  assert.deepEqual(onLinuxWithoutLsof.electron, ["scripts/test-desktop.cjs"]);
  assert.deepEqual(
    onLinuxWithoutLsof.skipped.map((item) => item.file),
    ["scripts/test-ports.cjs", "scripts/test-windows-cli.cjs"].sort(),
  );
  assert.equal(MANIFEST["test-desktop.cjs"].needsBuild, true);
  assert.deepEqual(MANIFEST["test-windows-cli.cjs"].platforms, ["win32"]);
});

test("unknown flags are rejected", () => {
  assert.throws(() => parseArgs(["--watchh"]), /Unknown option --watchh/);
});

test("--changed is rejected until it is implemented", () => {
  assert.throws(() => parseArgs(["--changed"]), /--changed is not implemented yet; use --only or --workspace/);
});

test("a platform skip prints the manifest reason when it has one", () => {
  const electron = ["scripts/test-sidebar-resize.cjs", "scripts/test-windows-cli.cjs"];
  const { skipped } = selectTests({ unit: [], electron, filters: { ...parseArgs(["--electron"]), platform: "linux", commandExists: () => true } });
  assert.deepEqual(skipped, [
    { file: "scripts/test-sidebar-resize.cjs", reason: `needs darwin: ${MANIFEST["test-sidebar-resize.cjs"].reason}` },
    { file: "scripts/test-windows-cli.cjs", reason: "needs win32" },
  ]);
  assert.match(MANIFEST["test-sidebar-resize.cjs"].reason, /#\d+/);
});

test("an Electron check is retried once, only on Linux CI", () => {
  assert.equal(shouldRetry({ platform: "linux", ci: "true", attempt: 1 }), true);
  assert.equal(shouldRetry({ platform: "linux", ci: "true", attempt: 2 }), false);
  assert.equal(shouldRetry({ platform: "linux", ci: undefined, attempt: 1 }), false);
  assert.equal(shouldRetry({ platform: "darwin", ci: "true", attempt: 1 }), false);
});

test("--shard partitions the unit files and the runnable Electron checks, balancing the Electron time", () => {
  const unit = discoverUnitTests(root);
  const electron = discoverElectronChecks(root);
  const select = (args) => selectTests({ unit, electron, filters: { ...parseArgs(args), platform: "linux", commandExists: () => true } });
  const all = select([]);
  const seconds = (file) => MANIFEST[path.basename(file)]?.seconds ?? 8;
  for (const count of [1, 2, 3, 8]) {
    const shards = Array.from({ length: count }, (_, i) => select(["--shard", `${i + 1}/${count}`]));
    // Every runnable test runs on exactly one shard, so nothing is dropped or run twice.
    assert.deepEqual(shards.flatMap((shard) => shard.unit).toSorted(), all.unit.toSorted(), `${count} shards`);
    assert.deepEqual(shards.flatMap((shard) => shard.electron).toSorted(), all.electron.toSorted(), `${count} shards`);
    for (const shard of shards) assert.deepEqual(shard.skipped, all.skipped);
    const files = shards.map((shard) => shard.unit.length);
    assert.ok(Math.max(...files) - Math.min(...files) <= 1, `${count} shards: ${files} unit files`);
    // No shard runs longer than the average plus one check, so the slowest runner sets the pace only as much as it must.
    const loads = shards.map((shard) => shard.electron.reduce((sum, file) => sum + seconds(file), 0));
    const average = loads.reduce((sum, load) => sum + load, 0) / count;
    assert.ok(Math.max(...loads) <= Math.max(average + 8, ...all.electron.map(seconds)), `${count} shards: ${loads} seconds`);
  }
});

test("a malformed --shard is rejected", () => {
  for (const value of ["0/2", "3/2", "2", "a/b", "1/0", "1.5/2"]) assert.throws(() => parseArgs(["--shard", value]), /--shard needs <index>\/<count>/, value);
  assert.throws(() => parseArgs(["--shard"]), /--shard needs a value/);
});

test("every Electron check that loads the built renderer asks for the build", () => {
  // Shards run on separate runners, so a check cannot rely on another check having built dist first.
  const fs = require("node:fs");
  for (const file of discoverElectronChecks(root)) {
    const name = path.basename(file);
    if (fs.readFileSync(path.join(root, file), "utf8").includes("apps/desktop/dist/index.html"))
      assert.equal(MANIFEST[name]?.needsBuild, true, `${name} loads apps/desktop/dist but is missing needsBuild in MANIFEST`);
  }
});
