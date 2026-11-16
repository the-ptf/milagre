/**
 * The runtime's shutdown, as two ordered lists. `stop` steps run synchronously on every close() call, in the order
 * they were added; `close` steps run once, one after another (a step's promise is awaited before the next), and a failure lets the
 * next close() run them again.
 */
function createShutdown() {
  const stops = [];
  const closes = [];
  let closed;
  return {
    stop(step) {
      stops.push(step);
    },
    close(step) {
      closes.push(step);
    },
    run() {
      for (const step of stops) step();
      closed ??= (async () => {
        for (const step of closes) {
          const result = step();
          if (result && typeof result.then === "function") await result;
        }
      })().catch((error) => {
        closed = undefined;
        throw error;
      });
      return closed;
    },
  };
}

module.exports = { createShutdown };
