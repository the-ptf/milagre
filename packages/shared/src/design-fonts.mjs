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

/** Inter is detected when it is the first family in the list, exactly. A later Inter is only a fallback the viewer may never reach. */
export function designUsesInter(fontFamily = DESIGN_DEFAULT_FONT_FAMILY) {
  return fontFamily.split(",")[0].trim().toLowerCase() === "inter";
}

const usesInter = (node) => node.type === "text" && !node.hidden && designUsesInter(node.fontFamily);

/**
 * The CSS weight range a face answers to: the weights designInterWeight maps to it, ties lighter. CSS matching is not nearest-weight
 * (between 401 and 499 it prefers heavier faces up to 500, above 500 it prefers heavier), so each face claims its own partition.
 */
function weightRange(weight) {
  const index = DESIGN_INTER_WEIGHTS.indexOf(weight);
  const previous = DESIGN_INTER_WEIGHTS[index - 1];
  const next = DESIGN_INTER_WEIGHTS[index + 1];
  return `${previous === undefined ? 1 : (previous + weight) / 2 + 1} ${next === undefined ? 1000 : (weight + next) / 2}`;
}

/** Data-URI faces for the Inter weights a document's visible text uses, so every viewer renders the measured font. */
export function designFontFaces(document) {
  const weights = new Set(document.nodes.filter(usesInter).map((node) => designInterWeight(node.fontWeight)));
  return DESIGN_INTER_WEIGHTS.filter((weight) => weights.has(weight))
    .map(
      (weight) =>
        `@font-face{font-family:"Inter";font-weight:${weightRange(weight)};font-style:normal;src:url(data:font/ttf;base64,${designInterFonts[weight]}) format("truetype")}`,
    )
    .join("");
}
