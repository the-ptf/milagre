const { searchMessages } = require("@milagre/shared/message-search");

function chatPage(messages, chatId, { before, turns = 10, limit = 75 } = {}) {
  const chat = messages.filter((message) => message.session_id === chatId);
  let end = chat.length;
  if (before !== undefined && before !== null) {
    const at = chat.findIndex((message) => message.id === before);
    if (at >= 0) end = at;
  }
  let start = end;
  let seen = 0;
  while (start > 0 && end - start < limit) {
    start--;
    if (chat[start].role === "user" && ++seen >= turns) break;
  }
  return { messages: chat.slice(start, end), hasMore: start > 0, total: chat.length };
}

function chatSearch(state, query, { limit = 200 } = {}, all = state.messages) {
  const messages = all.filter((message) => state.sessions[message.session_id] && !state.sessions[message.session_id].archived);
  return searchMessages(messages, String(query ?? ""), limit).map(({ message, score, snippet, highlight, term }) => ({
    message: { id: message.id, session_id: message.session_id },
    score,
    snippet,
    highlight,
    term,
  }));
}

module.exports = { chatPage, chatSearch };
