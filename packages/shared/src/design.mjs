import { z } from "zod";
import { designFontFamily, designFontFaces, validDesignFontFamily } from "./design-fonts.mjs";
export { designFontFamily, designFontFaces, designInterWeight } from "./design-fonts.mjs";
import { designRenderBudget, visibleDesignTextLines } from "./design-render-limits.mjs";
import { designLayout, designTextLayout } from "./design-layout.mjs";
import { renderDesignSvg } from "./design-svg.mjs";
import { synchronizeDesignComponents, designInstanceRoot } from "./design-components.mjs";
import { DESIGN_CONTROLLER_SCRIPT } from "./design-controller-script.mjs";
export { DESIGN_CONTROLLER_SCRIPT } from "./design-controller-script.mjs";
export { designLayout, designTextLayout } from "./design-layout.mjs";
export { createDesignInstance, detachDesignInstance, designInstanceRoot } from "./design-components.mjs";

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/, "Use a stable layer id with letters, numbers, dots, underscores or dashes.");
const literalColor = z
  .string()
  .max(100)
  .regex(
    /^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]{1,24}|(?:rgb|rgba|hsl|hsla)\([\d.,%\s/+-]+\))$/,
    "Use a CSS color or a $token reference.",
  );
const color = z.union([literalColor, z.string().regex(/^\$[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/)]);
const coordinate = z.number().finite().min(-32000).max(32000);
const dimension = z.number().finite().min(1).max(16000);
const size = z.number().finite().min(0).max(2000);

const nodeSchema = z
  .object({
    id,
    name: z.string().max(160).optional(),
    type: z.enum(["frame", "text", "rectangle", "ellipse", "image"]),
    parentId: id.optional(),
    x: coordinate.optional(),
    y: coordinate.optional(),
    width: dimension,
    height: dimension,
    widthMode: z
      .enum(["fixed", "hug", "fill"])
      .optional()
      .describe("Fixed uses width in pixels; hug fits content; fill uses available parent space. Defaults to fixed."),
    heightMode: z
      .enum(["fixed", "hug", "fill"])
      .optional()
      .describe("Fixed uses height in pixels; hug fits content; fill uses available parent space. Defaults to fixed."),
    minWidth: z.number().finite().min(0).max(16000).optional(),
    minHeight: z.number().finite().min(0).max(16000).optional(),
    fill: color.optional(),
    stroke: color.optional(),
    strokeWidth: size.optional(),
    radius: size.optional(),
    opacity: z.number().finite().min(0).max(1).optional(),
    text: z.string().max(20000).optional(),
    fontSize: z.number().finite().min(1).max(1000).optional(),
    fontFamily: z.string().max(160).refine(validDesignFontFamily, "Use non-empty font family names separated by commas.").optional(),
    fontWeight: z.number().int().min(100).max(900).optional(),
    lineHeight: z.number().finite().min(0.5).max(5).optional().describe("Unitless line-height multiplier, such as 1.35 or 1.5, never pixels. Default 1.35."),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    src: z
      .string()
      .max(500000)
      .refine(
        (value) => /^https:\/\/[^\s<>"']+$/i.test(value) || /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[a-zA-Z0-9+/=]+$/.test(value),
        "Images need an HTTPS URL or an inline PNG, JPEG, WebP, GIF or AVIF.",
      )
      .optional(),
    layout: z.enum(["free", "horizontal", "vertical"]).optional(),
    gap: size.optional(),
    padding: size.optional(),
    align: z.enum(["start", "center", "end"]).optional(),
    justify: z.enum(["start", "center", "end", "space-between"]).optional(),
    hidden: z.boolean().optional(),
    locked: z.boolean().optional(),
    component: z.boolean().optional().describe("Mark a frame as a reusable main component. Nested components are not supported."),
    componentId: id.optional().describe("Link an instance frame to a main component id. Its children are generated and follow the main component."),
    componentSourceId: id
      .optional()
      .describe("Generated reference from an instance descendant to its main layer. Edit the main component or detach the instance."),
  })
  .strict();

export const designDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    width: z.number().int().min(240).max(3840),
    height: z.number().int().min(240).max(3840),
    background: color.optional(),
    tokens: z
      .record(id, literalColor)
      .refine((value) => Object.keys(value).length <= 200, "Use at most 200 color tokens.")
      .optional(),
    nodes: z.array(nodeSchema).max(1000),
  })
  .strict();

