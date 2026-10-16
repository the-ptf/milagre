// A design as the agent writes it, and a finished change played back layer by layer: what the Designs canvas shows
// while an agent works on a design. Types: design-draft.d.mts.
import { applyDesignOperations, designIcons, designOperationSchema, validateDesignDocument } from "./design.mjs";

// --- The live frame ---

/**
 * The script of the frame a design builds in while an agent writes it (the desktop's LiveDesignFrame): it swaps the
 * design in place from the canvas's messages, fading in the layers that just appeared, so the frame never reloads.
 * Only the canvas (its parent) is listened to, and only for markup the shared renderer made. The frame is a srcdoc
 * iframe, which runs under the app's own CSP: the desktop pins this exact text by hash (apps/desktop/renderer-csp.mjs).
 */
export const DESIGN_LIVE_RECEIVER_SCRIPT = `(function(){
var root=document.getElementById("design-root"),fonts=document.getElementById("design-fonts"),still=matchMedia("(prefers-reduced-motion: reduce)");
addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||d.type!=="milagre:live-design"||typeof d.markup!=="string")return;
if(typeof d.fontFaces==="string")fonts.textContent=d.fontFaces;
if(typeof d.width==="number"&&typeof d.height==="number"){document.body.style.width=d.width+"px";document.body.style.height=d.height+"px"}
if(typeof d.background==="string")document.body.style.background=d.background;
root.innerHTML=d.markup;
if(!still.matches&&Array.isArray(d.appeared))d.appeared.slice(0,40).forEach(function(id){if(typeof id!=="string")return;var el=root.querySelector('[data-design-node="'+CSS.escape(id)+'"]');if(el&&el.animate)el.animate([{opacity:0,transform:"scale(.97)"},{opacity:1,transform:"none"}],{duration:260,easing:"cubic-bezier(.2,.8,.2,1)"})});
parent.postMessage({type:"milagre:live-painted",seq:d.seq},"*")})})()`;

// --- Partial JSON ---

class Malformed extends Error {}

/**
 * Reads the start of a JSON text the model is still writing. Objects keep the members whose values are whole, and the
 * one still being written when it is an object or an array (itself partial); arrays keep only their whole items; a
 * string, number or literal cut off at the end is left out. Undefined for text that is not the start of JSON.
 */
