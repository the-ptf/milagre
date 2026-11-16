const { randomUUID } = require("node:crypto");
const { chatKey, isTurnEnd, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { attentionContext, attentionTitle } = require("@milagre/shared/attention");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const {
  ESCALATION_BATCH_MS,
  ESCALATION_COOLDOWN_MS,
  ESCALATION_MAX_WAKES,
  ESCALATION_WAIT_MS,
  ancestorChats,
  escalationLine,
  waitingNote,
} = require("@milagre/shared/subchat-escalation");
const { isSecretRequest } = require("../chat-secrets.cjs");
const { ESCALATION_LEVEL, canEscalate, owesTurn } = require("../escalation-guard.cjs");
const { SubchatSuggestions } = require("./subchat-suggestions.cjs");
const { wakeBody, wakePrompt } = require("./subchat-wake.cjs");

const TICK_MS = 5000;
const SLEPT_MS = 30_000;

const keyOf = (chatId, requestId) => `${chatId}\n${requestId}`;
const listed = (session) => Boolean(session) && !session.archived;

class SubchatEscalation {
  constructor({ ports, now = Date.now, id = randomUUID, every = setInterval, cancel = clearInterval }) {
    Object.assign(this, { ports, now, every, cancel });
    this.suggestions = new SubchatSuggestions({ post: ports.post, id });
    this.requests = new Map();
    this.wakes = new Map();
    this.families = new Map();
    this.stopped = new Set();
    this.timer = null;
    this.closed = false;
  }

  observe(chatId, event) {
    if (this.closed || isLinkScopeKey(projectOfKey(chatId))) return;
    if (event.type === "turn-started") this.stopped.delete(chatId);
    if (event.type === "permission-request" || event.type === "question-request") this.track(chatId, event);
    else if (event.type === "permission-resolved") this.resolved(chatId, event.requestId, event.decision === "cancelled" ? "cancelled" : "answered");
    else if (event.type === "question-resolved") this.resolved(chatId, event.requestId, event.outcome);
    else if (isTurnEnd(event)) {
      for (const request of this.requests.values()) if (request.chatId === chatId) this.resolved(chatId, request.requestId, "cancelled");
      if (event.type === "turn-cancelled" && !event.quit) this.stopped.add(chatId);
    }
  }

  track(chatId, event) {
    const key = keyOf(chatId, event.requestId);
    if (this.requests.has(key)) return;
    const at = this.now();
    this.requests.set(key, {
      key,
      chatId,
      requestId: event.requestId,
      question: event.type === "question-request",
      secret: isSecretRequest(event.requestId) || Boolean(event.questions?.some((question) => question.secret)),
      questions: event.questions ?? [],
      startedAt: at,
      dueAt: at + ESCALATION_WAIT_MS,
      deferred: false,
      fired: false,
      noWake: this.ports.isWakeTurn(chatId),
      family: null,
    });
    this.start();
  }

  resolved(chatId, requestId, outcome) {
    const key = keyOf(chatId, requestId);
    this.requests.delete(key);
    for (const [parent, wake] of this.wakes) {
      wake.requests.delete(key);
      if (!wake.requests.size) this.wakes.delete(parent);
    }
    void this.suggestions.resolved(chatId, requestId, outcome).catch((error) => console.warn("Milagre couldn't close a suggestion:", error.message));
  }

  start() {
    if (this.timer || this.closed) return;
    this.lastTick = this.now();
    this.timer = this.every(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  tick() {
    const at = this.now();
    const slept = at - this.lastTick > SLEPT_MS ? at - this.lastTick : 0;
    this.lastTick = at;
    for (const request of this.requests.values()) {
      if (request.fired) this.lookedAt(request);
      else if (slept) request.dueAt = request.dueAt <= at ? at + ESCALATION_WAIT_MS : request.dueAt + slept;
      else if (request.dueAt <= at) this.due(request, at);
    }
    for (const wake of this.wakes.values()) void this.attempt(wake).catch((error) => console.warn("Milagre couldn't wake a Chat:", error.message));
    if (this.timer && !this.requests.size && !this.wakes.size) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }

  lookedAt(request) {
    if (request.family && this.ports.isSeen(request.chatId)) this.family(request.family).wakes = 0;
  }

  due(request, at) {
    if (!request.deferred && this.ports.isSeen(request.chatId)) {
      Object.assign(request, { deferred: true, dueAt: at + ESCALATION_WAIT_MS });
      return;
    }
    request.fired = true;
    void this.fire(request).catch((error) => console.warn("Milagre couldn't escalate a request:", error.message));
  }

  family(root) {
    if (!this.families.has(root)) this.families.set(root, { wakes: 0, last: null });
    return this.families.get(root);
  }

  async humanActed(chatId) {
    const scope = projectOfKey(chatId);
    if (isLinkScopeKey(scope)) return;
    const { sessions } = await this.ports.read(scope, []);
    this.family(chatKey(scope, ancestorChats(sessions, sessionIdFromKey(chatId)).at(-1) ?? sessionIdFromKey(chatId))).wakes = 0;
  }

  async suggest(chatId, details) {
    const id = await this.suggestions.suggest(chatId, details);
    if (!this.requests.has(keyOf(details.from, details.requestId))) await this.suggestions.resolved(details.from, details.requestId, "cancelled");
    return id;
  }

  answering(chatId, requestId, { label, suggestionId, sender = null }) {
    this.suggestions.answer(chatId, requestId, { label, suggestionId });
    const carded = sender && this.suggestions.hasCard(sender.agent, chatId, requestId);
    return {
      failed: () => this.suggestions.unanswered(chatId, requestId),
      accepted: () => (sender ? this.answeredBy(sender, chatId, requestId, carded) : this.humanActed(chatId)),
    };
  }

  async answeredBy({ agent, question, answerLabel, answers }, chatId, requestId, carded) {
    const scope = projectOfKey(chatId);
    const id = sessionIdFromKey(chatId);
    const state = await this.ports.read(scope, [id, sessionIdFromKey(agent)]);
    const parentTitle = attentionContext(state, "", sessionIdFromKey(agent)).chatTitle;
    await this.ports.post(chatId, { body: `Answered by ${parentTitle}`, context: { kind: "subchat-answered-by", parentTitle, label: answerLabel } });
    const fromTitle = attentionContext(state, "", id).chatTitle;
    if (!carded) await this.suggestions.answered(agent, { from: chatId, fromTitle, requestId, question, answerLabel, answers });
  }

  refuses(parent, session) {
    return (
      !listed(session) ||
      !canEscalate(session.provider ?? "claude") ||
      this.ports.run(parent)?.questions?.length > 0 ||
      this.stopped.has(parent) ||
      Boolean(session.queueHeld)
    );
  }

  spent(root, parent) {
    const queued = [...this.wakes.values()].filter((wake) => wake.family === root && wake.parent !== parent).length;
    return this.family(root).wakes + queued >= ESCALATION_MAX_WAKES;
  }

  async fire(request) {
    const { chatId } = request;
    const scope = projectOfKey(chatId);
    const id = sessionIdFromKey(chatId);
    const above = ancestorChats((await this.ports.read(scope, [])).sessions, id);
    const state = await this.ports.read(scope, [id, ...above]);
    const nearest = above.find((at) => listed(state.sessions[at]));
    if (nearest === undefined || !listed(state.sessions[id]) || this.requests.get(request.key) !== request) return;
    const parent = chatKey(scope, nearest);
    request.family = chatKey(scope, above.at(-1));
    const { chatTitle: fromTitle, parentTitle } = attentionContext(state, "", id);
    const waitedMs = this.now() - request.startedAt;
    const asks = request.question && !request.secret && !request.noWake && nearest === above[0];
    const paused = asks && this.spent(request.family, parent);
    const wakes = asks && !paused && !this.refuses(parent, state.sessions[nearest]);
    const ask = wakes ? "question" : "approval";
    await this.ports.post(chatId, { body: waitingNote({ ask, parentTitle, waitedMs }), context: { kind: "subchat-waiting", ask, parentTitle, waitedMs } });
    const line = { kind: "subchat-escalation", from: chatId, fromTitle, requestId: request.requestId, waitedMs, ...(paused ? { paused: true } : {}) };
    await this.ports.post(parent, { body: escalationLine(line), context: line });
    await this.ports.remind(chatId, {
      requestId: request.requestId,
      title: attentionTitle({ chatTitle: fromTitle, parentTitle }),
      body: waitingNote({ ask, parentTitle, waitedMs }),
    });
    if (wakes && this.requests.get(request.key) === request) this.queue(parent, request, fromTitle);
  }

  queue(parent, request, title) {
    if (!this.wakes.has(parent)) this.wakes.set(parent, { parent, family: request.family, openAt: this.now() + ESCALATION_BATCH_MS, requests: new Map() });
    request.title = title;
    this.wakes.get(parent).requests.set(request.key, request);
  }

  gate(root) {
    const { wakes, last } = this.family(root);
    if (wakes >= ESCALATION_MAX_WAKES) return "spent";
    if (!last) return "open";
    return [...last.requests].some((key) => this.requests.has(key)) || this.now() - last.at < ESCALATION_COOLDOWN_MS ? "wait" : "open";
  }

  async attempt(wake) {
    if (wake.attempting || this.now() < wake.openAt) return;
    wake.attempting = true;
    try {
      await this.deliver(wake);
    } finally {
      wake.attempting = false;
    }
  }

  async deliver(wake) {
    const { parent, family } = wake;
    const drop = () => {
      if (this.wakes.get(parent) === wake) this.wakes.delete(parent);
    };
    const open = () => {
      const gate = this.gate(family);
      if (gate === "spent") drop();
      return gate === "open";
    };
    if (!open()) return;
    const id = sessionIdFromKey(parent);
    const session = (await this.ports.read(projectOfKey(parent), [id])).sessions[id];
    if (this.wakes.get(parent) !== wake) return;
    if (this.refuses(parent, session)) return void drop();
    if (this.ports.busy(parent) || owesTurn(session) || !open()) return;
    const requests = [...wake.requests.values()];
    const spent = this.family(family);
    const before = { ...spent };
    Object.assign(spent, { wakes: spent.wakes + 1, last: { at: this.now(), requests: new Set(wake.requests.keys()) } });
    try {
      await this.ports.wake(parent, {
        body: wakeBody(requests),
        prompt: wakePrompt(requests, { full: this.ports.mode(parent, session) === "full" }),
        context: { kind: "subchat-wake", requests: requests.map(({ chatId, title, requestId }) => ({ from: chatId, fromTitle: title, requestId })) },
        guard: { level: ESCALATION_LEVEL, requests: requests.map(({ chatId, requestId }) => ({ chatId, requestId })) },
      });
    } catch (error) {
      Object.assign(spent, before);
      if (error.chatBusy) return;
      drop();
      throw error;
    }
    for (const { key } of requests) wake.requests.delete(key);
    if (!wake.requests.size) drop();
  }

  close() {
    this.closed = true;
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
  }
}

module.exports = { SubchatEscalation, TICK_MS };
