import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

// Font sizes and corner radii come from the scale in .interface-design/system.md: text-10…text-26 and the radius
// tokens (inline, chip, control, card, window, full). Code from before the scale is counted per file in
// design-tokens.baseline.json; a file may only go down. After moving a file onto the scale, lower its count with
// UPDATE_DESIGN_TOKENS=1 node --test app/src/components/primitives/design-tokens.test.ts (from apps/desktop).
const SRC = join(import.meta.dirname, "..", "..");
const BASELINE = join(import.meta.dirname, "design-tokens.baseline.json");

const RULES = {
  // An arbitrary pixel size or a Tailwind default size: text-[12.5px], text-xs, text-sm …
  font: /(?<![\w-])text-(?:\[\d+(?:\.\d+)?px\]|xs|sm|base|lg|xl|2xl|3xl|4xl)(?![\w-])/g,
  // An arbitrary pixel radius or a Tailwind default radius: rounded, rounded-lg, rounded-t-[7px] …
  radius: /(?<![\w-])rounded(?:-(?:t|b|l|r|s|e|tl|tr|bl|br))?(?:-(?:\[\d+(?:\.\d+)?px\]|sm|md|lg|xl|2xl|3xl))?(?![\w-])/g,
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
      const found = text.match(RULES[rule])?.length ?? 0;
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
  assert.deepEqual(grown, [], "Use text-10…text-26 and the rounded-inline/chip/control/card/window/full tokens (.interface-design/system.md)");
});

test("the baseline shrinks as files move onto the scale", () => {
  const stale = (Object.keys(RULES) as Rule[]).flatMap((rule) =>
    Object.entries(baseline[rule]).flatMap(([file, n]) => ((counts[rule][file] ?? 0) < n ? [`${file}: ${rule} ${n} → ${counts[rule][file] ?? 0}`] : [])),
  );
  assert.deepEqual(stale, [], "Lower the baseline: UPDATE_DESIGN_TOKENS=1 node --test app/src/components/primitives/design-tokens.test.ts");
});
