const { AsyncLocalStorage } = require("node:async_hooks");

// Every `git` and `gh` the host starts waits for a slot here, so a burst of background reads (the PR poller, diff

const LIMITS = Object.freeze({ git: 8, gh: 4 });

const lane = new AsyncLocalStorage();
const background = (task) => lane.run("background", task);
const currentLane = () => lane.getStore() ?? "interactive";

/** The scheduler kind of a program: `git`, `gh`, or null for anything that isn't limited. */
function kindOf(command) {
  if (typeof command !== "string") return null;
  const name = (command.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "");
  return name === "git" || name === "gh" ? name : null;
}

function createLanes(limits = LIMITS) {
  const pools = new Map();
  const poolOf = (kind) => {
    let pool = pools.get(kind);
    if (!pool) pools.set(kind, (pool = { running: 0, interactive: [], background: [] }));
    return pool;
  };
  function drain(kind) {
    const pool = poolOf(kind);
    const limit = limits[kind];
    for (;;) {
      let next;
      if (pool.interactive.length && pool.running < limit) next = pool.interactive.shift();
      else if (pool.background.length && pool.running < limit - 1) next = pool.background.shift();
      else return;
      pool.running++;
      let released = false;
      next(() => {
        if (released) return;
        released = true;
        pool.running--;
        drain(kind);
      });
    }
  }
  function acquire(kind, which = currentLane()) {
    if (!limits[kind]) return Promise.resolve(() => {});
    return new Promise((resolve) => {
      poolOf(kind)[which === "background" ? "background" : "interactive"].push(resolve);
      drain(kind);
    });
  }
  async function run(kind, task, which = currentLane()) {
    const release = await acquire(kind, which);
    try {
      return await task();
    } finally {
      release();
    }
  }
  const stats = (kind) => {
    const pool = poolOf(kind);
    return { running: pool.running, interactive: pool.interactive.length, background: pool.background.length };
  };
  return { acquire, run, stats };
}

const shared = createLanes();

/** A promise-returning `exec(command, args, options)` whose `git` and `gh` runs wait for a slot. */
const scheduled =
  (exec, lanes = shared) =>
  (command, args, options) => {
    const kind = kindOf(command);
    return kind ? lanes.run(kind, () => exec(command, args, options)) : exec(command, args, options);
  };

module.exports = { LIMITS, background, currentLane, kindOf, createLanes, lanes: shared, scheduled };
