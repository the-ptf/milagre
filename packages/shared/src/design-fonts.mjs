import { designInterFonts, DESIGN_INTER_WEIGHTS } from "./design-font-data.mjs";
import { DESIGN_ASCII_CHARACTERS, DESIGN_EXTRA_CHARACTERS } from "./design-font-characters.mjs";
import { DESIGN_FONT_CATALOG, designCatalogFontLoaders } from "./design-font-catalog.mjs";

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

/** The catalog families a design can name besides Inter, measured and bundled like Inter. */
export const DESIGN_CATALOG_FAMILIES = Object.values(DESIGN_FONT_CATALOG).map((entry) => entry.family);

/** The catalog entry for a font list's first family. Like Inter, a catalog family only counts first in the list. */
export function designCatalogFont(fontFamily) {
  if (!fontFamily) return undefined;
  return DESIGN_FONT_CATALOG[fontFamily.split(",")[0].trim().toLowerCase()];
}

/** The weight a text layer draws with: the nearest measured face in Inter or a catalog family, as requested otherwise. */
export function designDrawnWeight(fontFamily, fontWeight = 400) {
  if (designUsesInter(fontFamily)) return designInterWeight(fontWeight);
  const entry = designCatalogFont(fontFamily);
  return entry ? nearestDesignWeight(entry.weights, fontWeight) : fontWeight;
}

const visibleText = (document) => document.nodes.filter((node) => node.type === "text" && !node.hidden);

/**
 * The CSS weight range a face answers to: the weights nearestDesignWeight maps to it, ties lighter. CSS matching is not nearest-weight
 * (between 401 and 499 it prefers heavier faces up to 500, above 500 it prefers heavier), so each face claims its own partition.
 */
function weightRange(weights, weight) {
  const index = weights.indexOf(weight);
  const previous = weights[index - 1];
  const next = weights[index + 1];
  return `${previous === undefined ? 1 : (previous + weight) / 2 + 1} ${next === undefined ? 1000 : (weight + next) / 2}`;
}

// Catalog faces are loaded per family on demand, so a viewer pays only for the families its designs name.
const loadedCatalogFonts = new Map();

/** Loads the catalog families a document names. Until it resolves, their text renders in the fallback the document names. */
export async function loadDesignFonts(document) {
  const keys = new Set(visibleText(document).map((node) => designCatalogFont(node.fontFamily)?.family.toLowerCase()));
  await Promise.all(
    [...keys]
      .filter((key) => key && !loadedCatalogFonts.has(key))
      .map(async (key) => loadedCatalogFonts.set(key, (await designCatalogFontLoaders[key]()).default)),
  );
}

/** Whether every catalog family a document names is loaded. */
export function designFontsLoaded(document) {
  return visibleText(document).every((node) => {
    const entry = designCatalogFont(node.fontFamily);
    return !entry || loadedCatalogFonts.has(entry.family.toLowerCase());
  });
}

/** The measured faces a document's visible text draws with: family, weight and TrueType data as base64. */
function usedFaces(document) {
  const faces = new Map();
  for (const node of visibleText(document)) {
    const entry = designUsesInter(node.fontFamily) ? null : designCatalogFont(node.fontFamily);
    if (!designUsesInter(node.fontFamily) && !entry) continue;
    const family = entry?.family ?? "Inter";
    const weights = entry?.weights ?? DESIGN_INTER_WEIGHTS;
    const weight = nearestDesignWeight(weights, node.fontWeight ?? 400);
    const data = entry ? loadedCatalogFonts.get(family.toLowerCase())?.[weight] : designInterFonts[weight];
    if (data) faces.set(`${family}\u0000${weight}`, { family, weights, weight, data });
  }
  return [...faces.values()].toSorted((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight);
}

/** Data-URI faces for the measured weights a document's visible text uses, so every viewer renders the measured fonts. */
export function designFontFaces(document) {
  return usedFaces(document)
    .map(
      ({ family, weights, weight, data }) =>
        `@font-face{font-family:"${family}";font-weight:${weightRange(weights, weight)};font-style:normal;src:url(data:font/ttf;base64,${data}) format("truetype")}`,
    )
    .join("");
}

/** TrueType data (base64) for a rasterizer that reads fonts from buffers: every Inter weight, plus the loaded catalog faces in use. */
export function designFontBuffers(document) {
  const catalog = usedFaces(document).filter((face) => face.family !== "Inter");
  return [...DESIGN_INTER_WEIGHTS.map((weight) => designInterFonts[weight]), ...catalog.map((face) => face.data)];
}

const bundledCharacters = new Set(DESIGN_ASCII_CHARACTERS + DESIGN_EXTRA_CHARACTERS);

/** Whether the bundled Inter subset has a glyph for this character. Catalog subsets share its characters. Whitespace never needs one. */
export function designInterHasGlyph(character) {
  return bundledCharacters.has(character) || /^\s$/u.test(character);
}
