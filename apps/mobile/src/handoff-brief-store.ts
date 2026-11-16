export interface Brief {
  title: string;
  text: string;
  subtitle?: string;
  openChat?: () => void;
}
let current: Brief = { title: "Handoff brief", text: "" };
export function showBrief(text: string, title = "Handoff brief", extra: Pick<Brief, "subtitle" | "openChat"> = {}) {
  current = { title, text, ...extra };
}
export function currentBrief() {
  return current;
}
