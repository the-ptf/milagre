import { DESIGN_DEFAULT_FONT_FAMILY, validDesignFontFamily } from "./design-font-family.mjs";
export { DESIGN_DEFAULT_FONT_FAMILY, validDesignFontFamily } from "./design-font-family.mjs";
import { designInterFonts, DESIGN_INTER_WEIGHTS } from "./design-font-data.mjs";
import { DESIGN_ASCII_CHARACTERS, DESIGN_EXTRA_CHARACTERS } from "./design-font-characters.mjs";
import { DESIGN_FONT_CATALOG, designCatalogFontLoaders } from "./design-font-catalog.mjs";

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

export function designInterWeight(fontWeight = 400) {
  return nearestDesignWeight(DESIGN_INTER_WEIGHTS, fontWeight);
}

/** Inter is detected when it is the first family in the list, exactly. A later Inter is only a fallback the viewer may never reach. */
export function designUsesInter(fontFamily = DESIGN_DEFAULT_FONT_FAMILY) {
  return fontFamily.split(",")[0].trim().toLowerCase() === "inter";
}

export const DESIGN_CATALOG_FAMILIES = Object.values(DESIGN_FONT_CATALOG).map((entry) => entry.family);

export function designCatalogFont(fontFamily) {
  if (!fontFamily) return undefined;
  return DESIGN_FONT_CATALOG[fontFamily.split(",")[0].trim().toLowerCase()];
}

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

export function designFontsLoaded(document) {
  return visibleText(document).every((node) => {
    const entry = designCatalogFont(node.fontFamily);
    return !entry || loadedCatalogFonts.has(entry.family.toLowerCase());
  });
}

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

export function designFontFaces(document) {
  return usedFaces(document)
    .map(
      ({ family, weights, weight, data }) =>
        `@font-face{font-family:"${family}";font-weight:${weightRange(weights, weight)};font-style:normal;src:url(data:font/ttf;base64,${data}) format("truetype")}`,
    )
    .join("");
}

export function designFontBuffers(document) {
  const catalog = usedFaces(document).filter((face) => face.family !== "Inter");
  return [...DESIGN_INTER_WEIGHTS.map((weight) => designInterFonts[weight]), ...catalog.map((face) => face.data)];
}

const bundledCharacters = new Set(DESIGN_ASCII_CHARACTERS + DESIGN_EXTRA_CHARACTERS);

/** Whether the bundled Inter subset has a glyph for this character. Catalog subsets share its characters. Whitespace never needs one. */
export function designInterHasGlyph(character) {
  return bundledCharacters.has(character) || /^\s$/u.test(character);
}
