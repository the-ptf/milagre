export const DESIGN_MODES = ["light", "dark", "contrast"];
export const DESIGN_MODE_LABELS = { light: "Light", dark: "Dark", contrast: "Increased contrast" };

const modal = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** The modes a layer design's color tokens define, light first; ["light"] when every token is one color. */
export function designModesOf(document) {
  const found = new Set(["light"]);
  for (const value of [...Object.values(document?.tokens ?? {}), ...Object.values(document?.kit?.colors ?? {})])
    if (modal(value)) for (const mode of DESIGN_MODES) if (value[mode] !== undefined) found.add(mode);
  return DESIGN_MODES.filter((mode) => found.has(mode));
}

/** A saved layer design's HTML switched to a mode: its colors are CSS variables keyed on the root's data-design-mode. */
export function designHtmlForMode(html, mode) {
  if (!mode || mode === "light") return html;
  return html.replace(/<html(?=[\s>])/, `<html data-design-mode="${DESIGN_MODES.includes(mode) ? mode : "light"}"`);
}
