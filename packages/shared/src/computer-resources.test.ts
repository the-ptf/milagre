import assert from "node:assert/strict";
import test from "node:test";
import { MEASURING_TOOLTIP, formatDisk, formatMemory, partOpacity, resourceGauges } from "./computer-resources.ts";

const GIB = 1024 ** 3;

test("memory reads in binary units and disk in decimal ones, one decimal under 100", () => {
  assert.equal(formatMemory(24 * GIB), "24 GB");
  assert.equal(formatMemory(13.14 * GIB), "13.1 GB");
  assert.equal(formatMemory(860 * 1024 ** 2), "860 MB");
  assert.equal(formatDisk(971_350_180 * 1024), "995 GB");
  assert.equal(formatDisk(1_234_000_000_000), "1.2 TB");
  assert.equal(formatDisk(-5), "0 KB");
});

test("a row reads free of total, its bar splits Milagre, other and free, and its hover names both amounts", () => {
  const { memory, disk } = resourceGauges({
    memory: {
      total: 24 * GIB,
      available: 12 * GIB,
      milagre: 3 * GIB,
      parts: [
        { kind: "app", bytes: 1 * GIB, count: 0 },
        { kind: "claude", bytes: 2 * GIB, count: 3 },
      ],
    },
    disk: {
      total: 1000e9,
      available: 340e9,
      milagre: 45e9,
      parts: [
        { kind: "worktrees", bytes: 42e9, count: 38 },
        { kind: "data", bytes: 3e9, count: 0 },
      ],
      measuredAt: 1,
      measuring: false,
    },
  });
  assert.equal(memory.free, "12 GB");
  assert.equal(memory.of, "free of 24 GB");
  assert.equal(memory.low, false);
  assert.deepEqual(memory.shares, { milagre: 0.125, other: 0.375, free: 0.5 });
  assert.equal(memory.tooltip, "Milagre 3 GB · Other apps 9 GB");
  assert.equal(memory.context, "of 24 GB memory");
  assert.deepEqual(
    memory.parts.map(({ label, value }) => [label, value]),
    [
      ["Claude · 3 agents", "2 GB"],
      ["Milagre app", "1 GB"],
    ],
    "largest first",
  );
  assert.ok(Math.abs(memory.parts.reduce((sum, part) => sum + part.share, 0) - memory.shares.milagre) < 1e-9, "the slices fill Milagre's share");
  assert.deepEqual(
    memory.parts.map((part) => Math.round(part.portion * 100)),
    [67, 33],
    "a Milagre-only bar splits all of it",
  );
  assert.equal(disk?.free, "340 GB");
  assert.equal(disk?.of, "free of 1 TB");
  assert.equal(disk?.tooltip, "Milagre 45 GB · Everything else 615 GB");
  assert.deepEqual(
    disk?.parts.map(({ label }) => label),
    ["Worktrees · 38", "App data"],
  );
});

test("under a tenth free is low, a disk not measured yet spins, an unreadable disk has no row, and clones never pass what is in use", () => {
  const { memory, disk } = resourceGauges({
    memory: { total: 16 * GIB, available: 1 * GIB, milagre: null },
    disk: { total: 100, available: 90, milagre: null, parts: null, measuredAt: null, measuring: true },
  });
  assert.equal(memory.low, true);
  assert.equal(memory.milagre, null);
  assert.deepEqual(memory.parts, [], "an older host sends no parts");
  assert.equal(disk?.measuring, true);
  assert.equal(disk?.tooltip, MEASURING_TOOLTIP);
  assert.equal(resourceGauges({ memory: { total: 8, available: 4, milagre: 1 }, disk: null }).disk, null);
  const cloned = resourceGauges({
    memory: { total: 8, available: 4, milagre: 1 },
    disk: { total: 100, available: 90, milagre: 500, measuredAt: 1, measuring: false },
  }).disk;
  assert.deepEqual(cloned?.shares, { milagre: 0.1, other: 0, free: 0.9 });
  assert.equal(
    resourceGauges({ memory: { total: 2, available: 1, milagre: 1, parts: [{ kind: "terminals", bytes: 1, count: 1 }] }, disk: null }).memory.parts[0]?.label,
    "Terminals · 1",
  );
  assert.equal(partOpacity(0), 1);
  assert.equal(partOpacity(40), partOpacity(5), "past the last shade, the last one");
});
