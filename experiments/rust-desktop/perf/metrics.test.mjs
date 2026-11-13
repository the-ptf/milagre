import test from "node:test";
import assert from "node:assert/strict";
import { cpuSeconds, parseProcesses, selectProcessGroups, intervalCpu, summarize } from "./metrics.mjs";
const row = (pid, parentPid, executable = "app") => ({ pid, parentPid, executable, started: "Tue Nov 10 20:00:00 2026", cpuSeconds: 2, rssKiB: 100 });

test("macOS ps parser preserves executable spaces and CPU time units", () => {
  assert.equal(cpuSeconds("0:12.50"), 12.5);
  assert.equal(cpuSeconds("1-02:03:04.5"), 93784.5);
  const parsed = parseProcesses("  12  1  2048  0:01.25 Tue Nov 10 20:00:00 2026 /Applications/Milagre Rust.app/Contents/MacOS/milagre-rust\n");
  assert.equal(parsed[0].executable, "/Applications/Milagre Rust.app/Contents/MacOS/milagre-rust");
  assert.equal(parsed[0].cpuSeconds, 1.25);
  assert.throws(() => parseProcesses("unexpected ps output"));
});

test("shared host and agent-started Rust are not charged to Electron; unrelated WebKit stays unassigned", () => {
  const rows = [row(10, 1), row(11, 10), row(12, 11), row(13, 10), row(20, 12), row(21, 20), row(22, 1, "WebKit"), row(30, 12), row(31, 30)];
  const config = { electronPid: 10, daemonPid: 11, rustPid: 20, observerPid: 30 };
  const groups = selectProcessGroups(rows, config);
  assert.deepEqual(
    groups.electronShell.map((r) => r.pid),
    [10, 13],
  );
  assert.deepEqual(
    groups.rustShell.map((r) => r.pid),
    [20, 21],
  );
  assert.deepEqual(
    groups.sharedDaemon.map((r) => r.pid),
    [11],
  );
  assert.deepEqual(
    groups.sharedDaemonChildren.map((r) => r.pid),
    [12],
  );
  assert.ok(
    !Object.values(groups)
      .flat()
      .some((r) => r.pid === 22),
  );
  assert.deepEqual(
    selectProcessGroups(rows, { ...config, rustHelpers: [22] }).rustShell.map((r) => r.pid),
    [20, 21, 22],
  );
});

test("CPU interval refuses process churn and PID reuse; missing values never become zeros", () => {
  const before = [row(10, 1)];
  assert.equal(intervalCpu(before, [{ ...before[0], cpuSeconds: 2.5 }], 2).value, 25);
  assert.equal(intervalCpu(before, [{ ...before[0], started: "Tue Nov 10 20:01:00 2026" }], 2).value, null);
  assert.equal(intervalCpu(before, [], 2).value, null);
  assert.equal(intervalCpu(before, [{ ...before[0], cpuSeconds: 1 }], 2).value, null);
  assert.deepEqual(summarize([null, undefined]), { status: "unmeasured", count: 0, median: null, min: null, max: null });
  assert.deepEqual(summarize([4, 1, 3, 2, null]), { status: "measured", count: 4, median: 2.5, min: 1, max: 4 });
});

test("an agent-launched Electron capture shell is charged once, separately from shared daemon work", () => {
  const rows = [row(10, 1), row(11, 10), row(12, 11), row(20, 12), row(21, 20), row(30, 12), row(31, 30), row(32, 1, "WebKit"), row(40, 12), row(41, 40)];
  const groups = selectProcessGroups(rows, { electronPid: 20, daemonPid: 11, rustPid: 30, rustHelpers: [32], observerPid: 41, observerPids: [40] });
  assert.deepEqual(
    groups.electronShell.map((item) => item.pid),
    [20, 21],
  );
  assert.deepEqual(
    groups.rustShell.map((item) => item.pid),
    [30, 31, 32],
  );
  assert.deepEqual(
    groups.sharedDaemon.map((item) => item.pid),
    [11],
  );
  assert.deepEqual(
    groups.sharedDaemonChildren.map((item) => item.pid),
    [12],
  );
  const all = Object.values(groups)
    .flat()
    .map((item) => item.pid);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(selectProcessGroups(rows, { electronPid: 11, daemonPid: 11, rustPid: 30 }).electronShell, []);
});
