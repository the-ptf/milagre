const count = (value, one, many) => `${value} ${value === 1 ? one : many}`;

// The user's own typed message: not a card, an answer, a message from another Chat or a queued one.
export function canEditMessage(message) {
  return Boolean(message) && message.role === "user" && !message.context && !message.answered?.length && Number.isSafeInteger(message.id) && message.id > 0;
}

// What editing a message removes: everything after it in its Chat, dividers left out of the count.
export function messagesAfter(messages, id) {
  const index = messages.findIndex((message) => message.id === id);
  if (index === -1) return 0;
  return messages.slice(index + 1).filter((message) => !(message.role === "assistant" && message.context)).length;
}

export function editingText(removed) {
  return removed ? `the ${count(removed, "message", "messages")} after it will be removed` : "nothing after it is removed";
}

export function messageEditText(context) {
  return [
    "Edited",
    context.removed ? `removed ${count(context.removed, "message", "messages")}` : null,
    context.restored ? `undid ${count(context.restored, "file", "files")}` : null,
    context.newSession ? "new session" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function isMessageEdit(message) {
  return message?.context?.kind === "message-edit";
}
