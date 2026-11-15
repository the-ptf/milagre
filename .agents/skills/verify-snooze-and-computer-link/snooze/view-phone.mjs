// The /statechart view for Snooze: the end-of-turn push to your phone.
const shown = (v) => (v.mark === "snooze" ? true : v.mark === "wake" ? false : v.seen);

function phone(v) {
  if (v.push === "done" || v.push === "fail") return "push about to go";
  if (v.push.endsWith("Sent")) return "pushed";
  if (v.push.endsWith("Dropped")) return "push dropped";
  return null;
}

export const title = "Snooze: the end-of-turn push to your phone";
export function state(v) {
  const list = shown(v) ? "Snoozed" : "In your list";
  const end = v.turn === "failed" ? "failed" : v.turn === "idle" && v.push !== "none" ? "finished" : "working";
  const p = phone(v);
  if (p === "pushed" || p === "push dropped") return `Turn ${end}, ${p}`;
  return end === "working" ? `${list}, working` : `${list}, turn ${end}`;
}
export const group = (v) => (shown(v) ? "snoozed" : "listed");
export const colors = { snoozed: "purple", listed: "teal" };

const STEPS = {
  YouSnooze: "you snooze",
  YouWake: null,
  YouSend: null,
  AgentFails: "the turn fails",
  AgentFinishes: "the turn finishes",
  HostWakes: "the computer wakes it",
  TimeComes: "the snooze time comes",
  SidebarRenders: "the sidebar redraws",
  MarkExpires: "a few seconds pass",
  HostReceivesSnooze: "the computer gets the snooze",
  HostSavesSnooze: "the computer saves the snooze",
  HostSavesWake: "the computer saves the wake",
  AgentAsks: "the agent asks you",
  YouAnswer: "you answer",
};
export function step(action, from, to) {
  if (action === "PhoneReads") return to.push.endsWith("Sent") ? "the push goes out" : "the push is dropped";
  return STEPS[action];
}