export function parsePartialJson(text) {
  let at = 0;
  const space = () => {
    while (at < text.length && (text[at] === " " || text[at] === "\n" || text[at] === "\r" || text[at] === "\t")) at++;
  };
  // { value, done }: done is false when the text ends inside the value (value is then a partial container, or undefined).
  const value = () => {
    space();
    if (at >= text.length) return { value: undefined, done: false };
    const character = text[at];
    if (character === "{") return object();
    if (character === "[") return array();
    if (character === '"') return string();
    return literal();
  };
  const object = () => {
    at++;
    const result = {};
    for (let first = true; ; first = false) {
      space();
      if (at >= text.length) return { value: result, done: false };
      if (text[at] === "}") {
        at++;
        return { value: result, done: true };
      }
      if (!first) {
        if (text[at] !== ",") throw new Malformed();
        at++;
        space();
        if (at >= text.length) return { value: result, done: false };
      }
      if (text[at] !== '"') throw new Malformed();
      const key = string();
      if (!key.done) return { value: result, done: false };
      space();
      if (at >= text.length) return { value: result, done: false };
      if (text[at] !== ":") throw new Malformed();
      at++;
      const member = value();
      if (member.done || (member.value !== null && typeof member.value === "object")) result[key.value] = member.value;
      if (!member.done) return { value: result, done: false };
    }
  };
  const array = () => {
    at++;
    const result = [];
    for (let first = true; ; first = false) {
      space();
      if (at >= text.length) return { value: result, done: false };
      if (text[at] === "]") {
        at++;
        return { value: result, done: true };
      }
      if (!first) {
        if (text[at] !== ",") throw new Malformed();
        at++;
      }
      const item = value();
      if (!item.done) return { value: result, done: false };
      result.push(item.value);
    }
  };
  const string = () => {
    const start = at;
    at++;
    while (at < text.length) {
      if (text[at] === "\\") at += 2;
      else if (text[at] === '"') {
        at++;
        return { value: JSON.parse(text.slice(start, at)), done: true };
      } else at++;
    }
    at = text.length;
    return { value: undefined, done: false };
  };
  const literal = () => {
    const start = at;
    while (at < text.length && /[-+0-9.eEa-z]/.test(text[at])) at++;
    if (at === start) throw new Malformed();
    // A number or literal at the very end may go on.
    if (at >= text.length) return { value: undefined, done: false };
    return { value: JSON.parse(text.slice(start, at)), done: true };
  };
  try {
    return value().value;
  } catch (error) {
    if (error instanceof Malformed || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// --- Drafts ---

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const screenSize = (value) => (Number.isInteger(value) && value >= 240 && value <= 3840 ? value : undefined);

/** A layer that renders on its own, or null: a layer the document would refuse is left out of the draft. */
function draftNode(node, tokens) {
  if (!designOperationSchema.safeParse({ op: "insert", node }).success) return null;
  if (
    node.type === "icon"
      ? !Object.hasOwn(designIcons, node.icon ?? "") || ["stroke", "radius", "text", "src"].some((field) => node[field] !== undefined)
      : node.icon !== undefined
  )
    return null;
  // A color token the draft hasn't defined (yet) paints the default.
  const missing = (color) => typeof color === "string" && color.startsWith("$") && !Object.hasOwn(tokens, color.slice(1));
  if (!missing(node.fill) && !missing(node.stroke)) return node;
  const { fill, stroke, ...rest } = node;
  return { ...rest, ...(missing(fill) ? {} : { fill }), ...(missing(stroke) ? {} : { stroke }) };
}

/** The layers that render: whole, valid, and inside a frame that is there too. Order is kept. */
function draftNodes(candidates) {
  const byId = new Map();
  for (const node of candidates) if (node && !byId.has(node.id)) byId.set(node.id, node);
  const placed = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const node of byId.values()) {
      if (placed.has(node.id)) continue;
      const parent = node.parentId === undefined ? null : byId.get(node.parentId);
      if (node.parentId !== undefined && (!parent || parent.type !== "frame" || !placed.has(parent.id))) continue;
      placed.add(node.id);
      changed = true;
    }
  }
  return [...byId.values()].filter((node) => placed.has(node.id));
}

/** The document, or the longest start of its layers that validates; null when not even the empty screen does. */
function validStart(document) {
  for (let count = document.nodes.length, tries = 0; count >= 0 && tries < 8; count--, tries++) {
    try {
      return validateDesignDocument({ ...document, nodes: document.nodes.slice(0, count) });
    } catch {
      // A later layer may be what breaks it.
    }
  }
  try {
    return validateDesignDocument({ ...document, nodes: [] });
  } catch {
    return null;
  }
}

/**
 * Follows one design tool call while its input streams in (`tool` is design_show or design_apply). `read(input, base)`
 * takes the input so far and, for design_apply or a design_show of an existing design, the document it starts from;
 * it returns what to show, reusing its work on the layers it already read.
 */
export function createDesignDraft(tool) {
  let last = null;
  // design_show: the whole layers read so far, each checked once.
  let shown = { key: "", nodes: [] };
  // design_apply: the operations applied so far to the base.
  let applied = { base: null, count: 0, document: null };
  // `touched`: ids in the order the agent touched them (design_apply's operations), which the changes follow.
  const snapshot = (fields, document, touched = []) => {
    const changes =
      document && last?.document ? designChanges(last.document, document) : { changed: document ? document.nodes.map((node) => node.id) : [], removed: [] };
    if (touched.length) {
      const changed = new Set(changes.changed);
      changes.changed = [...new Set([...touched.filter((id) => changed.has(id)), ...changes.changed])];
    }
    const same =
      document === last?.document || (!changes.changed.length && !changes.removed.length && document && last?.document && sameScreen(document, last.document));
    last = { ...fields, document: same ? (last?.document ?? null) : document, changed: same ? [] : changes.changed };
    return last;
  };
  return {
    read(input, base = null) {
      const value = parsePartialJson(input);
      const fields = {
        designId: typeof value?.id === "string" && value.id ? value.id : null,
        title: typeof value?.title === "string" ? value.title : null,
        group: typeof value?.group === "string" ? value.group : null,
      };
      if (!isObject(value)) return snapshot(fields, last?.document ?? null);
      if (tool === "design_apply") {
        if (!base) return snapshot(fields, null);
        // The base is what the frame shows already: only what the operations change counts as changed, so the
        // design doesn't build again from nothing when the base arrives.
        if (applied.base !== base) {
          applied = { base, count: 0, document: base };
          last = { ...fields, document: base, changed: [] };
        }
        const operations = Array.isArray(value.operations) ? value.operations : [];
        let touched = [];
        if (operations.length > applied.count) {
          const fresh = operations.slice(applied.count);
          touched = fresh.map((operation) => (operation?.op === "insert" ? operation.node?.id : operation?.id)).filter((id) => typeof id === "string");
          let document = applied.document;
          try {
            document = applyDesignOperations(document, fresh);
          } catch {
            // One at a time, leaving out an operation the design would refuse.
            for (const operation of fresh) {
              try {
                document = applyDesignOperations(document, [operation]);
              } catch {
                // Skipped.
              }
            }
          }
          applied = { base, count: operations.length, document };
        }
        return snapshot(fields, applied.document, touched);
      }
      const draft = isObject(value.document) ? value.document : {};
      const width = screenSize(draft.width) ?? base?.width;
      const height = screenSize(draft.height) ?? base?.height;
      if (!width || !height) return snapshot(fields, null);
      const tokens = isObject(draft.tokens) ? Object.fromEntries(Object.entries(draft.tokens).filter(([, color]) => typeof color === "string")) : {};
      const background =
        typeof draft.background === "string" && (!draft.background.startsWith("$") || Object.hasOwn(tokens, draft.background.slice(1)))
          ? draft.background
          : undefined;
      const items = Array.isArray(draft.nodes) ? draft.nodes : [];
      const key = JSON.stringify(tokens);
      if (shown.key !== key) shown = { key, nodes: [] };
      for (let index = shown.nodes.length; index < items.length; index++) shown.nodes.push(isObject(items[index]) ? draftNode(items[index], tokens) : null);
      const document = validStart({
        schemaVersion: 1,
        width,
        height,
        ...(background ? { background } : {}),
        ...(Object.keys(tokens).length ? { tokens } : {}),
        nodes: draftNodes(shown.nodes),
      });
      return snapshot(fields, document ?? last?.document ?? null);
    },
  };
}

const sameScreen = (a, b) =>
  a.width === b.width && a.height === b.height && a.background === b.background && JSON.stringify(a.tokens ?? {}) === JSON.stringify(b.tokens ?? {});

// --- Changes and replay ---

/** The layers `after` adds or changes, in its order, and the ids it no longer has. */
export function designChanges(before, after) {
  const old = new Map(before.nodes.map((node) => [node.id, node]));
  const ids = new Set(after.nodes.map((node) => node.id));
  return {
    changed: after.nodes.filter((node) => !old.has(node.id) || JSON.stringify(old.get(node.id)) !== JSON.stringify(node)).map((node) => node.id),
    removed: before.nodes.filter((node) => !ids.has(node.id)).map((node) => node.id),
  };
}

/** Ids in reading order: each frame before its children, siblings back to front. */
function treeOrder(document) {
  const children = new Map();
  for (const node of document.nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node.id);
    children.set(node.parentId, list);
  }
  const order = [];
  const visit = (parentId, depth) => {
    if (depth > 32) return;
    for (const id of children.get(parentId) ?? []) {
      order.push(id);
      visit(id, depth + 1);
    }
  };
  visit(undefined, 0);
  return order;
}

