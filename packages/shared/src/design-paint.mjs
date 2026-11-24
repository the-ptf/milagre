export const DESIGN_INK = "#202720";
export const DESIGN_PLACEHOLDER = "#d8ded8";

/** What a layer paints when it names no fill: frames and images that have a source stay transparent. */
export function designDefaultFill(node) {
  if (node.type === "path") return node.arc || node.stroke ? "transparent" : DESIGN_INK;
  if (node.type === "text" || node.type === "icon") return DESIGN_INK;
  if (node.type === "frame" || (node.type === "image" && node.src)) return "transparent";
  return DESIGN_PLACEHOLDER;
}
