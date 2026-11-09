/** Serial polling: wait after each read, pause while hidden, and read immediately on return. */
export function startRefreshLoop({ refresh, isActive = () => true, onActive, intervalMs = 3000, repeat = true, schedule = setTimeout, cancel = clearTimeout }) {
  let disposed = false;
  let busy = false;
  let timer;
  const stopTimer = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  const run = async () => {
    stopTimer();
    if (disposed || busy || !isActive()) return;
    busy = true;
    try {
      await refresh();
    } catch {
      // The caller owns error presentation; a failed read must not stop subsequent retries.
    } finally {
      busy = false;
      if (!disposed && repeat && isActive()) timer = schedule(run, intervalMs);
    }
  };
  const off = onActive?.(() => {
    stopTimer();
    if (isActive()) void run();
  });
  void run();
  return () => {
    disposed = true;
    stopTimer();
    off?.();
  };
}