export const designOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("update"), id, patch: nodeSchema.omit({ id: true }).partial().strict() }).strict(),
  z.object({ op: z.literal("insert"), node: nodeSchema, index: z.number().int().min(0).max(1000).optional() }).strict(),
  z.object({ op: z.literal("delete"), id }).strict(),
  z.object({ op: z.literal("replace"), document: designDocumentSchema }).strict(),
]);

function checkedDesignDocument(value, synchronize = true) {
  const document = designDocumentSchema.parse(value);
  if (JSON.stringify(document).length > 1000000) throw new Error("A design document is limited to 1,000,000 characters.");
  const nodes = new Map();
  for (const node of document.nodes) {
    if (nodes.has(node.id)) throw new Error(`Layer id "${node.id}" is duplicated.`);
    nodes.set(node.id, node);
  }
  const checkColor = (value) => {
    if (value?.startsWith("$") && !Object.hasOwn(document.tokens ?? {}, value.slice(1))) throw new Error(`Color token "${value}" does not exist.`);
  };
  checkColor(document.background);
  for (const node of document.nodes) {
    checkColor(node.fill);
    checkColor(node.stroke);
    const seen = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId !== undefined) {
      if (seen.has(parentId)) throw new Error(`Layer "${node.id}" has a circular parent.`);
      if (seen.size >= 32) throw new Error("Design layers can nest at most 32 levels.");
      seen.add(parentId);
      const parent = nodes.get(parentId);
      if (!parent) throw new Error(`Parent layer "${parentId}" does not exist.`);
      if (parent.type !== "frame") throw new Error(`Parent layer "${parentId}" must be a frame.`);
      parentId = parent.parentId;
    }
  }
  return synchronize ? checkedDesignDocument(synchronizeDesignComponents(document), false) : document;
}

export function validateDesignDocument(value) {
  return checkedDesignDocument(value);
}

function belongsToComponent(byId, sourceId, componentId) {
  let node = byId.get(sourceId);
  for (let depth = 0; node?.parentId && depth < 32; depth++) {
    if (node.parentId === componentId) return true;
    node = byId.get(node.parentId);
  }
  return false;
}

