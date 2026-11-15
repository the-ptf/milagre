const LINKED = new Set(["delegation", "delegation-report", "chat-message", "negotiation-agreement", "linked-notice"]);
const ENDED = { cancelled: "stopped", failed: "failed" };

export function linkedContext(message) {
  const context = message?.context;
  return typeof context === "object" && context !== null && LINKED.has(context.kind) ? context : null;
}

/** What the line says, and the Chat it opens (null when there is none). */
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
 * The one line a message another Chat sent stands for ("Message from Fix login"), or null for one that keeps its full
 * text: a report has its own line, and a Negotiation round is the conversation. `name` is the sending Chat's title,
 * `label` the whole "Project / branch / title".
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

const senderOf = (message) => {
  const line = message?.role === "user" ? linkedLine(linkedContext(message)) : null;
  return line ? { line, key: line.chat ?? `label:${line.label}` } : null;
};

/**
 * Folds a back-and-forth with one other Chat into one line ("2 messages with Roteirista"). `entries` are the
 * transcript's rows ({ message, hidden? }). With two or more of that Chat's messages in a run, the first row carries
 * `exchange` (the line, and every message of the run in order) and the rest are hidden, except the last reply. Returns
 * new rows; `entries` is left as it was.
 */
export function foldLinkedExchanges(entries) {
  const rows = entries.map((entry) => ({ ...entry }));
  for (let start = 0; start < rows.length; start += 1) {
    const first = rows[start];
    const sender = first.hidden ? null : senderOf(first.message);
    if (!sender) continue;
    const run = [start];
    let theirs = 1;
    for (let index = start + 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.hidden) continue;
      const next = senderOf(row.message);
      if (next?.key === sender.key) theirs += 1;
      else if (row.message.role !== "assistant" || row.message.context) break;
      run.push(index);
    }
    if (theirs < 2) continue;
    const lastIndex = run.at(-1);
    const keep = rows[lastIndex].message.role === "assistant" ? lastIndex : null;
    const items = run
      .map((index) => rows[index].message)
      .filter((message) => message.body?.trim())
      .map((message) => ({ from: message.role === "user" ? "them" : "us", message }));
    first.exchange = { line: sender.line, count: items.length, items };
    for (const index of run.slice(1)) if (index !== keep) rows[index].hidden = true;
    start = lastIndex;
  }
  return rows;
}

export function exchangeText(exchange) {
  return exchange.items.map(({ from, message }) => `**${from === "them" ? exchange.line.name : "This Chat"}**\n\n${message.body.trim()}`).join("\n\n---\n\n");
}
