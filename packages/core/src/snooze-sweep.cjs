const { snoozeDue } = require("@milagre/shared/snooze");

// The sweep that wakes snoozed Chats once their time comes. It looks at the state memory holds and hands each due Chat
// to `wake`, which reads it again and wakes it only if it is still due: one snoozed again in the meantime stays.
const SWEEP_MS = 30 * 1000;

function createSnoozeSweep({ scopes, heldState, wake, isClosing = () => false, now = () => Date.now() }) {
  let timer = null;
  let running = null;
  async function sweep() {
    const woke = [];
    for (const scope of scopes()) {
      for (const session of Object.values(heldState(scope)?.sessions ?? {})) {
        if (isClosing()) return woke;
        if (!snoozeDue(session, now())) continue;
        try {
          if (await wake(scope, session.id)) woke.push(`${scope}#${session.id}`);
        } catch (error) {
          console.warn("Milagre couldn't wake a snoozed Chat:", error.message);
        }
      }
    }
    return woke;
  }
  const run = () => (running ??= sweep().finally(() => (running = null)));
  return {
    sweep: run,
    start() {
      timer ??= setInterval(() => void run(), SWEEP_MS);
      timer.unref?.();
      void run();
    },
    stop() {
      clearInterval(timer);
      timer = null;
      return running ?? Promise.resolve([]);
    },
  };
}

module.exports = { createSnoozeSweep, SWEEP_MS };
