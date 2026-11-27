const { canEditMessage, isMessageEdit } = require("@milagre/shared/message-edit");

// The Chat without the edited message and everything after it. A fallback edit also drops the divider its first try left.
function rewindChat(state, session, { messageId, fresh = false, replaces }) {
  const all = state.messages.filter((message) => message.session_id === session.id);
  const index = all.findIndex((message) => message.id === messageId);
  if (index === -1 || !canEditMessage(all[index])) throw new Error("That message can't be edited. Only your own typed messages can.");
  const dropped = all.slice(index);
  const before = all[index - 1];
  if (replaces != null && before?.id === replaces && isMessageEdit(before)) dropped.unshift(before);
  const gone = new Set(dropped.map((message) => message.id));
  const { native_sessions: _parked, suggestion: _suggestion, suggestionTurnId: _turn, ...kept } = session;
  const { native_session_id: _native, ...without } = kept;
  const next = fresh ? without : kept;
  return {
    state: { ...state, sessions: { ...state.sessions, [session.id]: next }, messages: state.messages.filter((message) => !gone.has(message.id)) },
    session: next,
    dropped,
  };
}

// How the provider rewinds to just before the edited message, or `fresh` for a new session given the conversation so far.
function rewindPlan(session, messages, messageId) {
  const all = messages.filter((message) => message.session_id === session.id);
  const index = all.findIndex((message) => message.id === messageId);
  const edited = all[index];
  const native = edited?.native;
  if (!session.native_session_id || !native || native.provider !== session.provider) return { fresh: true };
  const later = all.slice(index + 1).filter((message) => message.role === "user" && message.native);
  if (native.provider === "claude" && native.prompt)
    return { claude: { prompt: native.prompt, ...(!native.steered && !later.length ? { dropsTurn: true } : {}) } };
  if (native.provider === "codex" && native.turn) {
    const shared = all.slice(0, index).some((message) => message.native?.provider === "codex" && message.native.turn === native.turn);
    return shared ? { fresh: true } : { codex: { beforeTurnId: native.turn } };
  }
  return { fresh: true };
}

// What the provider told about the turn a message started or joined.
function nativeTurn(provider, result) {
  const steered = result?.steered ? { steered: true } : {};
  if (provider === "claude" && typeof result?.promptId === "string") return { provider, prompt: result.promptId, ...steered };
  if (provider === "codex" && typeof result?.turnId === "string") return { provider, turn: result.turnId, ...steered };
  return null;
}

module.exports = { rewindChat, rewindPlan, nativeTurn };
