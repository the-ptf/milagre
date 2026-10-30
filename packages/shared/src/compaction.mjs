// Manual and automatic compactions share a divider, like a handoff, recording the context window around them.
import { formatTokens } from "./tokens.mjs";

/** What Claude is sent, and what the message keeps as its body. */
export const COMPACT_COMMAND = "/compact";

export function isCompaction(message) {
  return message?.context?.kind === "compaction";
}

/** The divider's words: its title by status, and the tokens before and after once known. */
export function compactionLabel(context) {
  const title = context.status === "preparing" ? "Compacting context" : context.status === "failed" ? "Compaction failed" : "Context compacted";
  const before = typeof context.before === "number" ? formatTokens(context.before) : null;
  const after = context.status === "done" && typeof context.after === "number" ? formatTokens(context.after) : null;
  return { title, before, after };
}

/** The divider as one line, for accessibility and the transcript. */
export function compactionText(context) {
  const { title, before, after } = compactionLabel(context);
  if (before && after) return `${title}: ${before} → ${after}`;
  if (before) return `${title}: ${before}`;
  return title;
}

/** The message (and its context) a compaction request starts with. The host fills `before` and `size` from the gauge. */
export function compactionMessage(usage) {
  const known = usage && usage.size > 0 ? { before: usage.used, size: usage.size } : {};
  return { body: COMPACT_COMMAND, prompt: COMPACT_COMMAND, images: [], files: [], context: { kind: "compaction", status: "preparing", ...known } };
}

export function compactionContext(message) {
  return message?.context?.kind === "compaction" ? message.context : null;
}
