import { validateDesignDocument, type DesignDocument, type DesignNode } from "@milagre/shared/design";
import { ipcErrorMessage } from "@milagre/shared/result";

export type DesignConflictField = { key: string; label: string; mine: unknown; latest: unknown };
export type DesignConflictChoices = Record<string, "mine" | "latest">;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const instanceFields = new Set(["x", "y", "parentId", "name", "hidden", "locked"]);
const structure = (document: DesignDocument) =>
  document.nodes.map(({ id, type, parentId, component, componentId, componentSourceId }) => ({
    id,
    type,
    parentId,
    component,
    componentId,
    componentSourceId,
  }));

/** Field merges require unchanged layer structure; structural replacements always need a separate review. */
export function rebaseDesign(base: DesignDocument, mine: DesignDocument, latest: DesignDocument, choices: DesignConflictChoices = {}) {
  const structural = !equal(structure(base), structure(mine)) || !equal(structure(base), structure(latest));
  const conflicts: DesignConflictField[] = [];
  if (structural) return { structural, conflicts, document: null, error: "" };
  const merge = (before: object, local: object, remote: object, path: string[], label: string, allowed?: Set<string>) => {
    const a = before as Record<string, unknown>,
      b = local as Record<string, unknown>,
      c = remote as Record<string, unknown>;
    const result = { ...c };
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (allowed && !allowed.has(field)) continue;
      if (equal(a[field], b[field])) continue;
      const key = JSON.stringify([...path, field]);
      if (!equal(a[field], c[field]) && !equal(b[field], c[field])) {
        conflicts.push({ key, label: `${label} · ${field}`, mine: b[field], latest: c[field] });
        if (choices[key] !== "mine") continue;
      }
      if (b[field] === undefined) delete result[field];
      else result[field] = b[field];
    }
    return result;
  };
  const { nodes: baseNodes, tokens: baseTokens, ...baseMeta } = base;
  const { nodes: mineNodes, tokens: mineTokens, ...mineMeta } = mine;
  const { nodes: latestNodes, tokens: latestTokens, ...latestMeta } = latest;
  const metadata = merge(baseMeta, mineMeta, latestMeta, ["screen"], "Screen");
  const tokens = merge(baseTokens ?? {}, mineTokens ?? {}, latestTokens ?? {}, ["token"], "Color token");
  const nodes = latestNodes.map((node, index) => {
    // Linked content is derived from its main component. Only placement and independent instance flags can merge.
    if (node.componentSourceId) return node;
    return merge(
      baseNodes[index]!,
      mineNodes[index]!,
      node,
      ["node", node.id],
      node.name ?? node.id,
      node.componentId ? instanceFields : undefined,
    ) as unknown as DesignNode;
  });
  try {
    const document = validateDesignDocument({ ...metadata, ...(Object.keys(tokens).length ? { tokens } : {}), nodes });
    return { structural, conflicts, document, error: "" };
  } catch (cause) {
    return { structural, conflicts, document: null, error: cause instanceof Error ? cause.message : "These changes cannot be combined." };
  }
}

/** The structural review names every latest change a full-draft replacement would discard. */
export function describeDesignChanges(base: DesignDocument, latest: DesignDocument): string[] {
  const changes: string[] = [];
  const a = new Map(base.nodes.map((node) => [node.id, node]));
  const b = new Map(latest.nodes.map((node) => [node.id, node]));
  for (const node of base.nodes) if (!b.has(node.id)) changes.push(`Deleted layer: ${node.name ?? node.id}`);
  for (const node of latest.nodes) {
    const before = a.get(node.id);
    if (!before) changes.push(`Added layer: ${node.name ?? node.id}`);
    else
      for (const key of new Set([...Object.keys(before), ...Object.keys(node)])) {
        if (!equal(before[key as keyof DesignNode], node[key as keyof DesignNode]))
          changes.push(`${node.name ?? node.id} · ${key}: ${designConflictValue(node[key as keyof DesignNode])}`);
      }
  }
  if (
    !equal(
      base.nodes.map((node) => node.id),
      latest.nodes.map((node) => node.id),
    )
  )
    changes.push("Layer order changed.");
  for (const key of ["width", "height", "background", "tokens"] as const)
    if (!equal(base[key], latest[key])) changes.push(`Screen · ${key}: ${designConflictValue(latest[key])}`);
  return changes;
}

export const designConflictValue = (value: unknown): string => (value === undefined ? "Not set" : typeof value === "string" ? value : JSON.stringify(value));
export function isDesignVersionConflict(message: string): boolean {
  return ipcErrorMessage(message).startsWith("Design version conflict:");
}
