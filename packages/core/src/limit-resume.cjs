const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");

const DAY_MS = 24 * 60 * 60 * 1000;
const RESET_ALLOWANCE_MS = 60 * 1000;
const CHECK_MS = 30 * 1000;
const RESET_PROMPT =
  "Your last turn stopped because the account hit its plan's usage limit. The limit has reset. Continue where you left off; check what is already done before repeating any of it.";

// Called inside the Chat's state queue, with its transcript loaded. A continuation can never steer or queue behind new work.
function eligibleLimitTurn(state, session, stopped) {
  if (!session || !stopped || session.archived || session.provider !== stopped.provider || session.queued?.length) return false;
  const messages = state.messages.filter((message) => message.session_id === session.id);
  const source = messages.find((message) => message.id === stopped.sourceMessageId);
  return (
    source?.context?.kind === "limit" &&
    source.context.provider === stopped.provider &&
    !messages.some((message) => message.id > source.id && message.role === "user")
  );
}

/** Wall-clock polling survives sleep. Discovery reads durable scopes without opening windows or resuming other work. */
function createLimitResume({ chats, settings, scopes, readState, prepareScope, accountId, now = Date.now, timers = globalThis, onError = console.warn }) {
  let stopped = false;
  let timer = null;
  let ticking = null;
  let discovered = false;
  const pendingScopes = new Map();
  const unread = new Set();

  function trackState(projectPath, state) {
    const pending = Object.values(state?.sessions ?? {}).filter((session) => session.limitResume);
    if (pending.length) pendingScopes.set(projectPath, pending);
    else pendingScopes.delete(projectPath);
  }
  const fence = (token) => ({ ...token, valid: () => !stopped && token.valid() });

  async function observe(chatId, event, token) {
    if (stopped || event.type !== "turn-failed" || !event.limit || !settings.resumeAtReset()) return false;
    const at = Date.parse(event.limit.resetsAt);
    if (!Number.isFinite(at) || at <= now() || at - now() > DAY_MS) return false;
    const projectPath = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    const selected = await accountId(projectPath, event.limit.provider);
    if (stopped || !token.valid() || !settings.resumeAtReset()) return false;
    return chats.scheduleLimitResume(projectPath, sessionId, { mode: "automatic", accountId: selected, token: fence(token) });
  }

  async function schedule(projectPath, sessionId, sourceMessageId) {
    const token = chats.limitResumeToken(projectPath, sessionId);
    const session = (await readState(projectPath))?.sessions[sessionId];
    if (!session?.limitTurn) throw new Error("This Chat no longer has a usage-limited turn to continue.");
    const selected = await accountId(projectPath, session.limitTurn.provider);
    if (stopped || !token.valid()) return false;
    token.sourceMessageId = sourceMessageId;
    return chats.scheduleLimitResume(projectPath, sessionId, { mode: "manual", accountId: selected, token: fence(token) });
  }

  async function sweep() {
    if (!discovered) {
      for (const projectPath of await scopes()) unread.add(projectPath);
      discovered = true;
    }
    for (const projectPath of unread) {
      if (stopped) return;
      try {
        trackState(projectPath, await readState(projectPath));
        unread.delete(projectPath);
      } catch (error) {
        onError(`Milagre couldn't read usage-limit continuations in ${projectPath}:`, error.message);
      }
    }
    for (const [projectPath, sessions] of pendingScopes) {
      if (stopped) return;
      try {
        for (const session of sessions) {
          const pending = session.limitResume;
          if (!pending || now() < Date.parse(pending.at) + RESET_ALLOWANCE_MS) continue;
          if (stopped) return;
          const token = chats.limitResumeToken(projectPath, session.id);
          if ((await prepareScope(projectPath)) === false) continue;
          if (stopped || !token.valid()) continue;
          if (now() > pending.expiresAt) {
            await chats.cancelLimitResume(projectPath, session.id);
            continue;
          }
          const selected = await accountId(projectPath, pending.provider);
          if (stopped || !token.valid()) continue;
          await chats.runLimitResume(projectPath, session.id, { accountId: selected, token: fence(token), sendId: pending.sendId });
        }
      } catch (error) {
        onError(`Milagre couldn't continue a usage-limited Chat in ${projectPath}:`, error.message);
      }
    }
  }

  function tick() {
    if (stopped) return Promise.resolve();
    ticking ??= sweep()
      .catch((error) => onError("Milagre couldn't check usage-limit continuations:", error.message))
      .finally(() => {
        ticking = null;
      });
    return ticking;
  }

  return {
    observe,
    trackState,
    schedule,
    tick,
    start() {
      if (timer !== null || stopped) return;
      timer = timers.setInterval(() => void tick(), CHECK_MS);
      timer.unref?.();
      void tick();
    },
    async stop() {
      stopped = true;
      if (timer !== null) timers.clearInterval(timer);
      await ticking;
    },
  };
}

module.exports = { createLimitResume, eligibleLimitTurn, DAY_MS, RESET_ALLOWANCE_MS, RESET_PROMPT };
