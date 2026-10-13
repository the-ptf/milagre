// A document can be small while its wrapped text produces megabytes of markup.
export const MAX_DESIGN_RENDER_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

export function designRenderBudget(format) {
  let bytes = 0;
  return (part, node) => {
    bytes += encoder.encode(part).byteLength;
    if (bytes > MAX_DESIGN_RENDER_BYTES) {
      const layer = node ? ` at layer "${node.name ?? node.id}" (${node.id})` : "";
      throw new Error(`Design ${format} exceeds the 8 MiB rendered size limit${layer}. Reduce visible text or image content.`);
    }
    return part;
  };
}

// Keep a partially visible last line and any glyph overhang from a short line-height.
// Borders reduce the content box; source text and layout measurements remain intact.
export function visibleDesignTextLines(node, box, layout) {
  const border = node.stroke ? (node.strokeWidth ?? 1) : 0;
  const height = Math.max(0, box.height - 2 * border);
  if (!height) return [];
  const overhang = Math.max(0, ((node.fontSize ?? 16) - layout.lineHeight) / 2);
  return layout.lines.slice(0, Math.ceil((height + overhang) / layout.lineHeight));
}
