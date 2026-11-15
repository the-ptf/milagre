// The /statechart view for ComputerLink: what Settings shows, and where the connection is.
const where = (v) => {
  if (v.link === "up") return v.via === "lan" ? "on the LAN" : "on the relay";
  if (v.link === "dead") return "channel closed, no reconnect";
  if (["opening", "lastCall"].includes(v.link)) return "first calls";
  if (["dialing", "hello"].includes(v.link)) return "dialing";
  if (v.link === "stopped") return "stopped";
  return "waiting to redial";
};
const words = { connecting: "Connecting", online: "Online", reconnecting: "Reconnecting", offline: "Offline", refused: "Refused", off: "Off" };

export const title = "A paired computer: what Settings shows";
export function state(v) {
  const label = words[v.shown];
  if (v.shown === "online" && v.recovery) return "Online, moving to the LAN";
  if (v.shown === "online") return `Online, ${where(v)}`;
  if (v.link === "stopped" || v.shown === "connecting") return label;
  return `${label}, ${where(v) === "waiting to redial" ? "waiting" : "trying"}`;
}
export const group = (v) => (v.shown === "online" ? "online" : ["reconnecting", "connecting"].includes(v.shown) ? "coming" : "gone");
export const colors = { online: "teal", coming: "orange", gone: "purple" };

const STEPS = {
  ChooseRoute: "it dials",
  RelayAnswers: "the relay answers",
  RelaySaysOffline: "the relay says offline",
  RelayTurnsAway: "the computer turns this one away",
  RecoveryGoesOn: null,
  Opens: "the first calls finish",
  SwitchClosesEarly: "the move to the LAN closes the relay",
  SwitchClosesLast: "the move to the LAN closes the relay on the last first call",
  LanOpens: "a LAN channel opens",
  LanGoes: null,
  ReplyArrives: "a reply arrives",
  ChannelDrops: "the connection drops",
  ReconnectTimerFires: "the redial timer fires",
  BackoffEnds: "the redial timer fires",
  OfflineTimerFires: "30 seconds pass",
  PeerSleeps: null,
  PeerWakes: null,
  PeerTurnsAway: null,
  YouTurnOff: "you turn it off",
  YouCall: null,
  CallSwitchWaitRunsOut: null,
  CallWaitRunsOut: null,
  Done: null,
};
export const step = (action) => STEPS[action];
