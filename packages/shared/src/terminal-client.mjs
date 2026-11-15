/**
 * `reset(data)` replaces everything shown; `ended()` runs once when the shell is gone. A failed read retries after
 * `retryMs`.
 * The next read waits for `write` and `reset` to settle when they return a promise; a viewer that falls behind the
 * host's kept
 * output is reset to its tail. `readLimit` caps one read.
 */
export function followTerminal({
  terminalId,
  api,
  write,
  reset,
  ended = () => {},
  info = () => {},
  readLimit,
  retryMs = 1000,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let stopped = false;
  let offset = 0;
  let pending = "";
  let sending = null;
  let size = null;
  let sizing = null;

  async function readLoop() {
    while (!stopped) {
      let read;
      try {
        read = await api.read({ terminalId, after: offset, ...(readLimit ? { limit: readLimit } : {}) });
      } catch {
        if (!stopped) await wait(retryMs);
        continue;
      }
      if (stopped) return;
      try {
        if (read.reset) await reset(read.data);
        else if (read.data) await write(read.data);
      } catch {
        // xterm refuses writes past its own queue.
      }
      if (stopped) return;
      offset = read.offset;
      if (read.terminal) info(read.terminal);
      if (read.ended) {
        stopped = true;
        ended();
        return;
      }
    }
  }

  async function flush() {
    while (pending) {
      if (stopped) break;
      const data = pending;
      pending = "";
      try {
        await api.input({ terminalId, data });
      } catch {}
    }
    sending = null;
  }

  async function flushSize() {
    while (size) {
      if (stopped) break;
      const next = size;
      size = null;
      try {
        await api.resize({ terminalId, cols: next.cols, rows: next.rows });
      } catch {}
    }
    sizing = null;
  }

  void readLoop();
  return {
    send(data) {
      if (stopped || typeof data !== "string" || !data) return;
      pending += data;
      sending ??= flush();
    },
    /** The PTY takes the size of the viewer that sent one last. */
    resize(cols, rows) {
      if (stopped || !Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 2 || rows < 1) return;
      size = { cols, rows };
      sizing ??= flushSize();
    },
    stop() {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
  };
}
