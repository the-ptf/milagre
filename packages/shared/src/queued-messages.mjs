/**
 * The line above a chat's queued messages (AgentSession.queued), the same on desktop and phone: when they go.
 * `held` is set once Stop or a failure ended the turn they waited on; `running` is whether a turn runs now.
 */
export function queueStatus({ count, held, running }) {
  if (held) return "on hold since the last turn stopped";
  if (running) return count === 1 ? "sends when this turn ends" : "each sends in its own turn, in order, after this one";
  return "starting next";
}
