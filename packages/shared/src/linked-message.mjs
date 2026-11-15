// The sender line over a message another Chat (or Milagre, for a Link) wrote, the same on desktop and phone.

const LINKED = new Set(["delegation", "delegation-report", "chat-message", "negotiation-agreement", "linked-notice"]);
const ENDED = { cancelled: "stopped", failed: "failed" };

/** The message's Link context when another Chat or a Link wrote it rather than the user or the agent, else null. */
export function linkedContext(message) {
  const context = message?.context;
  return typeof context === "object" && context !== null && LINKED.has(context.kind) ? context : null;
}

/** What the line says, and the Chat it opens (null when there is none to open). */
export function linkedHeading(context) {
  const round = context.negotiation ? ` · Negotiation round ${context.negotiation.round}` : "";
  switch (context.kind) {
    case "delegation":
      return { text: `Delegation from ${context.fromLabel}${round}`, chat: context.from };
    case "delegation-report":
      return {
        text: `Delegation report from ${context.fromLabel}${context.status === "done" ? "" : ` · ${ENDED[context.status]}`}${round}`,
        chat: context.from,
      };
    case "chat-message":
      return { text: `Message from ${context.fromLabel}`, chat: context.from };
    case "negotiation-agreement":
      return { text: `Negotiation agreement with ${context.with}`, chat: null };
    default:
      return { text: context.with ? `Negotiation with ${context.with}` : "Link", chat: null };
  }
}

/**
 * The one line a message another Chat sent stands for in the transcript ("Message from Fix login"), its text opening on a
 * tap, or null for one that keeps its full text: a report has its own line, and a Negotiation round is the conversation.
 * `name` is the sending Chat's title, `label` the whole "Project / branch / title".
 */
export function linkedLine(context) {
  if (!context || context.negotiation || (context.kind !== "chat-message" && context.kind !== "delegation")) return null;
  const label = context.fromLabel || "another Chat";
  return {
    verb: context.kind === "delegation" ? "Delegation from" : "Message from",
    name: label.split(" / ").at(-1) || label,
    label,
    chat: context.from ?? null,
  };
}
