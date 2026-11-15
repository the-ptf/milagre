import { formatTokens } from "./tokens.mjs";

export const COMPACT_COMMAND = "/compact";

export function isCompaction(message) {
  return message?.context?.kind === "compaction";
}

export function compactionLabel(context) {
  const title = context.status === "preparing" ? "Compacting context" : context.status === "failed" ? "Compaction failed" : "Context compacted";
  const before = typeof context.before === "number" ? formatTokens(context.before) : null;
  const after = context.status === "done" && typeof context.after === "number" ? formatTokens(context.after) : null;
  return { title, before, after };
}

export function compactionText(context) {
  const { title, before, after } = compactionLabel(context);
  if (before && after) return `${title}: ${before} → ${after}`;
  if (before) return `${title}: ${before}`;
  return title;
}

export function compactionMessage(usage) {
  const known = usage && usage.size > 0 ? { before: usage.used, size: usage.size } : {};
  return { body: COMPACT_COMMAND, prompt: COMPACT_COMMAND, images: [], files: [], context: { kind: "compaction", status: "preparing", ...known } };
}

export function compactionContext(message) {
  return message?.context?.kind === "compaction" ? message.context : null;
}
