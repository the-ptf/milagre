// Plain JavaScript: Node strips no types inside app.asar.

export const ESCALATION_WAIT_MS = 3 * 60_000;
export const ESCALATION_COOLDOWN_MS = 10 * 60_000;
/** Wakes a family gets until a human acts in it. */
export const ESCALATION_MAX_WAKES = 3;
/** Siblings firing this close share one wake. */
export const ESCALATION_BATCH_MS = 30_000;
/** Tool calls an escalation-only turn runs before it is told to reply. */
export const ESCALATION_TOOL_CALLS = 6;
/** Tool calls it may still try after that, before the host stops the turn. */
export const ESCALATION_TOOL_GRACE = 2;

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

export function waitingNote(context) {
  const waited = `Waiting ${minutes(context.waitedMs)} min.`;
  return context.ask === "approval" ? `${waited} Reminded you in ${context.parentTitle}.` : `${waited} Asked ${context.parentTitle} for help.`;
}

export function escalationLine(context) {
  const line = `${context.fromTitle} has been waiting on you for ${minutes(context.waitedMs)} min`;
  return context.paused ? `${line}, paused until you reply` : line;
}

/** Null when the user dismissed the suggestion. */
export function suggestionOutcomeLine(context) {
  if (context.outcome === "dismissed") return null;
  if (context.outcome === "cancelled") return "Cancelled";
  if (context.outcome === "sent") return `Sent "${context.label ?? ""}" to ${context.fromTitle}`;
  return context.label ? `Answered "${context.label}" in ${context.fromTitle}` : `Answered in ${context.fromTitle}`;
}

export function suggestionOutcomes(messages) {
  const outcomes = new Map();
  for (const message of messages) {
    const context = message.context;
    if (context?.kind === "subchat-suggestion-outcome" && context.id) outcomes.set(context.id, context);
  }
  return outcomes;
}

export function isSubchatWake(message) {
  return message?.context?.kind === "subchat-wake";
}

/** Nearest first; a chain that loops ends where it does. */
export function ancestorChats(sessions, sessionId) {
  const seen = new Set([sessionId]);
  const chain = [];
  for (let id = sessions?.[sessionId]?.parent; id !== undefined && !seen.has(id); id = sessions[id]?.parent) {
    seen.add(id);
    chain.push(id);
  }
  return chain;
}
