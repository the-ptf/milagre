import assert from "node:assert/strict";
import test from "node:test";
import { formatDisk, formatMemory, resourceMeters } from "./computer-resources.ts";

const GIB = 1024 ** 3;

test("memory reads in binary units and disk in decimal ones, one decimal under 100", () => {
  assert.equal(formatMemory(24 * GIB), "24 GB");
  assert.equal(formatMemory(13.14 * GIB), "13.1 GB");
  assert.equal(formatMemory(860 * 1024 ** 2), "860 MB");
  assert.equal(formatDisk(971_350_180 * 1024), "995 GB");
  assert.equal(formatDisk(1_234_000_000_000), "1.2 TB");
  assert.equal(formatDisk(-5), "0 KB");
});

test("meters split the total into Milagre, everything else in use, and free", () => {
  const [memory, disk] = resourceMeters({
    memory: { total: 24 * GIB, available: 12 * GIB, milagre: 3 * GIB },
    disk: { total: 1000e9, available: 340e9, milagre: 45e9, measuredAt: 1, measuring: false },
  });
  assert.deepEqual(memory, {
    label: "Memory",
    summary: "12 GB free of 24 GB",
    milagre: "Milagre 3 GB",
    shares: { milagre: 0.125, other: 0.375, free: 0.5 },
  });
  assert.equal(disk?.summary, "340 GB free of 1 TB");
  assert.equal(disk?.milagre, "Milagre 45 GB");
  assert.ok(Math.abs(disk!.shares.milagre + disk!.shares.other + disk!.shares.free - 1) < 1e-9);
});

test("a disk still being measured says so, an unreadable one has no meter, and cloned worktrees never pass what is in use", () => {
  const measuring = resourceMeters({
    memory: { total: 8 * GIB, available: 2 * GIB, milagre: null },
    disk: { total: 100, available: 90, milagre: null, measuredAt: null, measuring: true },
  });
  assert.equal(measuring[0]?.milagre, null, "no process list, no Milagre line");
  assert.equal(measuring[1]?.milagre, "Milagre: measuring…");
  assert.equal(resourceMeters({ memory: { total: 8, available: 4, milagre: 1 }, disk: null }).length, 1);
  const [, cloned] = resourceMeters({
    memory: { total: 8, available: 4, milagre: 1 },
    disk: { total: 100, available: 90, milagre: 500, measuredAt: 1, measuring: false },
  });
  assert.deepEqual(cloned?.shares, { milagre: 0.1, other: 0, free: 0.9 });
});
