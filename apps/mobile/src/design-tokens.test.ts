import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { radius, type } from "./design-tokens.ts";

// Literal font sizes and corner radii stay on the scale in design-tokens.ts. Styles from before the scale are counted
// per file in design-tokens.baseline.json; a file may only go down. After moving a file onto the scale, lower its
// count with UPDATE_DESIGN_TOKENS=1 node --test src/design-tokens.test.ts (from apps/mobile).
const SRC = import.meta.dirname;
const BASELINE = join(SRC, "design-tokens.baseline.json");
const SIZES = new Set<number>(Object.values(type));
const RADII = new Set<number>([0, ...Object.values(radius)]);

const RULES = {
  font: { pattern: /\bfontSize:\s*(\d+(?:\.\d+)?)\b/g, allowed: SIZES },
  radius: { pattern: /\b(?:border(?:Top|Bottom)?(?:Left|Right)?Radius|sheetCornerRadius):\s*(\d+(?:\.\d+)?)\b/g, allowed: RADII },
} as const;
type Rule = keyof typeof RULES;
type Counts = Record<Rule, Record<string, number>>;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function count(): Counts {
  const counts: Counts = { font: {}, radius: {} };
  for (const path of sources(SRC).toSorted()) {
    const text = readFileSync(path, "utf8");
    for (const rule of Object.keys(RULES) as Rule[]) {
      const { pattern, allowed } = RULES[rule];
      const found = [...text.matchAll(pattern)].filter((match) => !allowed.has(Number(match[1]))).length;
      if (found) counts[rule][relative(SRC, path)] = found;
    }
  }
  return counts;
}

const counts = count();
if (process.env.UPDATE_DESIGN_TOKENS === "1") writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Counts;

test("no file adds an off-scale font size or corner radius", () => {
  const grown = (Object.keys(RULES) as Rule[]).flatMap((rule) =>
    Object.entries(counts[rule]).flatMap(([file, n]) => (n > (baseline[rule][file] ?? 0) ? [`${file}: ${rule} ${baseline[rule][file] ?? 0} → ${n}`] : [])),
  );
  assert.deepEqual(grown, [], "Use the sizes and radii in design-tokens.ts (.interface-design/system.md)");
});

test("the baseline shrinks as files move onto the scale", () => {
  const stale = (Object.keys(RULES) as Rule[]).flatMap((rule) =>
    Object.entries(baseline[rule]).flatMap(([file, n]) => ((counts[rule][file] ?? 0) < n ? [`${file}: ${rule} ${n} → ${counts[rule][file] ?? 0}`] : [])),
  );
  assert.deepEqual(stale, [], "Lower the baseline: UPDATE_DESIGN_TOKENS=1 node --test src/design-tokens.test.ts");
});
