const PATH_DATA = /^\s*[Mm][MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]*$/;
const round = (value) => Math.round(value * 1000) / 1000;

/** SVG path data only: commands, numbers and separators, starting with a move. No markup, quotes, URLs or entities. */
export function validDesignPath(value) {
  return typeof value === "string" && value.length <= 20000 && PATH_DATA.test(value) && /\d/.test(value);
}

const PATH_FIELDS = ["path", "arc", "viewBox", "strokeCap", "strokeJoin", "strokeDash"];

/** Why a layer's path fields don't fit its type, or null. */
export function designPathProblem(node) {
  if (node.type !== "path") {
    const used = PATH_FIELDS.filter((field) => node[field] !== undefined);
    return used.length ? `Only path layers use ${used.join(", ")}; "${node.id}" is a ${node.type}.` : null;
  }
  if ((node.path === undefined) === (node.arc === undefined)) return `Path layer "${node.id}" needs path data or an arc, not both.`;
  if (node.arc && node.viewBox) return `Path layer "${node.id}" draws its arc in its own box; leave out viewBox.`;
  const unsupported = ["text", "src", "icon", "radius"].filter((field) => node[field] !== undefined);
  return unsupported.length ? `Path layer "${node.id}" can't use ${unsupported.join(", ")}. Use fill and stroke for its paint.` : null;
}

function arcData({ start = 0, sweep }, width, height, strokeWidth) {
  const radius = Math.max(0, (Math.min(width, height) - strokeWidth) / 2);
  const cx = width / 2;
  const cy = height / 2;
  const point = (degrees) => {
    const radians = ((degrees - 90) * Math.PI) / 180;
    return `${round(cx + radius * Math.cos(radians))} ${round(cy + radius * Math.sin(radians))}`;
  };
  const turn = Math.max(-360, Math.min(360, sweep));
  if (Math.abs(turn) >= 360) {
    const direction = turn > 0 ? 1 : 0;
    return `M${point(start)}A${round(radius)} ${round(radius)} 0 1 ${direction} ${point(start + turn / 2)}A${round(radius)} ${round(radius)} 0 1 ${direction} ${point(start)}`;
  }
  if (!turn) return `M${point(start)}`;
  return `M${point(start)}A${round(radius)} ${round(radius)} 0 ${Math.abs(turn) > 180 ? 1 : 0} ${turn > 0 ? 1 : 0} ${point(start + turn)}`;
}

/**
 * A path layer's geometry in its own box: `path` data in `viewBox` units (the layer's pixels by default), or an `arc`
 * of a circle centred in the box, `start` degrees clockwise from 12 o'clock for `sweep` degrees, inset by the stroke.
 */
export function designPathGeometry(node, box) {
  if (node.arc) {
    const strokeWidth = node.strokeWidth ?? 4;
    return { d: arcData(node.arc, box.width, box.height, strokeWidth), viewBox: `0 0 ${round(box.width)} ${round(box.height)}`, arc: true, strokeWidth };
  }
  const viewBox = node.viewBox ? node.viewBox.map(round).join(" ") : `0 0 ${round(box.width)} ${round(box.height)}`;
  return { d: node.path ?? "", viewBox, arc: false, strokeWidth: node.strokeWidth ?? 1 };
}

/** Whether a path layer draws a stroke: an arc always does, a path when it names a stroke color. */
export const designPathStroked = (node) => !!node.arc || !!node.stroke;

/** The stroke's shape attributes (width, cap, join, dash) shared by the HTML and SVG renderers; the color is the caller's. */
export function designPathStrokeShape(node, geometry) {
  return [
    `stroke-width="${round(geometry.strokeWidth)}"`,
    `stroke-linecap="${node.strokeCap ?? (geometry.arc ? "round" : "butt")}"`,
    `stroke-linejoin="${node.strokeJoin ?? "miter"}"`,
    ...(node.strokeDash?.length ? [`stroke-dasharray="${node.strokeDash.map(round).join(" ")}"`] : []),
  ].join(" ");
}
