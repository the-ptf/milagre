// Milagre's design system at build time: the rules in DESIGN.md and the tokens the apps ship, read from their sources
// (the theme builder, the desktop stylesheet, the phone's design-tokens.ts), so /design can't drift from the code.
// design-system.test.ts checks every token table in DESIGN.md against these values.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { contrastRatio, DEFAULT_THEME_ID, hexToOklch, oklchToHex, over, resolvePalette, ULTRACODE_PURPLE } from "@milagre/shared/themes";
import * as phoneTokens from "../../mobile/src/design-tokens.ts";

// Astro builds from apps/site, but tests and npm workspaces can start elsewhere: find the repository.
function repoRoot() {
  for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "DESIGN.md")) && existsSync(path.join(dir, "apps/desktop/app/src/styles.css"))) return dir;
    if (path.dirname(dir) === dir) throw new Error(`design-system: DESIGN.md not found above ${process.cwd()}`);
  }
}

const ROOT = repoRoot();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

export const DESIGN_MD = read("DESIGN.md");
export const SCHEMES = ["light", "dark"] as const;
export type Scheme = (typeof SCHEMES)[number];

// ── Colour: the default theme as the builder makes it, plus Ultracode's purple (a brand colour no theme overrides).

const PALETTE_ONLY = new Set(["ansi", "syntax", "cursor", "selection"]);
export const palette = Object.fromEntries(
  SCHEMES.map((scheme) => {
    const { ansi: _ansi, syntax: _syntax, cursor: _cursor, selection: _selection, ...colors } = resolvePalette(DEFAULT_THEME_ID, scheme);
    return [scheme, { ...colors, ...ULTRACODE_PURPLE[scheme] } as Record<string, string>];
  }),
) as Record<Scheme, Record<string, string>>;

/** The palette keys DESIGN.md's colour tables list: every key but the terminal and editor colours. */
export const COLOR_KEYS = Object.keys(palette.light).filter((key) => !PALETTE_ONLY.has(key));
/** A palette key as desktop names it: `ink2` → `ink-2`, `accentInk` → `accent-ink`. */
export const tokenName = (key: string) =>
  key
    .replace(/([A-Z])/g, "-$1")
    .replace(/(\d+)/g, "-$1")
    .toLowerCase();
/** A desktop token as the palette (and the phone) names it: `ink-2` → `ink2`, `accent-ink` → `accentInk`. */
export const paletteKey = (token: string) => token.replace(/-(\w)/g, (_, c: string) => (/\d/.test(c) ? c : c.toUpperCase()));

const groundsFor = (colors: Record<string, string>, ground: string, text: string): string[] => {
  const fill = (key: string) => [over(colors[key], colors.page), over(colors[key], colors.surface)];
  if (ground === "page" || ground === "surface") return [colors[ground]];
  if (ground === "own tint") return fill(paletteKey(text.replace(/-ink$/, "-tint")));
  if (ground === "own ink") return [colors[paletteKey(text.replace(/^on-/, "") + "-ink")]];
  return fill(paletteKey(ground));
};

export interface ContrastCheck {
  text: string;
  ground: string;
  floor: number;
  /** The lowest ratio over every surface the ground can sit on, and that surface as an opaque colour. */
  ratio: number;
  background: string;
  color: string;
}

/** DESIGN.md's contrast floors, measured on the default theme. */
export function contrastChecks(scheme: Scheme): ContrastCheck[] {
  const table = specimenTables(DESIGN_MD).get("contrast");
  if (!table) return [];
  const colors = palette[scheme];
  return table.rows.flatMap(([texts, floor, grounds]) =>
    texts.split(",").flatMap((rawText) =>
      grounds.split(",").map((rawGround) => {
        const text = rawText.trim();
        const ground = rawGround.trim();
        const color = colors[paletteKey(text)];
        const [worst] = groundsFor(colors, ground, text)
          .map((background) => ({ background, ratio: contrastRatio(color, background) }))
          .sort((a, b) => a.ratio - b.ratio);
        return { text, ground, floor: Number(floor), color, ...worst };
      }),
    ),
  );
}

// ── Desktop: apps/desktop/app/src/styles.css. Its :root and .dark hold the first-frame colours and the shadows, its
// @theme blocks the type, radius, blur and easing scales.

