import { designFontMetrics } from "./design-font-metrics.mjs";
import { DESIGN_INTER_PATTERN, nearestDesignWeight } from "./design-fonts.mjs";

const bounded = (value, minimum = 0) => Math.max(1, minimum, Math.min(16000, value));
const round = (value) => Math.round(value * 1000) / 1000;
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
// Printable ASCII needs no grapheme segmentation; preserve full clusters for every other script.
const graphemes = (text) =>
  /^[ -~]*$/.test(text) ? text.split("") : segmenter ? Array.from(segmenter.segment(text), (item) => item.segment) : Array.from(text);

/** Shared line breaking deliberately has no browser dependency. Inter, Arial, Georgia, Times New Roman and Courier New are measured; other fonts use the closest generic metrics. */
export function designTextLayout(node, width = Infinity) {
  const family = (node.fontFamily ?? "Inter").toLowerCase();
  const kind = DESIGN_INTER_PATTERN.test(family)
    ? "inter"
    : /courier|mono/.test(family)
      ? "mono"
      : /times/.test(family)
        ? "times"
        : /georgia|(?<!sans-)serif/.test(family)
          ? "serif"
          : "sans";
  const measured = designFontMetrics[kind];
  const requested = node.fontWeight ?? 400;
  const weight = nearestDesignWeight(Object.keys(measured).map(Number), requested);
  const metrics = measured[weight];
  const size = node.fontSize ?? 16;
  const advances = new Map();
  const advance = (character) => {
    if (advances.has(character)) return advances.get(character);
    const base = character.normalize("NFD").replace(/\p{M}/gu, "").codePointAt(0);
    const advanceWidth = base === undefined ? 0 : base >= 32 && base <= 126 ? metrics[base - 32] * size : (base >= 0x2e80 ? 1 : 0.65) * size;
    advances.set(character, advanceWidth);
    return advanceWidth;
  };
  const measure = (text) => graphemes(text).reduce((total, character) => total + advance(character), 0);
  const limit = Math.max(1, width);
  const lines = [];
  for (const paragraph of (node.text ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ").normalize("NFC").split("\n")) {
    let line = "",
      used = 0;
    for (const part of paragraph.match(/\s+|\S+/gu) ?? []) {
      const partWidth = measure(part);
      if (/\S/u.test(part) && line.trim() && used + partWidth > limit + 0.001) {
        lines.push(line.trimEnd());
        line = "";
        used = 0;
      }
      for (const character of graphemes(part)) {
        const next = advance(character);
        if (line && used + next > limit + 0.001) {
          lines.push(line.trimEnd());
          line = "";
          used = 0;
          if (/\s/u.test(character)) continue;
        }
        line += character;
        used += next;
      }
    }
    lines.push(line);
  }
  const lineHeight = size * (node.lineHeight ?? 1.35);
  return { lines, width: round(Math.max(0, ...lines.map(measure))), height: round(lines.length * lineHeight), lineHeight };
}

/** Fixed sizes are backward compatible. Hug measures content; fill shares available space in an auto-layout row/column. */
export function designLayout(document, textLayout = designTextLayout) {
  const children = new Map();
  for (const node of document.nodes) {
    if (node.hidden) continue;
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const cache = new Map();
  function measure(node, forceWidth, forceHeight) {
    const key = `${node.id}:${forceWidth ?? ""}:${forceHeight ?? ""}`;
    if (cache.has(key)) return cache.get(key);
    const nested = children.get(node.id) ?? [];
    const mode = node.layout ?? "free";
    const automatic = mode !== "free";
    const horizontal = mode === "horizontal";
    const padding = automatic ? (node.padding ?? 0) : 0;
    const gap = automatic ? (node.gap ?? 0) : 0;
    let width = node.widthMode === "fill" ? (forceWidth ?? node.width) : node.width;
    if (node.widthMode === "hug") {
      if (node.type === "text") width = textLayout(node).width + 2 * (node.stroke ? (node.strokeWidth ?? 1) : 0);
      if (node.type === "frame") {
        const sizes = nested.map((child) => ({ node: child, size: measure(child) }));
        width =
          2 * padding +
          (horizontal
            ? sizes.reduce((sum, child) => sum + child.size.width, 0) + Math.max(0, sizes.length - 1) * gap
            : Math.max(0, ...sizes.map((child) => child.size.width + (automatic ? 0 : (child.node.x ?? 0)))));
      }
    }
    width = bounded(width, node.minWidth);
    let height = bounded(node.heightMode === "fill" ? (forceHeight ?? node.height) : node.height, node.minHeight);
    function arrange(frameHeight) {
      const contentWidth = Math.max(1, width - 2 * padding);
      const contentHeight = frameHeight === undefined ? undefined : Math.max(1, frameHeight - 2 * padding);
      const crossWidth = (child) => (child.widthMode === "fill" && !horizontal ? contentWidth : undefined);
      const crossHeight = (child) => (child.heightMode === "fill" && mode !== "vertical" ? contentHeight : undefined);
      let sizes = nested.map((child) => ({ node: child, size: measure(child, crossWidth(child), crossHeight(child)) }));
      if (automatic) {
        const axis = horizontal ? "width" : "height";
        const room = horizontal ? contentWidth : contentHeight;
        const fills = sizes.filter((child) => child.node[`${axis}Mode`] === "fill");
        // Fill inside a hug parent uses the stored fallback, avoiding a circular size dependency.
        if (room !== undefined && node[`${axis}Mode`] !== "hug" && fills.length) {
          const fixed = sizes.filter((child) => child.node[`${axis}Mode`] !== "fill").reduce((sum, child) => sum + child.size[axis], 0);
          let remaining = Math.max(0, room - fixed - Math.max(0, sizes.length - 1) * gap);
          let pending = [...fills];
          const allocation = new Map();
          while (pending.length) {
            const share = remaining / pending.length;
            const constrained = pending.filter((child) => (child.node[horizontal ? "minWidth" : "minHeight"] ?? 1) > share);
            if (!constrained.length) {
              for (const child of pending) allocation.set(child.node.id, Math.max(1, share));
              break;
            }
            for (const child of constrained) {
              const minimum = child.node[horizontal ? "minWidth" : "minHeight"] ?? 1;
              allocation.set(child.node.id, minimum);
              remaining = Math.max(0, remaining - minimum);
            }
            pending = pending.filter((child) => !allocation.has(child.node.id));
          }
          sizes = sizes.map((child) =>
            allocation.has(child.node.id)
              ? {
                  node: child.node,
                  size: measure(
                    child.node,
                    horizontal ? allocation.get(child.node.id) : crossWidth(child.node),
                    horizontal ? crossHeight(child.node) : allocation.get(child.node.id),
                  ),
                }
              : child,
          );
        }
      }
      return sizes;
    }
    let sizes = node.type === "frame" ? arrange(node.heightMode === "hug" ? undefined : height) : [];
    if (node.heightMode === "hug") {
      if (node.type === "text") {
        const stroke = node.stroke ? (node.strokeWidth ?? 1) : 0;
        height = textLayout(node, Math.max(1, width - 2 * stroke)).height + 2 * stroke;
      }
      if (node.type === "frame")
        height =
          2 * padding +
          (mode === "vertical"
            ? sizes.reduce((sum, child) => sum + child.size.height, 0) + Math.max(0, sizes.length - 1) * gap
            : Math.max(0, ...sizes.map((child) => child.size.height + (automatic ? 0 : (child.node.y ?? 0)))));
      height = bounded(height, node.minHeight);
      if (node.type === "frame") sizes = arrange(height);
    }
    const result = { width: round(width), height: round(height), children: sizes };
    cache.set(key, result);
    return result;
  }
  const bounds = new Map();
  function place(node, size, x, y) {
    bounds.set(node.id, { x: round(x), y: round(y), width: size.width, height: size.height });
    const mode = node.layout ?? "free";
    const horizontal = mode === "horizontal";
    const automatic = mode !== "free";
    const padding = automatic ? (node.padding ?? 0) : 0;
    let gap = node.gap ?? 0;
    let cursor = padding;
    if (automatic) {
      const occupied =
        size.children.reduce((sum, child) => sum + (horizontal ? child.size.width : child.size.height), 0) + Math.max(0, size.children.length - 1) * gap;
      const available = (horizontal ? size.width : size.height) - 2 * padding;
      const remainder = Math.max(0, available - occupied);
      if (node.justify === "center") cursor += remainder / 2;
      if (node.justify === "end") cursor += remainder;
      if (node.justify === "space-between" && size.children.length > 1) gap += remainder / (size.children.length - 1);
    }
    for (const child of size.children) {
      let left = child.node.x ?? 0,
        top = child.node.y ?? 0;
      if (automatic) {
        const space = (horizontal ? size.height - child.size.height : size.width - child.size.width) - padding * 2;
        const cross = padding + (node.align === "center" ? space / 2 : node.align === "end" ? space : 0);
        left = horizontal ? cursor : cross;
        top = horizontal ? cross : cursor;
        cursor += (horizontal ? child.size.width : child.size.height) + gap;
      }
      place(child.node, child.size, x + left, y + top);
    }
  }
  for (const node of children.get(undefined) ?? []) place(node, measure(node, document.width, document.height), node.x ?? 0, node.y ?? 0);
  return bounds;
}
