import { assertDesignEditIntent } from "./design-intent.mjs";
import { nodeSchema, designDocumentSchema, designOperationSchema } from "./design-schemas.mjs";
export {
  designDocumentSchema,
  designDocumentInputSchema,
  designOperationSchema,
  designOperationInputSchema,
  designEditIntentSchema,
} from "./design-schemas.mjs";
import { designError } from "./design-errors.mjs";
export { designErrorIssues, conciseDesignError } from "./design-errors.mjs";
import { designKitSchema, resolveDesignKit } from "./design-kit.mjs";
export { designKitSchema, designKitDataSchema, validateDesignConsistency } from "./design-kit.mjs";
import { z } from "zod";
import { designFontFamily, designFontFaces } from "./design-fonts.mjs";
export {
  DESIGN_CATALOG_FAMILIES,
  designAppleFamily,
  designBundledFont,
  designCatalogFont,
  designFontSubstitute,
  designLocalFamily,
  setDesignLocalFonts,
  designFontBuffers,
  designFontFamily,
  designFontFaces,
  designInterHasGlyph,
  designInterWeight,
  designUsesInter,
  loadDesignFonts,
} from "./design-fonts.mjs";
import { designRenderBudget, visibleDesignTextLines } from "./design-render-limits.mjs";
import { designLayout, designTextLayout } from "./design-layout.mjs";
import { designIcons, designIconSuggestions } from "./design-icons.mjs";
export { designIcons } from "./design-icons.mjs";
export { DESIGN_INK, DESIGN_PLACEHOLDER, designDefaultFill } from "./design-paint.mjs";
import { renderDesignSvg } from "./design-svg.mjs";
import { DESIGN_INK, designDefaultFill } from "./design-paint.mjs";
import { designColorProblem, designColorReferences, designDocumentForMode, resolveDesignColor } from "./design-tokens.mjs";
import { designModesOf } from "./design-modes.mjs";
import { designLucideIcon, designSymbolImage, designSymbolSyntax } from "./design-symbols.mjs";
export {
  DESIGN_SF_SYMBOL_LUCIDE,
  designSymbolImage,
  designSymbolLucide,
  designSymbolName,
  designSymbolStroke,
  designSymbolsAvailable,
  loadDesignSymbols,
  setDesignSymbols,
} from "./design-symbols.mjs";
import { designPathGeometry, designPathProblem, designPathStroked, designPathStrokeShape } from "./design-path.mjs";
export { designColorReferences, designDocumentForMode, resolveDesignColor } from "./design-tokens.mjs";
export { DESIGN_MODES, DESIGN_MODE_LABELS, designHtmlForMode, designModesOf } from "./design-modes.mjs";
import { synchronizeDesignComponents, designInstanceRoot, detachDesignInstance } from "./design-components.mjs";
export { designLayout, designTextLayout } from "./design-layout.mjs";
export { designWarnings, designWarningText, designDiagnostics } from "./design-lint.mjs";
export { createDesignInstance, detachDesignInstance, designInstanceRoot } from "./design-components.mjs";

