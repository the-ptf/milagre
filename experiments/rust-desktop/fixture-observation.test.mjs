import assert from "node:assert/strict";
import test from "node:test";
import { installedApplications, preferenceObservation, fixtureFailure } from "./fixture-observation.mjs";

test("live app metadata includes only installed executable identities, not fixture or command arguments", () => {
  const result = installedApplications(`16468 1 Tue Nov 10 23:32:28 2026 /Users/test/Applications/Milagre Rust.app/Contents/MacOS/milagre-rust
55099 1 Tue Nov 10 08:32:03 2026 /Applications/Milagre.app/Contents/MacOS/Milagre
55108 55099 Tue Nov 10 08:32:04 2026 /Applications/Milagre.app/Contents/MacOS/Milagre
100 1 Tue Nov 10 08:32:04 2026 /private/tmp/staging/Milagre Rust Fixture.app/Contents/MacOS/milagre-rust-fixture
101 1 Tue Nov 10 08:32:04 2026 /usr/bin/unrelated`);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], {
    pid: 16468,
    parentPid: 1,
    started: "Tue Nov 10 23:32:28 2026",
    executable: "/Users/test/Applications/Milagre Rust.app/Contents/MacOS/milagre-rust",
  });
  assert.equal(result[2].parentPid, 55099);
  assert.equal(installedApplications(Array(100).fill("1 1 Tue Nov 10 08:32:04 2026 /Applications/Milagre.app/Contents/MacOS/Milagre").join("\n")).length, 16);
});
const file = { path: "/observed/preferences.json", bytes: 20, sha256: "before", mtimeMs: 1, readStable: true };
const absent = { applications: [] };
const active = { applications: [{ pid: 1 }] };
test("changed content is noisy and unattributed with or without live applications", () => {
  for (const processes of [absent, active]) {
    const result = preferenceObservation([file], [{ ...file, sha256: "after", mtimeMs: 2 }], processes, processes);
    assert.equal(result.status, "environment-noisy");
    assert.equal(result.contentUnchanged, false);
    assert.equal(result.attribution, "unattributed");
    assert.equal(result.isolationClaim, false);
  }
});
test("same bytes do not hide a metadata change or an unstable read", () => {
  for (const after of [
    { ...file, mtimeMs: 2 },
    { ...file, readStable: false },
  ]) {
    const result = preferenceObservation([file], [after], active, active);
    assert.equal(result.status, "environment-noisy");
    assert.equal(result.contentUnchanged, true);
  }
});
test("quiet observations retain the limited scope, and failed process discovery is visible", () => {
  const result = preferenceObservation([file], [file], absent, { applications: [], error: "unavailable" });
  assert.equal(result.status, "no-change-observed");
  assert.equal(result.isolationClaim, false);
  assert.equal(result.processMetadataAvailable, false);
});
test("failure summary surfaces the native stage and separates timeout termination", () => {
  const entry = {
    status: { code: 1, signal: null },
    report: { stages: [{ phase: 0, passed: false, error: "Expected one listed Chat; observed 0", send: { stage: "sidebar-after-send" } }] },
  };
  assert.deepEqual(fixtureFailure(entry), {
    reason: "Expected one listed Chat; observed 0",
    phase: 0,
    stage: "sidebar-after-send",
    exitCode: 1,
    signal: null,
    timedOut: false,
  });
  const killed = fixtureFailure({ ...entry, timedOut: true, status: { code: null, signal: "SIGKILL" } });
  assert.match(killed.reason, /external observer timeout/);
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(killed.timedOut, true);
  assert.equal(fixtureFailure({ status: { code: 0 }, report: { passed: false } }).reason, "native report did not pass");
});
