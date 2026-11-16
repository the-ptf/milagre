const { chatKey } = require("@milagre/shared/agent-runs");
const { suggestionOutcomeLine } = require("@milagre/shared/subchat-escalation");

const keyOf = (chatId, requestId) => `${chatId}\n${requestId}`;
const withOpen = (session, entry) => ({ ...session, openSuggestions: [...(session.openSuggestions ?? []), entry] });
const withoutOpen = (session, id) => {
  const { openSuggestions = [], ...rest } = session;
  const left = openSuggestions.filter((entry) => entry.id !== id);
  return left.length ? { ...rest, openSuggestions: left } : rest;
};

class SubchatSuggestions {
  constructor({ post, id }) {
    Object.assign(this, { post, id });
    this.open = new Map();
    this.answering = new Map();
  }

  async suggest(chatId, { from, fromTitle, requestId, question, answerLabel, answers }) {
    for (const card of this.open.values())
      if (card.chatId === chatId && card.from === from && card.requestId === requestId) await this.dismiss(chatId, card.id);
    const id = this.id();
    this.open.set(id, { id, chatId, from, requestId, fromTitle, label: answerLabel });
    await this.post(
      chatId,
      {
        body: `Suggested for ${fromTitle}: ${answerLabel}`,
        context: { kind: "subchat-suggestion", id, from, fromTitle, requestId, question, answerLabel, answers },
      },
      (session) => withOpen(session, { id, fromTitle }),
    );
    return id;
  }

  hasCard(chatId, from, requestId) {
    return [...this.open.values()].some((card) => card.chatId === chatId && card.from === from && card.requestId === requestId);
  }

  async dismiss(chatId, id) {
    const card = this.open.get(id);
    if (card?.chatId !== chatId) return false;
    await this.close(card, "dismissed");
    return true;
  }

  async answered(chatId, details) {
    const card = this.open.get(await this.suggest(chatId, details));
    if (card) await this.close(card, "answered", details.answerLabel);
  }

  answer(chatId, requestId, details) {
    this.answering.set(keyOf(chatId, requestId), details);
  }

  unanswered(chatId, requestId) {
    this.answering.delete(keyOf(chatId, requestId));
  }

  async resolved(from, requestId, outcome) {
    const key = keyOf(from, requestId);
    const answer = this.answering.get(key);
    this.answering.delete(key);
    for (const card of this.open.values()) {
      if (card.from !== from || card.requestId !== requestId) continue;
      if (outcome !== "answered") await this.close(card, "cancelled");
      else if (answer?.suggestionId === card.id) await this.close(card, "sent", card.label);
      else await this.close(card, "answered", answer?.label);
    }
  }

  async close(card, outcome, label) {
    this.open.delete(card.id);
    const context = { kind: "subchat-suggestion-outcome", id: card.id, fromTitle: card.fromTitle, outcome, ...(label ? { label } : {}) };
    await this.post(card.chatId, { body: suggestionOutcomeLine(context) ?? "", context }, (session) => withoutOpen(session, card.id));
  }

  async closeStale(scope, sessions) {
    for (const session of Object.values(sessions)) {
      for (const { id, fromTitle } of session.openSuggestions ?? []) {
        if (this.open.has(id)) continue;
        await this.close({ id, chatId: chatKey(scope, session.id), fromTitle }, "cancelled");
      }
    }
  }
}

module.exports = { SubchatSuggestions };
