const { randomUUID } = require("node:crypto");
const { capOutput } = require("@milagre/shared/agent-runs");
const { ipcErrorMessage } = require("@milagre/shared/result");

function publicState(entry) {
  if (!entry) return null;
  const { requestId, chatId, question, text, steps, status, error, provider, model, startedAt, endedAt } = entry;
  return {
    requestId,
    chatId,
    question,
    text,
    steps,
    status,
    ...(error ? { error } : {}),
    provider,
    model,
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
  };
}

function closeSession(entry, interrupt = false) {
  const session = entry.session;
  entry.session = null;
  if (!session) return entry.closing ?? Promise.resolve();
  entry.closing = (async () => {
    if (interrupt) await session.interrupt().catch(() => {});
    await session.close().catch(() => {});
  })();
  return entry.closing;
}

function createBtw({ contextFor, launch, emit = () => {}, now = Date.now }) {
  const entries = new Map();
  const queues = new Map();
  let closed = false;
  const current = (entry) => !closed && entries.get(entry.chatId) === entry && entry.status === "running";
  const publish = (entry) => emit("chat:btw-event", { chatId: entry.chatId, btw: publicState(entry) });
  function serial(chatId, fn) {
    const pending = (queues.get(chatId) ?? Promise.resolve()).catch(() => {}).then(fn);
    queues.set(chatId, pending);
    void pending
      .finally(() => {
        if (queues.get(chatId) === pending) queues.delete(chatId);
      })
      .catch(() => {});
    return pending;
  }
  function handleEvent(entry, event) {
    if (!current(entry)) return;
    switch (event.type) {
      case "text-delta":
        entry.text += event.text ?? "";
        break;
      case "step-started":
        entry.steps = [
          ...entry.steps.filter((step) => step.id !== event.step.id),
          { ...event.step, detail: capOutput(event.step.detail ?? ""), status: "running", offset: entry.text.length },
        ];
        break;
      case "step-output":
        entry.steps = entry.steps.map((step) =>
          step.id === event.id && step.status === "running" ? { ...step, detail: capOutput((step.detail ?? "") + event.text) } : step,
        );
        break;
      case "step-completed":
        entry.steps = entry.steps.map((step) =>
          step.id === event.id
            ? {
                ...step,
                status: event.status,
                ...(event.title === undefined ? {} : { title: event.title }),
                ...(event.detail === undefined ? {} : { detail: capOutput(event.detail) }),
              }
            : step,
        );
        break;
      case "turn-completed":
      case "turn-cancelled":
      case "turn-failed":
        entry.status = event.type === "turn-completed" ? "completed" : event.type === "turn-cancelled" ? "cancelled" : "failed";
        if (event.type === "turn-failed") entry.error = event.message || "Side question failed.";
        entry.endedAt = now();
        entry.steps = entry.steps.map((step) => (step.status === "running" ? { ...step, status: entry.status === "completed" ? "done" : "failed" } : step));
        void closeSession(entry);
        break;
      default:
        return;
    }
    publish(entry);
  }
  async function run(entry, ctx) {
    try {
      const forkSession = Boolean(ctx.parentNativeId && (ctx.provider === "claude" || ctx.provider === "codex"));
      const session = await launch({
        chatId: entry.chatId,
        requestId: entry.requestId,
        context: ctx,
        resumeId: forkSession ? ctx.parentNativeId : null,
        forkSession,
        emit: (event) => handleEvent(entry, event),
      });
      entry.session = session;
      if (!current(entry)) return await closeSession(entry, true);
      const prompt =
        !forkSession && ctx.transcript?.trim()
          ? `<chat_transcript>\n${ctx.transcript}\n</chat_transcript>\n\nSide question (/btw): ${entry.question}`
          : entry.question;
      await session.startTurn({ model: ctx.model, effort: ctx.effort, permissionMode: "ask", prompt, images: [], canStart: () => current(entry) });
    } catch (error) {
      handleEvent(entry, { type: "turn-failed", message: ipcErrorMessage(error) });
    }
  }
  function ask(request = {}) {
    const chatId = typeof request.chatId === "string" ? request.chatId : "";
    const question = typeof request.prompt === "string" ? request.prompt.trim() : "";
    if (!chatId) return Promise.reject(new Error("Choose a Chat before asking a side question."));
    if (!question) return Promise.reject(new Error("Type a question after /btw."));
    return serial(chatId, async () => {
      if (closed) throw new Error("Milagre runtime is closing.");
      const ctx = await contextFor(chatId, request);
      if (closed) throw new Error("Milagre runtime is closing.");
      await stopNow(chatId);
      const entry = {
        requestId: randomUUID(),
        chatId,
        question,
        text: "",
        steps: [],
        status: "running",
        provider: ctx.provider,
        model: ctx.model,
        startedAt: now(),
        session: null,
      };
      entries.set(chatId, entry);
      publish(entry);
      entry.running = run(entry, ctx);
      return publicState(entry);
    });
  }
  async function stopNow(chatId, { clear = false } = {}) {
    const entry = entries.get(chatId);
    if (!entry) return null;
    const running = entry.status === "running";
    if (running) {
      entry.status = "cancelled";
      entry.endedAt = now();
      entry.steps = entry.steps.map((step) => (step.status === "running" ? { ...step, status: "failed" } : step));
    }
    if (clear) {
      entries.delete(chatId);
      emit("chat:btw-event", { chatId, btw: null });
    } else if (running) publish(entry);
    await closeSession(entry, running);
    return clear ? null : publicState(entry);
  }
  async function closeChat(chatId) {
    await queues.get(chatId)?.catch(() => {});
    const entry = entries.get(chatId);
    await stopNow(chatId, { clear: true });
    await entry?.running;
    await entry?.closing;
  }
  async function close() {
    closed = true;
    await Promise.allSettled(queues.values());
    await Promise.allSettled([...entries.keys()].map(closeChat));
  }
  return {
    ask,
    stop: (chatId, options) => serial(chatId, () => stopNow(chatId, options ?? {})),
    read: (chatId) => publicState(entries.get(chatId)),
    closeChat,
    close,
  };
}

module.exports = { createBtw };