function checkedDesignDocument(value, synchronize = true) {
  const document = resolveDesignKit(designDocumentSchema.parse(value));
  if (JSON.stringify(document).length > 1000000) throw new Error("A design document is limited to 1,000,000 characters.");
  const nodes = new Map();
  for (const node of document.nodes) {
    if (nodes.has(node.id)) throw new Error(`Layer id "${node.id}" is duplicated.`);
    nodes.set(node.id, node);
  }
  const checkColor = (value, path) => {
    const problem = value === undefined ? null : designColorProblem(document.tokens, value);
    if (problem) throw designError(problem, path);
  };
  for (const [name, value] of Object.entries(document.tokens ?? {})) checkColor(value, ["tokens", name]);
  checkColor(document.background, ["background"]);
  for (const node of document.nodes) {
    checkColor(node.fill, ["nodes", document.nodes.indexOf(node), "fill"]);
    checkColor(node.stroke, ["nodes", document.nodes.indexOf(node), "stroke"]);
    if (node.type === "icon") {
      if (!node.icon) throw new Error(`Icon layer "${node.id}" needs an icon name.`);
      if (node.icon.startsWith("sf:") ? !designSymbolSyntax(node.icon) : !Object.hasOwn(designIcons, node.icon))
        throw new Error(
          node.icon.startsWith("sf:")
            ? `"${node.icon}" on layer "${node.id}" isn't an SF Symbol name: write sf: and the symbol's name, such as sf:heart.fill.`
            : `Unknown icon "${node.icon}" on layer "${node.id}". Did you mean ${designIconSuggestions(node.icon).join(", ")}? Name an SF Symbol as sf:name.`,
        );
      const unsupported = ["stroke", "radius", "text", "src"].filter((field) => node[field] !== undefined);
      if (unsupported.length)
        throw new Error(`Icon layer "${node.id}" can't use ${unsupported.join(", ")}. Use fill for its color and strokeWidth for its line weight.`);
    } else if (node.icon !== undefined) throw new Error(`Only icon layers use "icon"; "${node.id}" is a ${node.type}.`);
    const pathProblem = designPathProblem(node);
    if (pathProblem) throw designError(pathProblem, ["nodes", document.nodes.indexOf(node)]);
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

export function validateDesignKit(value) {
  const kit = designKitSchema.parse(value);
  if (JSON.stringify(kit).length > 250000) throw Error("A design kit is limited to 250,000 characters.");
  for (const [id, nodes] of Object.entries(kit.components ?? {})) {
    const checked = validateDesignDocument({ schemaVersion: 1, width: 390, height: 844, kit: { ...kit, components: {} }, nodes });
    const roots = checked.nodes.filter((node) => !node.parentId);
    if (roots.length !== 1 || roots[0].id !== id || !roots[0].component) throw Error(`Kit component "${id}" needs one root main component with the same id.`);
  }
  return kit;
}

function belongsToComponent(byId, sourceId, componentId) {
  let node = byId.get(sourceId);
  for (let depth = 0; node?.parentId && depth < 32; depth++) {
    if (node.parentId === componentId) return true;
    node = byId.get(node.parentId);
  }
  return false;
}

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

export function applyDesignOperations(document, operations, intent) {
  const before = intent === undefined ? undefined : validateDesignDocument(document);
  let result = validateDesignDocument(document);
  let previousSources = generatedComponentSources(result);
  const parsed = z.array(designOperationSchema).min(1).max(1000).parse(operations);
  for (const operation of parsed) {
    if (operation.op === "document") {
      const patch = operation.patch;
      const tokens = patch.kit ? { ...patch.kit.colors, ...patch.tokens } : patch.tokens ? { ...result.tokens, ...patch.tokens } : result.tokens;
      Object.assign(result, patch);
      if (tokens) result.tokens = tokens;
      continue;
    }
    if (operation.op === "detach") {
      result = detachDesignInstance(result, operation.id)[0].document;
      continue;
    }
    if (operation.op === "duplicate") {
      const root = result.nodes.find((node) => node.id === operation.id);
      if (!root) throw Error(`Layer "${operation.id}" does not exist.`);
      const instance = designInstanceRoot(result, root.id);
      if (instance && instance.id !== root.id) throw Error("Duplicate the instance root, or detach it first.");
      const ids = new Set([root.id]);
      for (let changed = true; changed;) {
        changed = false;
        for (const node of result.nodes)
          if (ids.has(node.parentId) && !ids.has(node.id)) {
            ids.add(node.id);
            changed = true;
          }
      }
      const copies = result.nodes.filter((node) => ids.has(node.id));
      let copyIndex = 0;
      const names = new Map(copies.map((node) => [node.id, node.id === root.id ? operation.newId : `${operation.newId.slice(0, 80)}-${++copyIndex}`]));
      names.set(root.id, operation.newId);
      if (new Set(names.values()).size !== names.size || result.nodes.some((node) => [...names.values()].includes(node.id)))
        throw Error("Duplicate layer ids already exist. Choose another newId.");
      for (const node of copies) {
        const copy = { ...node, id: names.get(node.id) };
        if (ids.has(copy.parentId)) copy.parentId = names.get(copy.parentId);
        if (ids.has(copy.componentId)) copy.componentId = names.get(copy.componentId);
        if (ids.has(copy.componentSourceId)) copy.componentSourceId = names.get(copy.componentSourceId);
        if (copy.componentProperties)
          copy.componentProperties = Object.fromEntries(
            Object.entries(copy.componentProperties).map(([name, prop]) => [name, { ...prop, nodeId: names.get(prop.nodeId) ?? prop.nodeId }]),
          );
        if (node.id === root.id) {
          copy.x = operation.x ?? (node.x ?? 0) + 24;
          copy.y = operation.y ?? (node.y ?? 0) + 24;
        }
        result.nodes.push(copy);
      }
      continue;
    }
    if (operation.op === "unset") {
      const node = result.nodes.find((node) => node.id === operation.id);
      if (!node) throw Error(`Layer "${operation.id}" does not exist.`);
      const instance = designInstanceRoot(result, node.id);
      if (instance && (instance.id !== node.id || operation.fields.some((field) => !["parentId", "componentValues"].includes(field))))
        throw Error("Edit the main component or detach this instance.");
      for (const field of operation.fields) delete node[field];
      continue;
    }
    if (operation.op === "replace") {
      result = designDocumentSchema.parse({
        ...operation.document,
        ...(!operation.document.consistency && result.consistency ? { consistency: result.consistency } : {}),
      });
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
        (operation.op === "update" &&
          Object.keys(operation.patch).some((field) => !["x", "y", "parentId", "name", "hidden", "locked", "componentValues"].includes(field))))
    ) {
      throw Error("Edit the main component or detach this instance before changing its layers.");
    }
    if (operation.op === "update") {
      if (operation.patch.parentId && designInstanceRoot(result, operation.patch.parentId))
        throw Error("Edit the main component or detach this instance before moving layers into it.");
      const next = { ...result.nodes[index], ...operation.patch };
      if (
        !Object.hasOwn(operation.patch, "textStyle") &&
        ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"].some((field) => Object.hasOwn(operation.patch, field))
      )
        delete next.textStyle;
      if (next.bindings && !Object.hasOwn(operation.patch, "bindings")) {
        next.bindings = { ...next.bindings };
        for (const field of Object.keys(next.bindings)) if (Object.hasOwn(operation.patch, field)) delete next.bindings[field];
        if (!Object.keys(next.bindings).length) delete next.bindings;
      }
      result.nodes[index] = next;
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
  const resolved = validateDesignDocument(result);
  assertDesignEditIntent(before, resolved, intent);
  return resolved;
}

/** A color field as one CSS color in the default (light) mode; flatten a document with designDocumentForMode for another. */
export function designColor(document, value, fallback = "transparent") {
  return value === undefined ? fallback : (resolveDesignColor(document.tokens, value) ?? fallback);
}

export function designNodeAt(document, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > document.width || y > document.height) return null;
  const layout = designLayout(document);
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const contains = (box) => box && x >= box.x && y >= box.y && x <= box.x + box.width && y <= box.y + box.height;
  for (const [id, box] of [...layout].toReversed()) {
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
    if (!clipped) return designInstanceRoot(document, node.id, nodes) ?? node;
  }
  return null;
}

const escape = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

function nodeStyles(paint, node, box, parentBox, parentNode) {
  const background = ["text", "icon", "path"].includes(node.type) ? "transparent" : paint(node.fill, designDefaultFill(node));
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
    `border:${node.stroke && node.type !== "icon" && node.type !== "path" ? (node.strokeWidth ?? 1) : 0}px solid ${paint(node.stroke, "transparent")}`,
    "overflow:hidden",
    ...(node.type === "text"
      ? [
          `color:${paint(node.fill, designDefaultFill(node))}`,
          `font-size:${node.fontSize ?? 16}px`,
          `font-family:${designFontFamily(node.fontFamily, node.fontSize ?? 16)}`,
          `font-weight:${node.fontWeight ?? 400}`,
          `text-align:${node.textAlign ?? "left"}`,
          `line-height:${node.lineHeight ?? 1.35}`,
          ...(node.letterSpacing ? [`letter-spacing:${node.letterSpacing}px`] : []),
          "font-kerning:none",
          "font-variant-ligatures:none",
          'font-feature-settings:"calt" 0',
          "white-space:pre-wrap",
          "overflow-wrap:normal",
        ]
      : []),
  ].join(";");
}

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

function designMarkup(document, bounds, textLayout, take, paint = (value, fallback) => designColor(document, value, fallback)) {
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
        `<div data-design-node="${escape(node.id)}" aria-label="${escape(node.name ?? node.id)}" style="${escape(nodeStyles(paint, node, box, bounds.get(parentId), nodes.get(parentId)))}">`,
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
      } else if (node.type === "path") {
        const geometry = designPathGeometry(node, box);
        const strokeColor = node.stroke ?? (geometry.arc ? node.fill : undefined);
        const stroke = designPathStroked(node) ? ` stroke="${escape(paint(strokeColor, DESIGN_INK))}" ${designPathStrokeShape(node, geometry)}` : "";
        append(
          `<svg viewBox="${geometry.viewBox}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="${escape(geometry.d)}" fill="${geometry.arc ? "none" : escape(paint(node.fill, designDefaultFill(node)))}"${stroke}/></svg>`,
          node,
        );
      } else if (node.type === "icon") {
        const color = escape(paint(node.fill, designDefaultFill(node)));
        const symbol = designSymbolImage(node);
        const mask = symbol && `url(data:image/png;base64,${symbol.png}) center/contain no-repeat`;
        const lucide = designLucideIcon(node);
        append(
          symbol
            ? `<div aria-hidden="true" style="width:100%;height:100%;background:${color};-webkit-mask:${mask};mask:${mask}"></div>`
            : `<svg viewBox="0 0 24 24" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" fill="${lucide.filled ? color : "none"}" stroke="${color}" stroke-width="${lucide.strokeWidth}" stroke-linecap="round" stroke-linejoin="round" color="${color}" aria-hidden="true">${lucide.markup}</svg>`,
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

/** Colors that name tokens become CSS variables with one value per mode, so designHtmlForMode switches the saved page. */
function modePaint(document) {
  const modes = designModesOf(document);
  const literal = (value, fallback) => designColor(document, value, fallback);
  if (modes.length === 1) return { paint: literal, css: () => "" };
  const names = new Map();
  const paint = (value, fallback) => {
    if (value === undefined || !designColorReferences(value).length) return literal(value, fallback);
    if (!names.has(value)) names.set(value, `--c${names.size}`);
    return `var(${names.get(value)})`;
  };
  const css = () =>
    modes
      .map((mode) => {
        const values = [...names].map(([value, name]) => `${name}:${resolveDesignColor(document.tokens, value, mode) ?? "transparent"}`).join(";");
        return `${mode === "light" ? ":root" : `:root[data-design-mode="${mode}"]`}{${values}}`;
      })
      .join("");
  return { paint, css };
}

export function designHtml(value) {
  const document = validateDesignDocument(value);
  const textLayout = cachedTextLayout();
  const bounds = designLayout(document, textLayout);
  const fontFaces = designFontFaces(document);
  const take = designRenderBudget("HTML");
  const { paint, css } = modePaint(document);
  const background = escape(paint(document.background, "#ffffff"));
  const markup = designMarkup(document, bounds, textLayout, take, paint);
  return (
    take(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=${document.width}, initial-scale=1"><style>${css()}html,body{margin:0;padding:0;width:${document.width}px;height:${document.height}px;overflow:hidden}body{background:${background}}*{box-sizing:border-box}#design-root{position:relative;width:100%;height:100%}</style>${fontFaces ? `<style>${fontFaces}</style>` : ""}</head><body><main id="design-root">`,
    ) +
    markup +
    take("</main></body></html>")
  );
}

/**
 * A design as the parts designHtml puts in its page, for a page that swaps them in place as the design changes (the
 * canvas's live frame): the root's markup, the page's background, the font faces it uses and each layer's bounds.
 */
export function designLiveParts(value) {
  const document = validateDesignDocument(value);
  const textLayout = cachedTextLayout();
  const bounds = designLayout(document, textLayout);
  return {
    width: document.width,
    height: document.height,
    background: designColor(document, document.background, "#ffffff"),
    fontFaces: designFontFaces(document),
    markup: designMarkup(document, bounds, textLayout, designRenderBudget("HTML")),
    bounds,
  };
}

/**
 * embedFonts: false leaves Inter as a font-family reference, for callers that must stay small (a shared page of many designs).
 * onCanvasOnly: true leaves out layers wholly outside the screen, for the agent's rasterizer.
 * renderByteLimit: sharing uses Infinity; previews and exports keep the default render budget.
 * mode: the color mode to draw (light, dark or contrast); modes a token leaves out use light.
 */
export function designSvg(value, { embedFonts = true, onCanvasOnly = false, renderByteLimit, mode = "light" } = {}) {
  const document = designDocumentForMode(validateDesignDocument(value), mode);
  const textLayout = cachedTextLayout();
  return renderDesignSvg(
    document,
    designLayout(document, textLayout),
    textLayout,
    (value, fallback) => designColor(document, value, fallback),
    embedFonts ? designFontFaces(document) : "",
    { onCanvasOnly, renderByteLimit },
  );
}

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
        height: 29,
        heightMode: "hug",
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