/**
 * A change from `before` to `after` as steps to show one after the other, at most `maxSteps`: each step's document
 * and the layers it changed. Layers come in reading order, frames before what they hold; removed layers go with the
 * first step. The last step is `after`. Empty when nothing changed.
 */
export function designReplay(before, after, maxSteps = 14) {
  const { changed, removed } = designChanges(before, after);
  if (!changed.length && !removed.length && sameScreen(before, after)) return [];
  const old = new Map(before.nodes.map((node) => [node.id, node]));
  const pending = new Set(changed);
  const ordered = treeOrder(after).filter((id) => pending.has(id));
  for (const id of changed) if (!ordered.includes(id)) ordered.push(id);
  const count = Math.max(1, Math.min(maxSteps, ordered.length));
  const groups = Array.from({ length: count }, (_, index) =>
    ordered.slice(Math.floor((index * ordered.length) / count), Math.floor(((index + 1) * ordered.length) / count)),
  );
  const steps = [];
  const done = new Set();
  let waiting = [];
  for (const group of groups) {
    for (const id of group) done.add(id);
    waiting.push(...group);
    const nodes = after.nodes.flatMap((node) => (!pending.has(node.id) || done.has(node.id) ? [node] : old.has(node.id) ? [old.get(node.id)] : []));
    try {
      steps.push({ document: validateDesignDocument({ ...after, nodes }), changed: waiting });
      waiting = [];
    } catch {
      // A step the design would refuse (a layer moved into a frame not there yet) joins the next one.
    }
  }
  if (!steps.length || waiting.length) steps.push({ document: after, changed: waiting.length ? waiting : ordered.slice(-1) });
  return steps;
}
