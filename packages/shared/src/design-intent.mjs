import { z } from "zod";
import { designLayout, designTextLayout } from "./design-layout.mjs";
import { designDiagnostics } from "./design-lint.mjs";
import { designError } from "./design-errors.mjs";

const ids = z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,95}$/)).max(100);
export const designEditIntentSchema = z
  .object({
    mode: z.enum(["text-only", "fit-text"]),
    textIds: ids.min(1),
    layoutIds: ids.optional(),
  })
  .strict()
  .describe(
    "text-only preserves all fields except text and all computed bounds. fit-text permits geometry within textIds and layoutIds subtrees, preserving styles and other copy. Layout must fit before saving. No automatic repair.",
  );

const geometry = new Set(["x", "y", "width", "height", "widthMode", "heightMode", "minWidth", "minHeight"]);
const stable = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
  );
const same = (a, b) => stable(a) === stable(b);
const fail = (message, path) => {
  throw Object.assign(designError(message, path), { code: "DESIGN_INTENT_VIOLATION" });
};
const layoutKinds = new Set(["clipped-text", "overflow", "off-canvas"]);

/** Check the resolved result, including component propagation and automatic layout, before any write. */
export function assertDesignEditIntent(before, after, value) {
  if (value === undefined) return;
  const intent = designEditIntentSchema.parse(value);
  const byId = new Map(before.nodes.map((node) => [node.id, node]));
  const textIds = new Set(intent.textIds);
  const layoutIds = new Set(intent.layoutIds ?? []);
  if (intent.mode === "text-only" && layoutIds.size)
    fail("text-only does not allow layoutIds. Use fit-text when layout changes are intended.", ["intent", "layoutIds"]);
  for (const id of textIds) if (byId.get(id)?.type !== "text") fail(`Text target "${id}" must be an existing text layer.`, ["intent", "textIds"]);
  for (const id of layoutIds) if (!byId.has(id)) fail(`Layout target "${id}" does not exist.`, ["intent", "layoutIds"]);
  const textAllowed = (node) => textIds.has(node.id) || (node.componentSourceId && textIds.has(node.componentSourceId));
  const layoutAllowed = (node) => {
    if (intent.mode !== "fit-text") return false;
    if (textAllowed(node)) return true;
    for (let current = node; current; current = byId.get(current.parentId)) if (layoutIds.has(current.id)) return true;
    return false;
  };
  const { nodes: oldNodes, ...oldMeta } = before;
  const { nodes: newNodes, ...newMeta } = after;
  if (!same(oldMeta, newMeta)) fail("Text intents preserve document size, kit, policy and tokens.", ["intent"]);
  if (
    !same(
      oldNodes.map((n) => n.id),
      newNodes.map((n) => n.id),
    )
  )
    fail("Text intents preserve layer ids and order; insertion, removal or detaching is outside this intent.", ["nodes"]);
  for (const [index, node] of newNodes.entries()) {
    const previous = byId.get(node.id);
    for (const field of new Set([...Object.keys(previous), ...Object.keys(node)])) {
      if (same(previous[field], node[field])) continue;
      if (field === "text" && textAllowed(previous)) continue;
      if (geometry.has(field) && layoutAllowed(previous)) continue;
      fail(`Intent ${intent.mode} preserves "${node.id}.${field}". Only declared text and permitted geometry may change.`, ["nodes", index, field]);
    }
  }
  const oldBounds = designLayout(before, designTextLayout);
  const newBounds = designLayout(after, designTextLayout);
  for (const node of oldNodes) {
    if (same(oldBounds.get(node.id), newBounds.get(node.id)) || layoutAllowed(node)) continue;
    fail(`Automatic layout moved or resized "${node.id}" outside the intent. Use fit-text with the affected layoutIds when authorized.`, [
      "intent",
      "layoutIds",
    ]);
  }
  if (intent.mode !== "fit-text") return;
  const affectedAncestors = new Set();
  for (const node of oldNodes.filter(textAllowed)) {
    for (let parent = byId.get(node.parentId); parent; parent = byId.get(parent.parentId)) affectedAncestors.add(parent.id);
  }
  const area = (a, b) =>
    a && b
      ? Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
      : 0;
  const texts = newNodes.filter((n) => n.type === "text");
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i],
        b = texts[j];
      if (a.parentId !== b.parentId || (!layoutAllowed(a) && !layoutAllowed(b))) continue;
      if (area(newBounds.get(a.id), newBounds.get(b.id)) > area(oldBounds.get(a.id), oldBounds.get(b.id)) + 1)
        fail(`fit-text creates or increases overlap between text layers "${a.id}" and "${b.id}". Adjust their geometry in the declared scope.`, [
          "intent",
          "layoutIds",
        ]);
    }
  const oldProblems = new Map(
    designDiagnostics(before)
      .warnings.filter((w) => layoutKinds.has(w.kind))
      .map((w) => [`${w.kind}:${w.id}`, w]),
  );
  // Existing defects elsewhere are not a reason to widen the edit. Defects in scope, or new/worse defects, reject it.
  const problems = designDiagnostics(after).warnings.filter((warning) => {
    if (!layoutKinds.has(warning.kind)) return false;
    const previous = oldProblems.get(`${warning.kind}:${warning.id}`);
    return affectedAncestors.has(warning.id) || layoutAllowed(byId.get(warning.id)) || !previous || !same(previous.measurements, warning.measurements);
  });
  if (problems.length) {
    const error = Object.assign(
      new Error(
        `fit-text still has layout problems: ${problems
          .slice(0, 3)
          .map((w) => w.message)
          .join(" ")}`,
      ),
      {
        code: "DESIGN_INTENT_VIOLATION",
        issues: problems.map((w) => ({ path: ["nodes", newNodes.findIndex((n) => n.id === w.id)], message: w.message })),
        diagnostics: designDiagnostics(after),
      },
    );
    throw error;
  }
}