const STYLES = read("apps/desktop/app/src/styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The custom properties declared in the first top-level block that opens with `opener` and declares `--marker`. */
function cssBlock(css: string, opener: string, marker?: string): Record<string, string> {
  for (let from = 0; ;) {
    const start = css.indexOf(`\n${opener} {`, from);
    if (start === -1) throw new Error(`design-system: no "${opener}" block${marker ? ` declaring --${marker}` : ""} in styles.css`);
    const end = css.indexOf("\n}", start + 1);
    const body = css.slice(start, end);
    from = end;
    if (marker && !body.includes(`--${marker}:`)) continue;
    return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.replace(/\s+/g, " ").trim()]));
  }
}

const desktopRoot = cssBlock(STYLES, ":root", "page");
const desktopDark = cssBlock(STYLES, ".dark", "page");
const themeInline = cssBlock(STYLES, "@theme inline");
const themeScale = cssBlock(STYLES, "@theme", "text-13");

/** A colour or shadow from :root (light) or .dark over :root (dark), with var() references to its own block resolved. */
export function desktopValue(name: string, scheme: Scheme): string | undefined {
  const block = scheme === "dark" ? { ...desktopRoot, ...desktopDark } : desktopRoot;
  let value = block[name];
  for (let depth = 0; value && depth < 4; depth++) {
    const next = value.replace(/var\(--([\w-]+)\)/g, (match, ref: string) => block[ref] ?? match);
    if (next === value) break;
    value = next;
  }
  return value;
}

const px = (value: string) => Number.parseFloat(value);

export const desktop = {
  type: Object.keys(themeScale)
    .filter((name) => /^text-\d+$/.test(name))
    .map((token) => ({ token, size: px(themeScale[token]), lineHeight: px(themeScale[`${token}--line-height`]) }))
    .sort((a, b) => b.size - a.size),
  radius: Object.entries(themeInline)
    .filter(([name]) => name.startsWith("radius-"))
    .map(([name, value]) => ({ token: `rounded-${name.slice("radius-".length)}`, value: px(value) })),
  blur: Object.entries(themeInline)
    .filter(([name]) => name.startsWith("blur-"))
    .map(([name, value]) => ({ token: `backdrop-blur-${name.slice("blur-".length)}`, value: px(value) })),
  shadows: Object.keys(themeInline)
    .filter((name) => name.startsWith("shadow-"))
    .map((token) => ({ token, light: desktopValue(token, "light") ?? "", dark: desktopValue(token, "dark") ?? "" })),
  duration: Object.fromEntries(
    Object.entries(desktopRoot)
      .filter(([name]) => name.startsWith("duration-"))
      .map(([name, value]) => [name.slice("duration-".length), px(value)]),
  ) as Record<string, number>,
  easing: Object.fromEntries(
    Object.entries(themeScale)
      .filter(([name]) => name.startsWith("ease-"))
      .map(([name, value]) => [name.slice("ease-".length), value]),
  ) as Record<string, string>,
  pressScale: Number(desktopRoot["press-scale"]),
  /** Each icon size's stroke, from the Icon primitive. */
  iconStroke: Object.fromEntries(
    [...(/const STROKE = \{([^}]*)\}/.exec(read("apps/desktop/app/src/components/primitives/Icon.tsx"))?.[1] ?? "").matchAll(/(\d+):\s*([\d.]+)/g)].map(
      ([, size, stroke]) => [Number(size), Number(stroke)],
    ),
  ) as Record<number, number>,
};

// A PR label keeps its GitHub hue at a fixed lightness per theme (.pr-label in styles.css): its text and chip colours.
const labelRule = (selector: string) => {
  const start = STYLES.indexOf(`\n${selector} {`);
  const body = STYLES.slice(start, STYLES.indexOf("\n}", start + 1));
  const lightness = (property: string) => {
    const [, l, c] = new RegExp(`\\n\\s*${property}: oklch\\(from var\\(--label\\) ([\\d.]+) min\\(c, ([\\d.]+)\\) h\\)`).exec(body) ?? [];
    if (!l) throw new Error(`design-system: no ${property} in ${selector}`);
    return { l: Number(l), c: Number(c) };
  };
  return { text: lightness("color"), chip: lightness("background-color") };
};
const labelRules = { light: labelRule(".pr-label"), dark: labelRule(".dark .pr-label") };
export function prLabelColors(hex: string, scheme: Scheme) {
  const { c, h } = hexToOklch(hex);
  const rule = labelRules[scheme];
  return {
    color: oklchToHex({ l: rule.text.l, c: Math.min(c, rule.text.c), h }),
    background: oklchToHex({ l: rule.chip.l, c: Math.min(c, rule.chip.c), h }),
  };
}

