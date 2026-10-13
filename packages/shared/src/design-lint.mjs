import { designLayout, designTextLayout } from "./design-layout.mjs";
import { visibleDesignTextLines } from "./design-render-limits.mjs";
import { DESIGN_INK } from "./design-paint.mjs";

const MAX_WARNINGS = 20;
// Only these layers paint a background; an icon's fill is its line colour and text has no backdrop of its own.
const SHAPE_TYPES = new Set(["frame", "rectangle", "ellipse"]);
// Below 3:1 text is hard to read at any size; stricter limits are the author's call.
const MINIMUM_CONTRAST = 3;
const TOLERANCE = 1;

const overlaps = (a, b) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
const contains = (outer, inner) =>
  inner.x >= outer.x - TOLERANCE &&
  inner.y >= outer.y - TOLERANCE &&
  inner.x + inner.width <= outer.x + outer.width + TOLERANCE &&
  inner.y + inner.height <= outer.y + outer.height + TOLERANCE;

/** Depth-first paint order: a parent before its children, siblings in array order, as the renderers draw. */
function paintOrder(document) {
  const children = new Map();
  for (const node of document.nodes) {
    const siblings = children.get(node.parentId ?? null) ?? [];
    siblings.push(node);
    children.set(node.parentId ?? null, siblings);
  }
  const order = [];
  const visit = (node) => {
    order.push(node);
    for (const child of children.get(node.id) ?? []) visit(child);
  };
  for (const root of children.get(null) ?? []) visit(root);
  return order;
}

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
  const order = paintOrder(document);
  const position = new Map(order.map((layer, at) => [layer.id, at]));
  const warnings = [];
  for (const node of document.nodes) {
    const box = bounds.get(node.id);
    if (!box) continue;
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    const parentBox = parent ? bounds.get(parent.id) : { x: 0, y: 0, width: document.width, height: document.height };
    if (node.type === "text") {
      const border = node.stroke ? (node.strokeWidth ?? 1) : 0;
      const layout = designTextLayout(node, Math.max(1, box.width - 2 * border));
      // Line boxes may overhang the layer; only glyphs actually cut off count.
      const glyphBottom = layout.height - (layout.lineHeight - (node.fontSize ?? 16)) / 2;
      if (visibleDesignTextLines(node, box, layout).length < layout.lines.length || glyphBottom > box.height - 2 * border + 0.5)
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
      // The topmost visible layer drawn before this text that overlaps it is what the text sits on.
      const index = position.get(node.id);
      let behind = null;
      for (let earlier = index - 1; earlier >= 0 && !behind; earlier--) {
        const candidate = order[earlier];
        const candidateBox = bounds.get(candidate.id);
        if (!candidateBox || !overlaps(candidateBox, box)) continue;
        if (candidate.type === "image" || (SHAPE_TYPES.has(candidate.type) && candidate.fill)) behind = { node: candidate, box: candidateBox };
      }
      let backdrop = resolve(document.background ?? "#ffffff");
      if (behind) {
        // Images and partly covered or translucent shapes have no single backdrop colour; stay quiet.
        backdrop = behind.node.type !== "image" && (behind.node.opacity ?? 1) === 1 && contains(behind.box, box) ? resolve(behind.node.fill) : null;
      }
      const foreground = (node.opacity ?? 1) === 1 ? luminance(resolve(node.fill ?? DESIGN_INK)) : null;
      const background = luminance(backdrop);
      if (foreground !== null && background !== null && contrast(foreground, background) < MINIMUM_CONTRAST)
        warnings.push({
          id: node.id,
          kind: "low-contrast",
          message: `Text "${node.id}" has ${contrast(foreground, background).toFixed(1)}:1 contrast against its background; below 3:1 it is hard to read.`,
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
