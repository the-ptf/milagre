import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { radius, type } from "./design-tokens.ts";

// Literal font sizes, corner radii and icon sizes stay on the scale in design-tokens.ts (.interface-design/system.md),
// and type takes no computed sizes, fixed SwiftUI fonts, uppercase, tracking or 700 (the large title aside); motion
// takes `duration` tokens. Styles from before a rule are counted per file in design-tokens.baseline.json; a file may
// only go down. After moving a file onto the scale, lower its count with UPDATE_DESIGN_TOKENS=1 node --test
// src/design-tokens.test.ts (from apps/mobile).
const SRC = import.meta.dirname;
const BASELINE = join(SRC, "design-tokens.baseline.json");
const SIZES = new Set<number>(Object.values(type));
const RADII = new Set<number>([0, ...Object.values(radius)]);
const ICONS = new Set<number>([12, 16, 18, 20, 24]);

// A rule counts each match, except a captured number in `allowed` or a match whose line passes `skip`.
type Spec = { pattern: RegExp; allowed?: Set<number>; skip?: RegExp };
const RULES = {
  font: { pattern: /\bfontSize:\s*(\d+(?:\.\d+)?)\b/g, allowed: SIZES },
  radius: { pattern: /\b(?:border(?:Top|Bottom)?(?:Left|Right)?Radius|sheetCornerRadius):\s*(\d+(?:\.\d+)?)\b/g, allowed: RADII },
  /** `fontSize: size * 0.55`: snap to a `type` size (chat text scales through textPx or typeScale). */
  computedFont: { pattern: /\bfontSize:\s*[^,}\n]*[*/][^,}\n]*/g, skip: /textPx|typeScale/ },
  /** A SwiftUI `font({ size })` with no `textStyle` doesn't follow Dynamic Type. */
  swiftFont: { pattern: /\bfont\(\{(?![^}]*\btextStyle\b)[^}]*\bsize:/g },
  icon: { pattern: /<(?:Icon|SpinnerRing|ProviderLogo)\b[^>]*?\bsize=\{(\d+(?:\.\d+)?)\}/g, allowed: ICONS },
  /** Literal milliseconds: use `duration.fast`/`base`/`slow` (0, instant, is fine). */
  duration: { pattern: /\bduration:\s*(\d+)\b/g, allowed: new Set([0]) },
  uppercase: { pattern: /\btextTransform:\s*["']uppercase["']/g },
  tracking: { pattern: /\bletterSpacing:\s*(-?\d+(?:\.\d+)?)/g, allowed: new Set([0]) },
  bold: { pattern: /\bfontWeight:\s*["']700["']/g, skip: /largeTitle/ },
} satisfies Record<string, Spec>;
type Rule = keyof typeof RULES;
type Counts = Record<Rule, Record<string, number>>;
const lineOf = (text: string, index: number) => text.slice(text.lastIndexOf("\n", index) + 1, text.indexOf("\n", index) >>> 0);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function count(): Counts {
  const counts = Object.fromEntries(Object.keys(RULES).map((rule) => [rule, {}])) as Counts;
  for (const path of sources(SRC).toSorted()) {
    const text = readFileSync(path, "utf8");
    for (const rule of Object.keys(RULES) as Rule[]) {
      const { pattern, allowed, skip }: Spec = RULES[rule];
      const found = [...text.matchAll(pattern)].filter((match) => !allowed?.has(Number(match[1])) && !skip?.test(lineOf(text, match.index))).length;
      if (found) counts[rule][relative(SRC, path)] = found;
    }
  }
  return counts;
}

const counts = count();
if (process.env.UPDATE_DESIGN_TOKENS === "1") writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Counts;

test("no file adds an off-scale font size, corner radius, icon size or type and motion literal", () => {
  const grown = (Object.keys(RULES) as Rule[]).flatMap((rule) =>
    Object.entries(counts[rule]).flatMap(([file, n]) => (n > (baseline[rule]?.[file] ?? 0) ? [`${file}: ${rule} ${baseline[rule]?.[file] ?? 0} → ${n}`] : [])),
  );
  assert.deepEqual(grown, [], "Use the sizes, radii and durations in design-tokens.ts (.interface-design/system.md)");
});

test("the baseline shrinks as files move onto the scale", () => {
  const stale = (Object.keys(RULES) as Rule[]).flatMap((rule) =>
    Object.entries(baseline[rule] ?? {}).flatMap(([file, n]) => ((counts[rule][file] ?? 0) < n ? [`${file}: ${rule} ${n} → ${counts[rule][file] ?? 0}`] : [])),
  );
  assert.deepEqual(stale, [], "Lower the baseline: UPDATE_DESIGN_TOKENS=1 node --test src/design-tokens.test.ts");
});
