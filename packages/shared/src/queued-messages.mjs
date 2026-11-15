/** `held` is set once Stop or a failure ended the turn the messages waited on; `running` is whether a turn runs now. */
export function queueStatus({ count, held, running }) {
  if (held) return "on hold since the last turn stopped";
  if (running) return count === 1 ? "sends when this turn ends" : "each sends in its own turn, in order, after this one";
  return "starting next";
}

export const FOLLOW_UP_OPTIONS = [
  {
    value: "now",
    label: "Send now",
    description: "Steers the running turn. Agents that can't steer get it when the turn ends.",
  },
  {
    value: "queue",
    label: "Queue",
    description: "Waits for the turn to end. Send now on a queued message sends it right away.",
  },
];

/** The delivery a composer send asks for while a turn runs: only Queue overrides the host's steer default. */
export function followUpDelivery(followUps) {
  return followUps === "queue" ? "queue" : undefined;
}