// Only existing, valid generated layers may disappear when an operation removes
// their main layer. A replacement supplies fresh references and cannot inherit trust.
function generatedComponentSources(document) {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const sources = new Map();
  const counts = new Map();
  for (const node of document.nodes) {
    if (!node.componentSourceId) continue;
    const instance = designInstanceRoot(document, node.id, byId);
    if (!instance || node.id === instance.id || !byId.get(instance.componentId)?.component) continue;
    if (!belongsToComponent(byId, node.componentSourceId, instance.componentId)) continue;
    const key = JSON.stringify([instance.id, node.componentSourceId]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    sources.set(node.id, { instanceId: instance.id, componentId: instance.componentId, sourceId: node.componentSourceId, key });
  }
  for (const [id, source] of sources) if (counts.get(source.key) !== 1) sources.delete(id);
  return sources;
}

/** Validate only the final tree, so one batch can insert children before their parent. */
export function applyDesignOperations(document, operations) {
  let result = validateDesignDocument(document);
  let previousSources = generatedComponentSources(result);
  const parsed = z.array(designOperationSchema).min(1).max(1000).parse(operations);
  for (const operation of parsed) {
    if (operation.op === "replace") {
      result = designDocumentSchema.parse(operation.document);
      previousSources = generatedComponentSources(result);
      continue;
    }
    if (operation.op === "insert") {
      if (operation.node.parentId && designInstanceRoot(result, operation.node.parentId))
        throw Error("Edit the main component or detach this instance before adding layers.");
      if (result.nodes.some((node) => node.id === operation.node.id)) throw new Error(`Layer id "${operation.node.id}" already exists.`);
      const index = operation.index ?? result.nodes.length;
      if (index > result.nodes.length) throw new Error("Layer insertion index is past the end of the document.");
      result.nodes.splice(index, 0, nodeSchema.parse(operation.node));
      continue;
    }
    const index = result.nodes.findIndex((node) => node.id === operation.id);
    if (index < 0) throw new Error(`Layer "${operation.id}" does not exist.`);
    const instance = designInstanceRoot(result, operation.id);
    if (
      instance &&
      (instance.id !== operation.id ||
        (operation.op === "update" && Object.keys(operation.patch).some((field) => !["x", "y", "parentId", "name", "hidden", "locked"].includes(field))))
    ) {
      throw Error("Edit the main component or detach this instance before changing its layers.");
    }
    if (operation.op === "update") {
      if (operation.patch.parentId && designInstanceRoot(result, operation.patch.parentId))
        throw Error("Edit the main component or detach this instance before moving layers into it.");
      result.nodes[index] = { ...result.nodes[index], ...operation.patch };
    } else {
      const removed = new Set([operation.id]);
      for (let changed = true; changed;) {
        changed = false;
        for (const node of result.nodes) {
          if (removed.has(node.parentId) && !removed.has(node.id)) {
            removed.add(node.id);
            changed = true;
          }
        }
      }
      result.nodes = result.nodes.filter((node) => !removed.has(node.id));
    }
  }
  const byId = new Map(result.nodes.map((node) => [node.id, node]));
  result.nodes = result.nodes.filter((node) => {
    const previous = previousSources.get(node.id);
    if (!previous || previous.sourceId !== node.componentSourceId) return true;
    const instance = designInstanceRoot(result, node.id, byId);
    if (instance?.id !== previous.instanceId || instance.componentId !== previous.componentId || !byId.get(instance.componentId)?.component) return true;
    return belongsToComponent(byId, node.componentSourceId, instance.componentId);
  });
  return validateDesignDocument(result);
}

export function diffDesignDocuments(before, after) {
  const a = validateDesignDocument(before),
    b = validateDesignDocument(after);
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const { nodes: oldNodes, ...oldMetadata } = a;
  const { nodes: newNodes, ...newMetadata } = b;
  const replace = () => [{ op: "replace", document: b }];
  if (JSON.stringify(oldMetadata) !== JSON.stringify(newMetadata)) return replace();
  const oldById = new Map(oldNodes.map((node) => [node.id, node]));
  const newById = new Map(newNodes.map((node) => [node.id, node]));
  const oldOrder = oldNodes.filter((node) => newById.has(node.id)).map((node) => node.id);
  const newOrder = newNodes.filter((node) => oldById.has(node.id)).map((node) => node.id);
  if (JSON.stringify(oldOrder) !== JSON.stringify(newOrder)) return replace();
  // Reparenting a child away from a deleted frame needs a replacement to avoid cascading deletion.
  if (newNodes.some((node) => oldById.get(node.id)?.parentId && !newById.has(oldById.get(node.id).parentId))) return replace();
  const operations = [];
  for (const node of oldNodes) {
    const instance = designInstanceRoot(a, node.id, oldById);
    if (instance && instance.id !== node.id) continue;
    if (!newById.has(node.id) && (!node.parentId || newById.has(node.parentId))) operations.push({ op: "delete", id: node.id });
  }
  for (const [index, node] of newNodes.entries()) {
    const instance = designInstanceRoot(b, node.id, newById);
    if (instance && instance.id !== node.id) continue;
    const old = oldById.get(node.id);
    if (!old) {
      operations.push({ op: "insert", node, index });
      continue;
    }
    if (Object.keys(old).some((field) => !Object.hasOwn(node, field))) return replace();
    const patch = Object.fromEntries(
      Object.entries(node).filter(
        ([field, value]) => field !== "id" && old[field] !== value && (!instance || ["x", "y", "parentId", "name", "hidden", "locked"].includes(field)),
      ),
    );
    if (Object.keys(patch).length) operations.push({ op: "update", id: node.id, patch });
  }
  // Preserve the exact final document when a complex insertion/deletion changes index semantics.
  try {
    if (JSON.stringify(applyDesignOperations(a, operations)) !== JSON.stringify(b)) return replace();
  } catch {
    return replace();
  }
  return operations;
}

export function designColor(document, value, fallback = "transparent") {
  return value?.startsWith("$") ? (document.tokens?.[value.slice(1)] ?? fallback) : (value ?? fallback);
}

export function designNodeAt(document, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > document.width || y > document.height) return null;
  const layout = designLayout(document);
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const contains = (box) => box && x >= box.x && y >= box.y && x <= box.x + box.width && y <= box.y + box.height;
  for (const [id, box] of [...layout].reverse()) {
    if (!contains(box)) continue;
    const node = nodes.get(id);
    let parentId = node.parentId;
    let clipped = false;
    while (parentId) {
      if (!contains(layout.get(parentId))) {
        clipped = true;
        break;
      }
      parentId = nodes.get(parentId)?.parentId;
    }
    // Feedback names an editable instance, never one of its generated children.
    if (!clipped) return designInstanceRoot(document, node.id, nodes) ?? node;
  }
  return null;
}

