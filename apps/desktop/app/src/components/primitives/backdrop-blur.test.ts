import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

// Backdrop blur comes in three strengths, the --blur-overlay, --blur-chip and --blur-edge tokens (see docs/agents/ui.md).
// A progressive blur scales --blur-edge per layer, as calc(var(--blur-edge) * ...).
const SRC = join(import.meta.dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(tsx|css)$/.test(entry.name) ? [path] : [];
  });
}

function offenders(pattern: RegExp) {
  return sources(SRC).flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) => (pattern.test(line) ? [`${relative(SRC, path)}:${index + 1}`] : [])),
  );
}

test("backdrop blur uses a blur token", () => {
  assert.deepEqual(offenders(/backdrop-blur(?!-(overlay|chip|edge)\b)/), [], "Use backdrop-blur-overlay, -chip or -edge");
  assert.deepEqual(
    offenders(/backdrop-filter:\s*blur\((?!var\(--blur-(overlay|chip|edge)\)|calc\(var\(--blur-edge\) \* )/),
    [],
    "Use blur(var(--blur-overlay)), (--blur-chip) or (--blur-edge)",
  );
});

// The production CSS minifier keeps only the last of `backdrop-filter` and `-webkit-backdrop-filter` in a rule, and
// Chromium ignores the prefixed one: beta.33's composer, Details glass, top band, status pills and palette backdrop had
// no blur in the packaged app. Electron is Chromium; the build adds the prefix itself where it needs one.
test("backdrop-filter is written without the -webkit- prefix", () => {
  assert.deepEqual(offenders(/-webkit-backdrop-filter\s*:/), [], "Drop -webkit-backdrop-filter: the minifier keeps it over backdrop-filter");
});
