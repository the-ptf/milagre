// The /statechart view for Snooze: what the desktop sidebar shows.
const shown = (v) => (v.mark === "snooze" ? true : v.mark === "wake" ? false : v.seen);
const waits = (v) => v.turn === "asking" || v.turn === "failed";

function where(v) {
  const here = shown(v);
  if (here && v.hostSnoozed) return "Snoozed";
  if (here) return "Snoozed in the sidebar only";
  return "In your list";
}

export const title = "Snooze: what the sidebar shows";
export const state = (v) => (waits(v) ? `${where(v)}, needs you` : where(v));
export const group = (v) => (shown(v) ? "snoozed" : "listed");
export const colors = { snoozed: "purple", listed: "teal" };

const STEPS = {
  YouSnooze: "you snooze",
  YouWake: null,
  YouSend: null,
  YouAnswer: null,
  HostReceivesSnooze: "the computer gets the snooze",
  HostSavesSnooze: "the computer saves the snooze",
  HostSavesWake: "the computer saves the wake",
  AgentAsks: "the agent asks you or fails",
  AgentFails: "the agent asks you or fails",
  AgentFinishes: "the turn finishes",
  HostWakes: "the computer wakes it",
  TimeComes: "the snooze time comes",
  SidebarRenders: "the sidebar redraws",
  MarkExpires: "a few seconds pass",
  PhoneReads: "the phone push is read",
};
export const step = (action) => STEPS[action];
