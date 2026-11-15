/** What the brief sheet shows: a handoff brief, a Link's summary, or a message another Chat sent (with its sender). */
export interface Brief {
  title: string;
  text: string;
  /** A line under the title: who sent a Chat's message. */
  subtitle?: string;
  /** Opens the Chat that sent the message, after the sheet closes. */
  openChat?: () => void;
}
let current: Brief = { title: "Handoff brief", text: "" };
/** A brief (or a Link's summary) runs to a few hundred words, so the sheet reads it here instead of from route params. */
export function showBrief(text: string, title = "Handoff brief", extra: Pick<Brief, "subtitle" | "openChat"> = {}) {
  current = { title, text, ...extra };
}
export function currentBrief() {
  return current;
}