const escape = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const safeJson = (value) => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

function nodeStyles(document, node, box, parentBox, parentNode) {
  // Transparent images (icons, cut-outs) show what is behind them; the grey placeholder marks an image still to add.
  const placeholder = node.type === "frame" || (node.type === "image" && node.src) ? "transparent" : "#d8ded8";
  const background = node.type === "text" ? "transparent" : designColor(document, node.fill, placeholder);
  const parentStroke = parentNode?.stroke ? (parentNode.strokeWidth ?? 1) : 0;
  return [
    "position:absolute",
    "box-sizing:border-box",
    `left:${box.x - (parentBox?.x ?? 0) - parentStroke}px`,
    `top:${box.y - (parentBox?.y ?? 0) - parentStroke}px`,
    `width:${box.width}px`,
    `height:${box.height}px`,
    `background:${background}`,
    `opacity:${node.opacity ?? 1}`,
    `border-radius:${node.type === "ellipse" ? "50%" : `${node.radius ?? 0}px`}`,
    `border:${node.stroke ? (node.strokeWidth ?? 1) : 0}px solid ${designColor(document, node.stroke)}`,
    "overflow:hidden",
    ...(node.type === "text"
      ? [
          `color:${designColor(document, node.fill, "#202720")}`,
          `font-size:${node.fontSize ?? 16}px`,
          `font-family:${designFontFamily(node.fontFamily)}`,
          `font-weight:${node.fontWeight ?? 400}`,
          `text-align:${node.textAlign ?? "left"}`,
          `line-height:${node.lineHeight ?? 1.35}`,
          "font-kerning:none",
          "font-variant-ligatures:none",
          'font-feature-settings:"calt" 0',
          "white-space:pre-wrap",
          "overflow-wrap:normal",
        ]
      : []),
  ].join(";");
}

// Shared for one render only: neither old documents nor arbitrary user text remain cached afterward.
function cachedTextLayout() {
  const cache = new WeakMap();
  return (node, width = Infinity) => {
    let widths = cache.get(node);
    if (!widths) {
      widths = new Map();
      cache.set(node, widths);
    }
    if (!widths.has(width)) widths.set(width, designTextLayout(node, width));
    return widths.get(width);
  };
}

