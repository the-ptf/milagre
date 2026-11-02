/**
 * The line above a chat's queued messages (AgentSession.queued), the same on desktop and phone: when they go.
 * `held` is set once Stop or a failure ended the turn they waited on; `running` is whether a turn runs now.
 */
export function queueStatus({ count, held, running }) {
  if (held) return "on hold since the last turn stopped";
  if (running) return count === 1 ? "sends when this turn ends" : "each sends in its own turn, in order, after this one";
  return "starting next";
}

/** One composer choice on every provider; only the immediate action's effect differs. */
export const DEFAULT_MESSAGE_DELIVERY = "queue";
export function deliveryOptions(canSteer) {
  return [
    { value: "queue", label: "After this turn", description: "Keep this message in the queue until the current turn ends." },
    {
      value: "now",
      label: canSteer ? "Send now" : "Stop and send",
      description: canSteer ? "Send this message into the running turn." : "Stop the current turn and start this message next.",
    },
  ];
}
