import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

// A native <input type="range"> draws macOS's own control; every slider is primitives/RangeSlider (docs/agents/ui.md, Sliders).
const SRC = join(import.meta.dirname, "..", "..");
const OWNER = join(import.meta.dirname, "RangeSlider.tsx");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(tsx|ts|html)$/.test(entry.name) && !entry.name.endsWith(".test.ts") && path !== OWNER ? [path] : [];
  });
}

test('no component renders a native <input type="range">', () => {
  // JSX and HTML (type="range", type={"range"}), props objects (type: "range"), DOM code (.type = "range", setAttribute("type", "range")).
  const range = /\btype\s*[=:]\s*\{?\s*["'`]range["'`]|setAttribute\(\s*["'`]type["'`]\s*,\s*["'`]range["'`]/g;
  const offenders = sources(SRC).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(range)].map((match) => `${relative(SRC, path)}:${text.slice(0, match.index).split("\n").length}`);
  });
  assert.deepEqual(offenders, [], "Use RangeSlider from components/primitives/RangeSlider (its value plumbing is lib/use-slider.ts)");
});