function designMarkup(document, bounds, textLayout, take) {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const children = new Map();
  for (const node of document.nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const parts = [];
  const append = (part, node) => parts.push(take(part, node));
  const render = (parentId) => {
    for (const node of children.get(parentId) ?? []) {
      const box = bounds.get(node.id);
      if (!box) continue;
      append(
        `<div data-design-node="${escape(node.id)}" aria-label="${escape(node.name ?? node.id)}" style="${escape(nodeStyles(document, node, box, bounds.get(parentId), nodes.get(parentId)))}">`,
        node,
      );
      if (node.type === "text") {
        const layout = textLayout(node, Math.max(1, box.width - 2 * (node.stroke ? (node.strokeWidth ?? 1) : 0)));
        for (const line of visibleDesignTextLines(node, box, layout)) {
          append(`<span style="display:block;white-space:pre;height:${layout.lineHeight}px">${escape(line) || "&#8203;"}</span>`, node);
        }
      } else if (node.type === "image" && node.src) {
        append(
          `<img src="${escape(node.src)}" alt="${escape(node.name ?? "")}" draggable="false" style="width:100%;height:100%;object-fit:cover;pointer-events:none"/>`,
          node,
        );
      }
      render(node.id);
      append("</div>", node);
    }
  };
  render(undefined);
  return parts.join("");
}

export function designHtml(value, options = {}) {
  const document = validateDesignDocument(value);
  const textLayout = cachedTextLayout();
  const bounds = designLayout(document, textLayout);
  const selected = options.selectedId && document.nodes.some((node) => node.id === options.selectedId) ? options.selectedId : null;
  const box = selected && bounds.get(selected);
  const interactive = options.interactive === true;
  const selection = `<div id="design-selection" style="position:absolute;box-sizing:border-box;pointer-events:none;border:2px solid #367bf5;z-index:2147483646;${box ? `left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px` : "display:none"}">${interactive ? '<span id="design-resize" style="position:absolute;right:-5px;bottom:-5px;width:10px;height:10px;border:1px solid #367bf5;background:white;pointer-events:auto;cursor:nwse-resize"></span>' : ""}</div>`;
  const fontFaces = designFontFaces(document);
  const take = designRenderBudget("HTML");
  return (
    take(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${document.width}, initial-scale=1"><style>html,body{margin:0;padding:0;width:${document.width}px;height:${document.height}px;overflow:hidden}body{background:${escape(designColor(document, document.background, "#ffffff"))}}*{box-sizing:border-box}#design-root{position:relative;width:100%;height:100%;${interactive ? "touch-action:none;user-select:none;cursor:default" : ""}}</style>${fontFaces ? `<style>${fontFaces}</style>` : ""}</head><body><main id="design-root">`,
    ) +
    designMarkup(document, bounds, textLayout, take) +
    take(
      `${selection}</main>${interactive ? `<script type="application/json" id="design-config">${safeJson([document, selected, Object.fromEntries(bounds)])}</script><script>${DESIGN_CONTROLLER_SCRIPT}</script>` : ""}</body></html>`,
    )
  );
}

/** Build-time only. The checked-in literal keeps the controller's CSP hash stable through bundling. */
export function buildDesignControllerScript() {
  return `(${previewController.toString()})(...JSON.parse(document.getElementById("design-config").textContent));`;
}

/** Runs only in the design iframe. It can report edits, never persist them or access the application. */
function previewController(design, selected, bounds) {
  const nodes = new Map(design.nodes.map((node) => [node.id, node]));
  const elements = new Map([...document.querySelectorAll("[data-design-node]")].map((element) => [element.dataset.designNode, element]));
  const root = document.getElementById("design-root");
  const outline = document.getElementById("design-selection");
  const handle = document.getElementById("design-resize");
  const multiple = document.createElement("div");
  multiple.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2147483645";
  root.appendChild(multiple);
  const guides = document.createElement("div");
  guides.id = "design-guides";
  guides.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:2147483647";
  root.appendChild(guides);
  let selection = selected ? [selected] : [];
  let dragging = null;
  const send = (message) => parent.postMessage(message, "*");
  function instanceRoot(id) {
    let node = nodes.get(id);
    while (node) {
      if (node.componentId) return node.id;
      node = nodes.get(node.parentId);
    }
    return id;
  }
  function normalize(ids) {
    const unique = [...new Set(ids.filter((id) => nodes.has(id) && bounds[id]).map(instanceRoot))];
    return unique.filter((id) => {
      let parentId = nodes.get(id).parentId;
      while (parentId) {
        if (unique.includes(parentId)) return false;
        parentId = nodes.get(parentId)?.parentId;
      }
      return true;
    });
  }
  function union(boxes) {
    const x = Math.min(...boxes.map((box) => box.x)),
      y = Math.min(...boxes.map((box) => box.y));
    return { x, y, width: Math.max(...boxes.map((box) => box.x + box.width)) - x, height: Math.max(...boxes.map((box) => box.y + box.height)) - y };
  }
  function show(overrides = new Map()) {
    multiple.replaceChildren();
    const boxes = selection.map((id) => overrides.get(id) ?? bounds[id]).filter(Boolean);
    if (!boxes.length) {
      outline.style.display = "none";
      return;
    }
    const box = union(boxes);
    Object.assign(outline.style, { display: "block", left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
    const node = nodes.get(selection[0]);
    handle.style.display = selection.length === 1 && unlocked(node.id) && !node.componentId ? "block" : "none";
    if (selection.length > 1)
      for (const rectangle of boxes) {
        const item = document.createElement("div");
        item.style.cssText = `position:absolute;box-sizing:border-box;border:1px solid #367bf5;left:${rectangle.x}px;top:${rectangle.y}px;width:${rectangle.width}px;height:${rectangle.height}px`;
        multiple.appendChild(item);
      }
  }
  function select(ids) {
    selection = normalize(ids);
    show();
    send({ type: "milagre:design-select", ids: selection, id: selection.at(-1) ?? null });
  }
  function unlocked(id) {
    let node = nodes.get(id);
    if (!node || !bounds[id]) return false;
    while (node) {
      if (node.locked) return false;
      node = nodes.get(node.parentId);
    }
    return true;
  }
  function movable(id) {
    const parentNode = nodes.get(nodes.get(id)?.parentId);
    return unlocked(id) && (!parentNode?.layout || parentNode.layout === "free");
  }
  show();
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.type !== "milagre:design-selection" || dragging) return;
    selection = normalize(Array.isArray(event.data.ids) ? event.data.ids : typeof event.data.id === "string" ? [event.data.id] : []);
    show();
  });
  root.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const resizing = event.target === handle;
    const hit = resizing ? selection[0] : event.target.closest("[data-design-node]")?.dataset.designNode;
    const id = hit ? instanceRoot(hit) : null;
    if (!resizing && (event.shiftKey || event.metaKey || event.ctrlKey)) {
      select(id ? (selection.includes(id) ? selection.filter((item) => item !== id) : [...selection, id]) : selection);
      return;
    }
    select(id ? (selection.includes(id) ? selection : [id]) : []);
    const targets = (resizing ? selection : selection.filter(movable))
      .map((nodeId) => ({ node: nodes.get(nodeId), box: bounds[nodeId], element: elements.get(nodeId) }))
      .filter((target) => target.element && target.box);
    if (!targets.length || (resizing && (!unlocked(targets[0].node.id) || targets[0].node.componentId))) return;
    dragging = {
      targets,
      resizing,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
      dx: 0,
      dy: 0,
      box: union(targets.map((target) => target.box)),
    };
    root.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  function snap(axis, values, excluded) {
    let best = { delta: 0, distance: 6, line: null };
    const candidates = [0, (axis === "x" ? design.width : design.height) / 2, axis === "x" ? design.width : design.height];
    for (const [id, box] of Object.entries(bounds)) {
      let node = nodes.get(id),
        skip = false;
      while (node) {
        if (excluded.has(node.id)) {
          skip = true;
          break;
        }
        node = nodes.get(node.parentId);
      }
      if (skip) continue;
      candidates.push(box[axis], box[axis] + box[axis === "x" ? "width" : "height"] / 2, box[axis] + box[axis === "x" ? "width" : "height"]);
    }
    for (const candidate of candidates)
      for (const value of values) {
        const delta = candidate - value;
        if (Math.abs(delta) < best.distance) best = { delta, distance: Math.abs(delta), line: candidate };
      }
    return best;
  }
  function guide(axis, position) {
    if (position === null) return;
    const line = document.createElement("div");
    line.style.cssText =
      axis === "x"
        ? `position:absolute;left:${position}px;top:0;height:100%;border-left:1px solid #f25fa8`
        : `position:absolute;top:${position}px;left:0;width:100%;border-top:1px solid #f25fa8`;
    guides.appendChild(line);
  }
  root.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const drag = dragging;
    drag.dx = Math.round(event.clientX - drag.clientX);
    drag.dy = Math.round(event.clientY - drag.clientY);
    drag.moved ||= Math.abs(drag.dx) + Math.abs(drag.dy) > 2;
    if (!drag.moved) return;
    guides.replaceChildren();
    if (!event.altKey) {
      const excluded = new Set(drag.targets.map((target) => target.node.id));
      const box = drag.box;
      const sx = snap(
        "x",
        drag.resizing ? [box.x + box.width + drag.dx] : [box.x + drag.dx, box.x + box.width / 2 + drag.dx, box.x + box.width + drag.dx],
        excluded,
      );
      const sy = snap(
        "y",
        drag.resizing ? [box.y + box.height + drag.dy] : [box.y + drag.dy, box.y + box.height / 2 + drag.dy, box.y + box.height + drag.dy],
        excluded,
      );
      drag.dx += sx.delta;
      drag.dy += sy.delta;
      guide("x", sx.line);
      guide("y", sy.line);
    }
    const overrides = new Map();
    for (const target of drag.targets) {
      const box = { ...target.box };
      if (drag.resizing) {
        box.width = Math.max(target.node.minWidth ?? 1, Math.min(16000, box.width + drag.dx));
        box.height = Math.max(target.node.minHeight ?? 1, Math.min(16000, box.height + drag.dy));
        target.element.style.width = `${box.width}px`;
        target.element.style.height = `${box.height}px`;
      } else {
        box.x += drag.dx;
        box.y += drag.dy;
        const parentBox = bounds[target.node.parentId] ?? { x: 0, y: 0 };
        const parentNode = nodes.get(target.node.parentId);
        const parentStroke = parentNode?.stroke ? (parentNode.strokeWidth ?? 1) : 0;
        target.element.style.left = `${box.x - parentBox.x - parentStroke}px`;
        target.element.style.top = `${box.y - parentBox.y - parentStroke}px`;
      }
      overrides.set(target.node.id, box);
    }
    show(overrides);
  });
  function finish(cancelled) {
    if (!dragging) return;
    const drag = dragging;
    dragging = null;
    guides.replaceChildren();
    if (cancelled || !drag.moved) {
      for (const target of drag.targets) {
        const parentBox = bounds[target.node.parentId] ?? { x: 0, y: 0 };
        const parentNode = nodes.get(target.node.parentId);
        const parentStroke = parentNode?.stroke ? (parentNode.strokeWidth ?? 1) : 0;
        Object.assign(target.element.style, {
          left: `${target.box.x - parentBox.x - parentStroke}px`,
          top: `${target.box.y - parentBox.y - parentStroke}px`,
          width: `${target.box.width}px`,
          height: `${target.box.height}px`,
        });
      }
      show();
      return;
    }
    const operations = drag.targets.map((target) => ({
      op: "update",
      id: target.node.id,
      patch: drag.resizing
        ? {
            width: Math.max(1, target.node.minWidth ?? 1, Math.min(16000, target.box.width + drag.dx)),
            height: Math.max(1, target.node.minHeight ?? 1, Math.min(16000, target.box.height + drag.dy)),
            widthMode: "fixed",
            heightMode: "fixed",
          }
        : { x: Math.max(-32000, Math.min(32000, (target.node.x ?? 0) + drag.dx)), y: Math.max(-32000, Math.min(32000, (target.node.y ?? 0) + drag.dy)) },
    }));
    send({ type: "milagre:design-update", operations });
  }
  root.addEventListener("pointerup", () => finish(false));
  root.addEventListener("pointercancel", () => finish(true));
  window.addEventListener("keydown", (event) => {
    const command =
      (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z"
        ? event.shiftKey
          ? "redo"
          : "undo"
        : (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d"
          ? "duplicate"
          : ["Backspace", "Delete"].includes(event.key)
            ? "delete"
            : null;
    if (command) {
      event.preventDefault();
      send({ type: "milagre:design-command", command });
      return;
    }
    if (!/^Arrow(Left|Right|Up|Down)$/.test(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
    const operations = selection.filter(movable).map((id) => ({
      op: "update",
      id,
      patch: { x: Math.max(-32000, Math.min(32000, (nodes.get(id).x ?? 0) + dx)), y: Math.max(-32000, Math.min(32000, (nodes.get(id).y ?? 0) + dy)) },
    }));
    if (operations.length) {
      // Key repeats can arrive before the parent replaces the preview. Accumulate them locally.
      for (const operation of operations) Object.assign(nodes.get(operation.id), operation.patch);
      send({ type: "milagre:design-update", operations });
    }
  });
}

/** embedFonts: false leaves Inter as a font-family reference, for callers that must stay small (a shared page of many designs). */
export function designSvg(value, { embedFonts = true } = {}) {
  const document = validateDesignDocument(value);
  const textLayout = cachedTextLayout();
  return renderDesignSvg(
    document,
    designLayout(document, textLayout),
    textLayout,
    (value, fallback) => designColor(document, value, fallback),
    embedFonts ? designFontFaces(document) : "",
  );
}

/** A compact, editable screen used by the isolated desktop and phone fixtures. */
export function createExampleDesign() {
  return {
    schemaVersion: 1,
    width: 390,
    height: 844,
    background: "$paper",
    tokens: { paper: "#f5f2eb", ink: "#253b32", muted: "#727b72", accent: "#be4f36", line: "#deddd3" },
    nodes: [
      {
        id: "brand",
        name: "Fieldnotes",
        type: "text",
        x: 28,
        y: 54,
        width: 260,
        height: 25,
        text: "FIELDNOTES",
        fill: "$muted",
        fontSize: 12,
        fontWeight: 700,
      },
      {
        id: "heading",
        name: "Page heading",
        type: "text",
        x: 28,
        y: 104,
        width: 330,
        height: 96,
        text: "Make room\nfor a good day.",
        fontFamily: "Georgia, serif",
        fontSize: 36,
        fill: "$ink",
      },
      { id: "date", name: "Date", type: "text", x: 28, y: 218, width: 330, height: 24, text: "Monday, October 12", fill: "$muted", fontSize: 14 },
      {
        id: "card",
        name: "Today card",
        type: "frame",
        x: 28,
        y: 271,
        width: 334,
        height: 272,
        fill: "#ffffff",
        radius: 20,
        stroke: "$line",
        strokeWidth: 1,
        layout: "vertical",
        padding: 24,
        gap: 16,
      },
      {
        id: "card-label",
        parentId: "card",
        name: "Section label",
        type: "text",
        width: 286,
        height: 18,
        text: "YOUR DAILY PRACTICE",
        fill: "$muted",
        fontSize: 11,
        fontWeight: 700,
      },
      {
        id: "card-title",
        parentId: "card",
        name: "Practice title",
        type: "text",
        width: 286,
        height: 62,
        text: "A little less rush.\nA little more outside.",
        fill: "$ink",
        fontFamily: "Georgia, serif",
        fontSize: 23,
      },
      {
        id: "card-body",
        parentId: "card",
        name: "Practice description",
        type: "text",
        width: 286,
        height: 47,
        text: "Take a short walk. Leave your phone in your pocket. Notice what changed.",
        fill: "$muted",
        fontSize: 14,
      },
      {
        id: "button",
        parentId: "card",
        name: "Start walk button",
        type: "frame",
        width: 286,
        height: 46,
        fill: "$accent",
        radius: 12,
        layout: "horizontal",
        padding: 12,
        align: "center",
        justify: "center",
      },
      {
        id: "button-label",
        parentId: "button",
        name: "Button label",
        type: "text",
        width: 240,
        height: 20,
        text: "Start a 10-minute walk",
        textAlign: "center",
        fill: "#ffffff",
        fontSize: 14,
        fontWeight: 600,
      },
      {
        id: "reflection",
        name: "Reflection prompt",
        type: "text",
        x: 28,
        y: 582,
        width: 320,
        height: 24,
        text: "What felt good today?",
        fill: "$ink",
        fontFamily: "Georgia, serif",
        fontSize: 21,
      },
      { id: "note", name: "Reflection field", type: "frame", x: 28, y: 623, width: 334, height: 90, fill: "#ece9df", radius: 14 },
      {
        id: "note-placeholder",
        parentId: "note",
        name: "Reflection placeholder",
        type: "text",
        x: 18,
        y: 18,
        width: 294,
        height: 44,
        text: "One small thing is enough...",
        fill: "$muted",
        fontSize: 14,
      },
      {
        id: "footer",
        name: "Footer",
        type: "text",
        x: 28,
        y: 772,
        width: 334,
        height: 20,
        text: "Small steps. A day at a time.",
        fill: "$muted",
        textAlign: "center",
        fontSize: 12,
      },
    ],
  };
}
