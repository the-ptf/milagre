const { doneDue } = require("@milagre/shared/done");

// The sweep that archives Done Chats once they have been Done for the retention in Settings. It looks at the state
// memory holds (no read of a closed Project), and hands each due Chat to `archive`, which reads it again and archives it
// only if it is still due: a Chat reopened in the meantime stays.
const SWEEP_MS = 60 * 1000;

function createDoneSweep({ settings, scopes, heldState, archive, isClosing = () => false, now = () => Date.now() }) {
  let timer = null;
  let running = null;
  async function sweep() {
    const { retentionHours } = settings.read();
    if (!retentionHours) return [];
    const archived = [];
    for (const scope of scopes()) {
      const sessions = Object.values(heldState(scope)?.sessions ?? {});
      for (const session of sessions) {
        if (isClosing()) return archived;
        if (!doneDue(session, retentionHours, now())) continue;
        try {
          if (await archive(scope, session.id, retentionHours)) archived.push(`${scope}#${session.id}`);
        } catch (error) {
          console.warn("Milagre couldn't archive a Done Chat:", error.message);
        }
      }
    }
    return archived;
  }
  // One sweep at a time: a slow one (a worktree removal) is not started again under itself.
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

module.exports = { createDoneSweep, SWEEP_MS };
