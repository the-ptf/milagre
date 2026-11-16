const { normalizeOrchestratorMemory } = require("@milagre/shared/orchestrator");

function createMemorySync({ store, remote, schedule = setTimeout, cancel = clearTimeout, delayMs = 2000 }) {
  let sent = store.read().memory.updatedAt;
  let timer = null;

  function adopt(incoming) {
    const memory = normalizeOrchestratorMemory(incoming);
    if (memory.updatedAt <= store.read().memory.updatedAt) return false;
    sent = memory.updatedAt;
    store.update((current) => ({ ...current, memory }));
    return true;
  }

  async function push() {
    timer = null;
    if (!remote?.enabled?.()) return;
    const memory = store.read().memory;
    sent = memory.updatedAt;
    await Promise.all(
      remote.list().map(async (computer) => {
        const theirs = await remote.invoke(computer.id, "orchestrator:memory:merge", [memory]).catch(() => null);
        if (theirs) adopt(theirs);
      }),
    );
  }

  return {
    changed() {
      if (store.read().memory.updatedAt === sent || timer) return;
      timer = schedule(() => void push(), delayMs);
    },
    merge(incoming) {
      adopt(incoming);
      return store.read().memory;
    },
    pushNow: push,
    close() {
      if (timer) cancel(timer);
      timer = null;
    },
  };
}

module.exports = { createMemorySync };
