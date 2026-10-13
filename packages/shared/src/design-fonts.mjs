import { designInterFonts, DESIGN_INTER_WEIGHTS } from "./design-font-data.mjs";

export const DESIGN_DEFAULT_FONT_FAMILY = "Inter, Arial, sans-serif";

const genericFamilies = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "fangsong",
]);

export function validDesignFontFamily(value) {
  return value.split(",").every((family) => family.trim().length > 0 && /^[\p{L}\p{N} ._-]+$/u.test(family));
}

/** The document stores plain family names; quote custom names for every CSS consumer. */
export function designFontFamily(value = DESIGN_DEFAULT_FONT_FAMILY) {
  if (!validDesignFontFamily(value)) throw new Error("Use non-empty font family names separated by commas.");
  return value
    .split(",")
    .map((family) => {
      const name = family.trim();
      return genericFamilies.has(name.toLowerCase()) ? name.toLowerCase() : `"${name}"`;
    })
    .join(", ");
}

/** The nearest of the measured weights to a requested one; ties go lighter. */
export function nearestDesignWeight(weights, requested = 400) {
  return weights.reduce((best, weight) => (Math.abs(weight - requested) < Math.abs(best - requested) ? weight : best));
}

/** The measured Inter weight a requested weight renders with. */
export function designInterWeight(fontWeight = 400) {
  return nearestDesignWeight(DESIGN_INTER_WEIGHTS, fontWeight);
}

/** Matches Inter as a family name, not letters inside another one such as Interstate. */
export const DESIGN_INTER_PATTERN = /\binter\b/i;

const usesInter = (node) => node.type === "text" && !node.hidden && DESIGN_INTER_PATTERN.test(node.fontFamily ?? DESIGN_DEFAULT_FONT_FAMILY);

/** Data-URI faces for the Inter weights a document's visible text uses, so every viewer renders the measured font. */
export function designFontFaces(document) {
  const weights = new Set(document.nodes.filter(usesInter).map((node) => designInterWeight(node.fontWeight)));
  return DESIGN_INTER_WEIGHTS.filter((weight) => weights.has(weight))
    .map(
      (weight) =>
        `@font-face{font-family:"Inter";font-weight:${weight};font-style:normal;src:url(data:font/ttf;base64,${designInterFonts[weight]}) format("truetype")}`,
    )
    .join("");
}
