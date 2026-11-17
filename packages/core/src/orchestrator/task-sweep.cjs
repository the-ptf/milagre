const { taskSwept } = require("@milagre/shared/orchestrator");

const REMOTE_READ_MS = 4000;

function createTaskSweep({ store, ports, now = () => Date.now() }) {
  function localGone(retentionHours) {
    const busy = ports.busy();
    const gone = [];
    for (const task of store.read().tasks) {
      if (task.remoteTaskId || task.state !== "started" || task.sessionId === null || !task.projectPath) continue;
      const state = ports.heldState(task.projectPath);
      if (!state) continue;
      const session = state.sessions?.[task.sessionId];
      if (!taskSwept(session, { busy: busy.has(ports.chatKey(task.projectPath, task.sessionId)), retentionHours, now: now() })) continue;
      const hiddenIdle = session && !session.archived && !session.done_at && session.orchestrator?.hidden !== false;
      gone.push({ task, archive: hiddenIdle });
    }
    return gone;
  }

  async function remoteGone() {
    const mirrors = store.read().tasks.filter((task) => task.remoteTaskId && task.remoteComputerId);
    if (!mirrors.length || !ports.remote?.enabled?.()) return [];
    const gone = [];
    for (const computerId of new Set(mirrors.map((task) => task.remoteComputerId))) {
      const snapshot = await ports.withTimeout(ports.remote.invoke(computerId, "orchestrator:read", []), REMOTE_READ_MS).catch(() => null);
      if (!Array.isArray(snapshot?.tasks)) continue;
      const kept = new Set(snapshot.tasks.map((task) => task.id));
      for (const task of mirrors) if (task.remoteComputerId === computerId && !kept.has(task.remoteTaskId)) gone.push({ task, archive: false });
    }
    return gone;
  }

  async function sweep() {
    const { retentionHours } = ports.doneSettings();
    const gone = [...localGone(retentionHours), ...(await remoteGone())];
    if (!gone.length) return [];
    for (const { task, archive } of gone) {
      if (archive)
        await ports
          .archive(task.projectPath, task.sessionId)
          .catch((error) => console.warn("[orchestrator] couldn't archive a Done task's Chat:", error.message));
    }
    const ids = new Set(gone.map(({ task }) => task.id));
    store.update((current) => ({ ...current, tasks: current.tasks.filter((task) => !ids.has(task.id)) }));
    for (const id of ids) ports.images.drop(id);
    return [...ids];
  }

  let timer = null;
  let running = null;
  const run = () =>
    (running ??= sweep()
      .catch((error) => {
        console.warn("[orchestrator] the Done task sweep failed:", error.message);
        return [];
      })
      .finally(() => (running = null)));
  return {
    sweep: run,
    start(intervalMs) {
      timer ??= setInterval(() => void run(), intervalMs);
      timer.unref?.();
      void run();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createTaskSweep };
