// Hex ⇄ OKLCH for building theme palettes. OKLab math from Björn Ottosson (https://bottosson.github.io/posts/oklab/).
export type Oklch = { l: number; c: number; h: number; alpha: number };

const HEX = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;
export const isHex = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

function parse(hex: string) {
  const match = HEX.exec(hex);
  if (!match?.[1]) throw Error(`Not a hex color: ${hex}`);
  const n = parseInt(match[1], 16);
  return {
    r: (n >> 16) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
    alpha: match[2] ? parseInt(match[2], 16) / 255 : 1,
  };
}
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const byte = (c: number) =>
  Math.round(Math.min(1, Math.max(0, c)) * 255)
    .toString(16)
    .padStart(2, "0");

function toOklab(hex: string) {
  const { r, g, b, alpha } = parse(hex);
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    alpha,
  };
}
function fromOklab(L: number, a: number, b: number, alpha: number) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const bl = fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return `#${byte(r)}${byte(g)}${byte(bl)}${alpha < 1 ? byte(alpha) : ""}`;
}

export function hexToOklch(hex: string): Oklch {
  const { L, a, b, alpha } = toOklab(hex);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { l: L, c: Math.hypot(a, b), h: h < 0 ? h + 360 : h, alpha };
}
export function oklchToHex({ l, c, h, alpha = 1 }: { l: number; c: number; h: number; alpha?: number }) {
  const rad = (h * Math.PI) / 180;
  return fromOklab(l, c * Math.cos(rad), c * Math.sin(rad), alpha);
}
export const fromOklch = (l: number, c: number, h: number, alpha = 1) => oklchToHex({ l, c, h, alpha });

/** `t` of the way from `a` to `b`, in OKLab so midpoints don't go muddy. */
export function mix(a: string, b: string, t: number) {
  const x = toOklab(a);
  const y = toOklab(b);
  const lerp = (p: number, q: number) => p + (q - p) * t;
  return fromOklab(lerp(x.L, y.L), lerp(x.a, y.a), lerp(x.b, y.b), lerp(x.alpha, y.alpha));
}
export function withAlpha(hex: string, alpha: number) {
  const base = hex.slice(0, 7).toLowerCase();
  return alpha >= 1 ? base : `${base}${byte(alpha)}`;
}
/** WCAG relative luminance; alpha is ignored. */
export function luminance(hex: string) {
  const { r, g, b } = parse(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}
export function contrastRatio(a: string, b: string) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** `color` with its OKLCH lightness moved toward `toward`'s only as far as it takes to reach `ratio` against every
 * background. Hue and chroma stay, so an orange stays orange instead of going brown. */
export function readableOn(color: string, toward: string, backgrounds: readonly string[], ratio = 4.5) {
  const worst = (c: string) => Math.min(...backgrounds.map((bg) => contrastRatio(c, bg)));
  if (worst(color) >= ratio) return color;
  const from = hexToOklch(color.slice(0, 7));
  const target = hexToOklch(toward.slice(0, 7)).l;
  const at = (t: number) => oklchToHex({ ...from, l: from.l + (target - from.l) * t, alpha: 1 });
  let [lo, hi] = [0, 1];
  for (let i = 0; i < 16; i++) {
    const t = (lo + hi) / 2;
    if (worst(at(t)) >= ratio) hi = t;
    else lo = t;
  }
  return worst(at(hi)) >= ratio ? at(hi) : toward;
}

/** The better of white and `page` as text on `background`. */
export const onColor = (background: string, page: string) => (contrastRatio("#ffffff", background) >= contrastRatio(page, background) ? "#ffffff" : page);