// Tailwind's shadow scale as shadow-plugin redefines it; the desktop shadow tokens build on its sm, md and lg.
const shadowScale = cssBlock(
  `\n${readFileSync(createRequire(path.join(ROOT, "apps/desktop/package.json")).resolve("shadow-plugin/unprefixed"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")}`,
  "@theme",
);
/** A desktop shadow with Tailwind's scale filled in, ready for a style attribute outside the app. */
const resolveShadow = (value: string) => value.replace(/var\(--(shadow-\w+)\)/g, (match, name: string) => shadowScale[name] ?? match);

// ── Phone: apps/mobile/src/design-tokens.ts, plus the elevation in theme.ts (which imports React Native, so it's read).

const elevationSource = /const ELEVATION = \{([\s\S]*?)\n\};/.exec(read("apps/mobile/src/theme.ts"))?.[1] ?? "";
export const phone = {
  ...phoneTokens,
  pressScale: Number(/scale:\s*([\d.]+)/.exec(read("apps/mobile/src/primitives/press-style.ts"))?.[1]),
  elevation: Object.fromEntries(
    SCHEMES.map((scheme) => [
      scheme,
      Object.fromEntries(
        [...(new RegExp(`${scheme}: \\{([^}]*)\\}`).exec(elevationSource)?.[1] ?? "").matchAll(/(\w+): "([^"]*)"/g)].map(([, name, value]) => [name, value]),
      ),
    ]),
  ) as Record<Scheme, Record<string, string>>,
};

// ── DESIGN.md: `<!-- specimen: id -->` marks where /design draws a specimen. When a table follows the marker, the
// specimen takes its place on the page and the test checks the table against the code.

export interface Table {
  header: string[];
  rows: string[][];
}
export type Chunk = { kind: "markdown"; text: string } | { kind: "specimen"; id: string; table?: Table };

const MARKER = /^<!-- specimen: ([\w-]+) -->$/;
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim().replaceAll("`", ""));

function parseTable(lines: string[]): Table {
  const [header, , ...rows] = lines.map(cells);
  return { header, rows };
}

/** DESIGN.md as alternating markdown and specimens, in reading order. */
export function designChunks(markdown: string): Chunk[] {
  const chunks: Chunk[] = [];
  const lines = markdown.split("\n");
  let text: string[] = [];
  const flush = () => {
    if (text.join("").trim()) chunks.push({ kind: "markdown", text: text.join("\n") });
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const marker = MARKER.exec(lines[i].trim());
    if (!marker) {
      text.push(lines[i]);
      continue;
    }
    flush();
    let next = i + 1;
    while (next < lines.length && !lines[next].trim()) next++;
    const table: string[] = [];
    while (next < lines.length && lines[next].trim().startsWith("|")) table.push(lines[next++]);
    chunks.push(table.length ? { kind: "specimen", id: marker[1], table: parseTable(table) } : { kind: "specimen", id: marker[1] });
    if (table.length) i = next - 1;
  }
  flush();
  return chunks;
}

/** Every table that follows a specimen marker, by the marker's id. */
export function specimenTables(markdown: string): Map<string, Table> {
  return new Map(designChunks(markdown).flatMap((chunk) => (chunk.kind === "specimen" && chunk.table ? [[chunk.id, chunk.table] as const] : [])));
}

/** The specimens /design knows how to draw; a marker in DESIGN.md with any other id fails the test and the build. */
export const SPECIMENS = [
  "color-surfaces",
  "color-ink",
  "color-accent",
  "color-status",
  "color-purple",
  "color-diff",
  "contrast",
  "type-desktop",
  "type-phone",
  "space-phone",
  "radius-desktop",
  "radius-phone",
  "elevation",
  "blur",
  "motion",
  "icons",
  "buttons",
  "chips",
  "rows",
  "approval",
  "question",
  "toast",
  "picker",
  "activity",
  "dos",
] as const;
export type SpecimenId = (typeof SPECIMENS)[number];
export const isSpecimen = (id: string): id is SpecimenId => (SPECIMENS as readonly string[]).includes(id);

/** CSS custom properties that put a block on the app's palette in one scheme: `--page`, `--ink-2`, `--shadow-card` … */
export function schemeVariables(scheme: Scheme): string {
  const colors = COLOR_KEYS.map((key) => `--${tokenName(key)}:${palette[scheme][key]}`);
  const shadows = desktop.shadows.map((shadow) => `--${shadow.token}:${resolveShadow(shadow[scheme])}`);
  return [...colors, `--on-ink:${palette[scheme].surface}`, ...shadows].join(";");
}
