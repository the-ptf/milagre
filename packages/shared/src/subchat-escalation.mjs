// When a Subchat's question or approval goes unanswered, the host tells the Chat above it (subchat-escalation.cjs in core).
// Everything it posts is an ordinary note: the transcripts on desktop and phone read these contexts, and a suggestion's
// card and what became of it are two notes, so the card needs no state of its own and syncs like any message.
// Plain JavaScript, so the packaged host can load it: Node strips no types inside app.asar. Types: subchat-escalation.d.mts.

/** How long a request waits on the user before the host escalates it. */
export const ESCALATION_WAIT_MS = 3 * 60_000;
/** The least time between two wakes of a family's parent. */
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

/** The note above a waiting Subchat's question. */
export function waitingNote(context) {
  const waited = `Waiting ${minutes(context.waitedMs)} min.`;
  return context.ask === "approval" ? `${waited} Reminded you in ${context.parentTitle}.` : `${waited} Asked ${context.parentTitle} for help.`;
}

/** The parent's line for a waiting Subchat. */
export function escalationLine(context) {
  const line = `${context.fromTitle} has been waiting on you for ${minutes(context.waitedMs)} min`;
  return context.paused ? `${line}, paused until you reply` : line;
}

/** The line a resolved suggestion leaves, or null when it leaves none (the user dismissed it). */
export function suggestionOutcomeLine(context) {
  if (context.outcome === "dismissed") return null;
  if (context.outcome === "cancelled") return "Cancelled";
  if (context.outcome === "sent") return `Sent "${context.label ?? ""}" to ${context.fromTitle}`;
  return context.label ? `Answered "${context.label}" in ${context.fromTitle}` : `Answered in ${context.fromTitle}`;
}

/** What became of each suggestion in a transcript, by id: a card with an outcome shows that outcome, not its buttons. */
export function suggestionOutcomes(messages) {
  const outcomes = new Map();
  for (const message of messages) {
    const context = message.context;
    if (context?.kind === "subchat-suggestion-outcome" && context.id) outcomes.set(context.id, context);
  }
  return outcomes;
}

/** The message that starts a wake's turn: the agent reads the note, and the transcript draws nothing for it (the ↳ lines say it). */
export function isSubchatWake(message) {
  return message?.context?.kind === "subchat-wake";
}

/** The ids of the Chats above `sessionId` in a Project's sessions, the nearest first. A chain that loops ends where it does. */
export function ancestorChats(sessions, sessionId) {
  const seen = new Set([sessionId]);
  const chain = [];
  for (let id = sessions?.[sessionId]?.parent; id !== undefined && !seen.has(id); id = sessions[id]?.parent) {
    seen.add(id);
    chain.push(id);
  }
  return chain;
}
