import { designLayout, designTextLayout } from "./design-layout.mjs";
import { visibleDesignTextLines } from "./design-render-limits.mjs";

const MAX_WARNINGS = 20;
// Only these layers paint a background; an icon's fill is its line colour and text has no backdrop of its own.
const BACKDROP_TYPES = new Set(["frame", "rectangle", "ellipse"]);

// sRGB relative luminance of a 3/6-digit hex or rgb() color; null for anything we can't resolve confidently.
function luminance(color) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color ?? "");
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*1(?:\.0+)?\s*)?\)$/i.exec(color ?? "");
  const channels = hex
    ? (hex[1].length === 3 ? hex[1].split("").map((c) => c + c) : hex[1].match(/../g)).map((pair) => parseInt(pair, 16))
    : rgb
      ? rgb.slice(1, 4).map(Number)
      : null;
  if (!channels) return null;
  const [r, g, b] = channels.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Problems an agent can't see in JSON: text cut off, layers spilling out, unreadable text. Pure; layer ids included. */
export function designWarnings(document) {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const bounds = designLayout(document, designTextLayout);
  const resolve = (value) => (value?.startsWith("$") ? document.tokens?.[value.slice(1)] : value);
  const warnings = [];
  for (const node of document.nodes) {
    const box = bounds.get(node.id);
    if (!box) continue;
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    const parentBox = parent ? bounds.get(parent.id) : { x: 0, y: 0, width: document.width, height: document.height };
    if (node.type === "text") {
      const border = node.stroke ? (node.strokeWidth ?? 1) : 0;
      const layout = designTextLayout(node, Math.max(1, box.width - 2 * border));
      if (visibleDesignTextLines(node, box, layout).length < layout.lines.length || layout.height > box.height - 2 * border + 1)
        warnings.push({
          id: node.id,
          kind: "clipped-text",
          message: `Text "${node.id}" needs ${Math.ceil(layout.height)}px but has ${Math.floor(box.height)}px; it is cut off. Use heightMode "hug" or shorten it.`,
        });
    }
    const outside =
      box.x < parentBox.x - 1 ||
      box.y < parentBox.y - 1 ||
      box.x + box.width > parentBox.x + parentBox.width + 1 ||
      box.y + box.height > parentBox.y + parentBox.height + 1;
    if (outside)
      warnings.push(
        parent
          ? { id: node.id, kind: "overflow", message: `"${node.id}" extends outside its parent "${parent.id}" and is clipped.` }
          : { id: node.id, kind: "off-canvas", message: `"${node.id}" extends past the ${document.width}×${document.height} screen.` },
      );
    if (node.type === "image" && node.src?.startsWith("https:"))
      warnings.push({
        id: node.id,
        kind: "remote-image",
        message: `Image "${node.id}" is a remote URL, shown as a placeholder in your preview; the user sees the real image.`,
      });
    if (node.type === "text") {
      let backdrop = null;
      for (let ancestor = parent; ancestor && backdrop === null; ancestor = ancestor.parentId ? nodes.get(ancestor.parentId) : null) {
        if (ancestor.type === "image") break;
        if (BACKDROP_TYPES.has(ancestor.type) && ancestor.fill) backdrop = resolve(ancestor.fill);
      }
      const foreground = luminance(resolve(node.fill ?? "#202720"));
      const background = luminance(backdrop ?? resolve(document.background ?? "#ffffff"));
      const minimum = (node.fontSize ?? 16) >= 24 ? 3 : 4.5;
      if (foreground !== null && background !== null && contrast(foreground, background) < minimum)
        warnings.push({
          id: node.id,
          kind: "low-contrast",
          message: `Text "${node.id}" has ${contrast(foreground, background).toFixed(1)}:1 contrast; it needs ${minimum}:1.`,
        });
    }
  }
  return warnings;
}

export function designWarningText(warnings) {
  const lines = warnings.slice(0, MAX_WARNINGS).map((warning) => `- ${warning.message}`);
  if (warnings.length > MAX_WARNINGS) lines.push(`…and ${warnings.length - MAX_WARNINGS} more`);
  return lines.join("\n");
}
