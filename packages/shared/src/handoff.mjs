export function isHandoff(message) {
  return message?.context?.kind === "handoff";
}

const chatMessages = (state, sessionId) => state.messages.filter((message) => message.session_id === sessionId);

const isEffective = (message) => isHandoff(message) && message.context.status !== "failed";

export function lastTurnProvider(state, sessionId) {
  const messages = chatMessages(state, sessionId);
  if (!messages.length) return undefined;
  const divider = messages.findLast(isEffective);
  return divider ? divider.context.to.provider : state.sessions[sessionId]?.provider;
}

/**
 * The id of the divider after which `provider` needs catching up, or null for the whole chat. A provider resumes
 * only with a parked session id; it last read up to the divider that switched away from it.
 */
export function catchUpStart(state, sessionId, provider) {
  if (!state.sessions[sessionId]?.native_sessions?.[provider]) return null;
  return chatMessages(state, sessionId).findLast((message) => isEffective(message) && message.context.from.provider === provider)?.id ?? null;
}

/**
 * What a send on `provider` needs first: "switch" when the provider changes, "restore" when a chat that has a
 * completed reply lost its native session (a failed resume), else null.
 */
export function handoffKind(state, sessionId, provider) {
  const last = lastTurnProvider(state, sessionId);
  if (!last) return null;
  if (last !== provider) return "switch";
  const session = state.sessions[sessionId];
  const replied = chatMessages(state, sessionId).some((message) => message.role === "assistant" && message.outcome === "completed");
  return replied && !session?.native_session_id ? "restore" : null;
}
