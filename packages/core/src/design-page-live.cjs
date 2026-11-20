const LIVE_DELAY_MS = 3000;
const RETRY_DELAY_MS = 15_000;
const MAX_RETRY_DELAY_MS = 10 * 60_000;

/**
 * One timer per Chat for its live links: a change publishes after `delay`, and a run that reports a failure worth
 * retrying runs again after a backoff that doubles from `retryDelay` up to `maxRetryDelay`. `flush(chatId)` resolves
 * true when it should be retried.
 */
function createLiveSchedule({
  flush,
  timers = { setTimeout, clearTimeout },
  delay = LIVE_DELAY_MS,
  retryDelay = RETRY_DELAY_MS,
  maxRetryDelay = MAX_RETRY_DELAY_MS,
}) {
  const chats = new Map();
  const schedule = (chatId, wait) => {
    const state = chats.get(chatId) ?? { failures: 0, timer: null };
    chats.set(chatId, state);
    if (state.timer) timers.clearTimeout(state.timer);
    state.timer = timers.setTimeout(() => run(chatId, state), wait);
    state.timer?.unref?.();
  };
  const retry = (chatId) => {
    const failures = chats.get(chatId)?.failures ?? 0;
    schedule(chatId, Math.min(maxRetryDelay, retryDelay * 2 ** failures));
    chats.get(chatId).failures = failures + 1;
  };
  const run = async (chatId, state) => {
    state.timer = null;
    const again = await flush(chatId).catch(() => true);
    if (state.timer || chats.get(chatId) !== state) return;
    if (again) retry(chatId);
    else chats.delete(chatId);
  };
  return {
    changed: (chatId) => schedule(chatId, delay),
    now: (chatId) => schedule(chatId, 0),
    retry,
    close: () => {
      for (const state of chats.values()) if (state.timer) timers.clearTimeout(state.timer);
      chats.clear();
    },
  };
}

module.exports = { createLiveSchedule };
