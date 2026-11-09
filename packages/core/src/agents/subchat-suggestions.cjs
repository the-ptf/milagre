const { chatKey } = require("@milagre/shared/agent-runs");
const { suggestionOutcomeLine } = require("@milagre/shared/subchat-escalation");

const keyOf = (chatId, requestId) => `${chatId}\n${requestId}`;
const withOpen = (session, entry) => ({ ...session, openSuggestions: [...(session.openSuggestions ?? []), entry] });
const withoutOpen = (session, id) => {
  const { openSuggestions = [], ...rest } = session;
  const left = openSuggestions.filter((entry) => entry.id !== id);
  return left.length ? { ...rest, openSuggestions: left } : rest;
};

// The cards an agent left for the user (chat_respond with suggest), and what became of each. A card and its outcome are
// two notes in the transcript (subchat-escalation.mjs), so this only follows the requests they point at. Requests are in
// memory, so a card's Chat keeps its open ids (`openSuggestions`): a restart closes them (`closeStale`), or a card would
// stay answerable for a question nobody is waiting on.
class SubchatSuggestions {
  /** `post(chatId, note, change)`: ChatHost.postNow. `id()` names a card. */
  constructor({ post, id }) {
    Object.assign(this, { post, id });
    // id -> { id, chatId (the card's Chat), from, requestId, fromTitle, label }
    this.open = new Map();
    // key of the request -> { label, suggestionId }: the answer on its way to the agent, until its question resolves.
    this.answering = new Map();
  }

  /** Posts a card in `chatId`. A newer card from the same Chat for the same request takes the place of the last. */
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

  /** Whether `chatId` has an open card for `from`'s request. */
  hasCard(chatId, from, requestId) {
    return [...this.open.values()].some((card) => card.chatId === chatId && card.from === from && card.requestId === requestId);
  }

  /** The user took the card away. The question stays open. Resolves false when it has no card to take. */
  async dismiss(chatId, id) {
    const card = this.open.get(id);
    if (card?.chatId !== chatId) return false;
    await this.close(card, "dismissed");
    return true;
  }

  /** An agent answered alone: the card it would have left, already closed, is the line saying what it answered. */
  async answered(chatId, details) {
    const card = this.open.get(await this.suggest(chatId, details));
    // Its request's end may have closed it already, with the same answer.
    if (card) await this.close(card, "answered", details.answerLabel);
  }

  /** An answer is on its way to `chatId`'s request: `label` is what it says, `suggestionId` the card that sent it. */
  answer(chatId, requestId, details) {
    this.answering.set(keyOf(chatId, requestId), details);
  }

  /** That answer never reached the agent. */
  unanswered(chatId, requestId) {
    this.answering.delete(keyOf(chatId, requestId));
  }

  /** A request ended, however it ended: each card for it says what really happened. */
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

  /** A Project opened: the cards it kept from an earlier run have no request behind them any more. */
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
