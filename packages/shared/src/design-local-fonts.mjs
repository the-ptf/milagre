const APPLE_SUBSTITUTES = [
  [/^sf mono\b/i, "Courier New"],
  [/^new york\b/i, "Source Serif 4"],
  [/^(?:sf\b|san francisco\b|\.sf\b)/i, "Inter"],
];

export const designFirstFamily = (fontFamily = "") =>
  fontFamily
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");

/** Apple's system families (SF Pro, SF Compact, SF Mono, New York) and their variants: licensed for local previews only. */
export function designAppleFamily(family) {
  return APPLE_SUBSTITUTES.some(([pattern]) => pattern.test(designFirstFamily(family)));
}

/** The catalog or web-safe family a public page or a computer without Apple's fonts draws instead, with close metrics. */
export function designFontSubstitute(family) {
  const first = designFirstFamily(family);
  return APPLE_SUBSTITUTES.find(([pattern]) => pattern.test(first))?.[1] ?? null;
}

/** The family list with an unavailable Apple family swapped for its substitute. */
export function designSubstitutedFamily(fontFamily) {
  const first = designFirstFamily(fontFamily);
  const substitute = designFontSubstitute(first);
  if (!substitute) return fontFamily;
  const rest = fontFamily.split(",").slice(1).join(",");
  return rest ? `${substitute},${rest}` : substitute;
}

import { DESIGN_FONT_CATALOG } from "./design-font-catalog.mjs";

let source = null;
const faces = new Map();

/**
 * The host's installed fonts. `family(name)` answers synchronously from an index: `{family, apple, wght?: {min, max},
 * opsz?: {min, max, fixed?}, weights: number[]}` or null. `load(requests)` resolves `{key, data, advances}` faces for
 * `{key, family, weight, opsz}` requests: data a base64 TrueType instance renamed to the face's CSS family, advances
 * the measured table in the catalog's shape. Viewers without a host source render the families the document names, or
 * an Apple family's substitute.
 */
export function setDesignLocalFonts(next) {
  source = next;
  faces.clear();
}

/** An installed family by its first name; Inter and the catalog always draw the bundled faces. */
export function designLocalFamily(fontFamily) {
  if (!source || !fontFamily) return null;
  const first = designFirstFamily(fontFamily);
  if (first.toLowerCase() === "inter" || Object.hasOwn(DESIGN_FONT_CATALOG, first.toLowerCase())) return null;
  return source.family(first) ?? null;
}

const clamp = (value, range) => Math.min(range.max, Math.max(range.min, value));

/** The face a text layer draws with from an installed family, or null. */
export function designLocalFaceRequest(node) {
  const entry = designLocalFamily(node.fontFamily);
  if (!entry) return null;
  const requested = node.fontWeight ?? 400;
  const weight = entry.wght
    ? Math.round(clamp(requested, entry.wght))
    : entry.weights.reduce((best, value) => (Math.abs(value - requested) < Math.abs(best - requested) ? value : best), entry.weights[0] ?? 400);
  const opsz = entry.opsz ? (entry.opsz.fixed ?? Math.round(clamp(node.fontSize ?? 16, entry.opsz))) : null;
  const name = designFirstFamily(node.fontFamily);
  const cssFamily = opsz === null ? name : `${name}@${opsz}`;
  return { key: `${cssFamily.toLowerCase()}\u0000${weight}`, family: name, cssFamily, weight, opsz };
}

export function designLocalFace(node) {
  const request = designLocalFaceRequest(node);
  return request ? (faces.get(request.key) ?? null) : null;
}

export async function loadDesignLocalFaces(nodes) {
  if (!source) return;
  await source.ready?.();
  const wanted = new Map();
  for (const node of nodes) {
    const request = designLocalFaceRequest(node);
    if (request && !faces.has(request.key)) wanted.set(request.key, request);
  }
  if (!wanted.size) return;
  for (const face of await source.load([...wanted.values()])) {
    const request = wanted.get(face?.key);
    if (request && face.data && face.advances) faces.set(face.key, { ...request, data: face.data, advances: face.advances });
  }
}
