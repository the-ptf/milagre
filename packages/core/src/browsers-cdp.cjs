const { execFile: execFileCallback } = require("node:child_process");
const { promisify } = require("node:util");
const { parseLsof } = require("./agents/ports.cjs");

// Discovery reads the process table and each candidate's loopback DevTools endpoint, and starts no
// capture. Only Chromium browser processes started with --remote-debugging-port qualify; a browser
// driven over --remote-debugging-pipe (Playwright's default) has no endpoint to attach to.
const PORT_ARG = /(?:^|\s)--remote-debugging-port=(\d{1,5})(?=\s|$)/;
const PAGE_ID = /^[A-Fa-f0-9]{32}$/;
const BROWSER_PATH = /\/devtools\/browser\/([A-Za-z0-9-]{8,64})$/;
const LOOPBACK = new Map([
  ["127.0.0.1", "127.0.0.1"],
  ["::1", "[::1]"],
  ["localhost", "127.0.0.1"],
]);
const MAX_CANDIDATES = 16;
const MAX_FRAME = 1536 * 1024;
const MAX_MESSAGE = 4 * 1024 * 1024;
const BUTTON_BITS = { left: 1, right: 2, middle: 4, none: 0 };

/** `ps -axo pid=,ppid=,args=` rows. Arguments are only matched here, never kept or logged. */
function parseProcesses(output) {
  const processes = [],
    candidates = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]),
      ppid = Number(match[2]),
      args = match[3];
    processes.push({ pid, ppid });
    const port = PORT_ARG.exec(args);
    // Renderer, GPU and utility helpers carry --type; the browser process does not.
    if (port && !/(?:^|\s)--type=/.test(args) && Number(port[1]) <= 65535 && candidates.length < MAX_CANDIDATES)
      candidates.push({ pid, port: Number(port[1]) });
  }
  return { processes, candidates };
}
function productName(value) {
  const [name, version] = String(value ?? "").split("/");
  const label = { HeadlessChrome: "Headless Chrome", Edg: "Edge", Chrome: "Chrome", Chromium: "Chromium" }[name] ?? (name ? name.slice(0, 40) : "Browser");
  const major = /^(\d{1,4})/.exec(version ?? "")?.[1];
  return major ? `${label} ${major}` : label;
}
// /json/list HTML-escapes titles; the viewer shows them as text.
function unescape(value) {
  return String(value ?? "").replace(
    /&(amp|lt|gt|quot|#39|#x27);/g,
    (_match, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[name],
  );
}
function visiblePage(page) {
  return page?.type === "page" && typeof page.id === "string" && PAGE_ID.test(page.id) && !/^(devtools|chrome-extension):/.test(String(page.url ?? ""));
}

async function readJson(fetcher, url, limit) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(1500), redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("DevTools endpoint refused.");
  }
  const reader = response.body.getReader(),
    chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error("DevTools response too large.");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createBrowserAdapter(options = {}) {
  const execFile = options.execFile ?? promisify(execFileCallback);
  const fetcher = options.fetch ?? fetch;
  const Socket = options.WebSocket ?? WebSocket;
  const channels = new Set();

  async function discover() {
    const run = (command, args) => execFile(command, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
    const { processes, candidates } = parseProcesses((await run("ps", ["-axwwo", "pid=,ppid=,args="])).stdout);
    if (!candidates.length) return { processes, browsers: [] };
    // The listener must belong to the browser process itself, so a port reused by another process cannot claim its lineage.
    let listeners = [];
    try {
      listeners = parseLsof(
        (await run("lsof", ["-nP", "-a", "-p", candidates.map((item) => item.pid).join(","), "-iTCP", "-sTCP:LISTEN", "-F", "pcn"])).stdout,
      );
    } catch (error) {
      listeners = parseLsof(error?.stdout ?? "");
    } // lsof exits 1 when a listed pid has no listener.
    const browsers = await Promise.all(
      candidates.map(async (candidate) => {
        const listener = listeners.find(
          (row) => row.pid === candidate.pid && LOOPBACK.has(row.address) && (candidate.port === 0 || row.port === candidate.port),
        );
        if (!listener) return null;
        const host = LOOPBACK.get(listener.address),
          base = `http://${host}:${listener.port}`;
        try {
          const version = await readJson(fetcher, `${base}/json/version`, 65536);
          const id = BROWSER_PATH.exec(String(version.webSocketDebuggerUrl ?? ""))?.[1];
          if (!id) return null;
          const pages = await readJson(fetcher, `${base}/json/list`, 1024 * 1024);
          return {
            id,
            pid: candidate.pid,
            host,
            port: listener.port,
            product: productName(version.Browser),
            pages: (Array.isArray(pages) ? pages : [])
              .filter(visiblePage)
              .slice(0, 64)
              .map((page) => ({ id: page.id, title: unescape(page.title).slice(0, 300), url: String(page.url ?? "").slice(0, 2048) })),
          };
        } catch {
          return null;
        } // A browser that exits or stalls during discovery is omitted.
      }),
    );
    const seen = new Set();
    return { processes, browsers: browsers.filter((item) => item && !seen.has(item.id) && seen.add(item.id)) };
  }

  /** One DevTools session on one page: screencast frames out, admitted input in. It never closes the page. */
  async function connect(browser, pageId) {
    if (!PAGE_ID.test(pageId) || ![...LOOPBACK.values()].includes(browser?.host) || !Number.isInteger(browser.port) || browser.port < 1 || browser.port > 65535)
      throw new Error("Invalid browser page.");
    // A Browser panel's pages are served behind a token path (cdp-proxy.cjs); a real browser has none.
    if (browser.prefix !== undefined && !/^\/[a-f0-9]{48}$/.test(browser.prefix)) throw new Error("Invalid browser page.");
    const socket = new Socket(`ws://${browser.host}:${browser.port}${browser.prefix ?? ""}/devtools/page/${pageId}`);
    const pending = new Map(),
      listeners = new Set();
    let nextId = 0,
      sequence = 0,
      latest = null,
      localClosed = false,
      history = null,
      historyTimer = null,
      historyAt = 0,
      pressed = "none",
      emulated = false;
    let state = { ready: false, width: 0, height: 0, title: "", url: "", canGoBack: false, canGoForward: false };
    const fail = (message) => {
      if (state.error) return;
      clearTimeout(historyTimer);
      state = { ...state, ready: false, error: message };
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error(message));
      }
      pending.clear();
      // A copy: listeners may change their subscriptions during notification.
      for (const listener of Array.from(listeners)) listener();
      if (socket.readyState === Socket.OPEN || socket.readyState === Socket.CONNECTING) socket.close();
    };
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        if (state.error || localClosed || socket.readyState !== Socket.OPEN) {
          reject(new Error(state.error ?? "Browser connection closed."));
          return;
        }
        // A stalled page must not accumulate an unbounded command backlog.
        if (pending.size >= 64) {
          reject(new Error("The browser page is not responding."));
          return;
        }
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("The browser page did not respond."));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    const quiet = (promise) => {
      promise.catch(() => {});
    };
    async function refreshHistory() {
      historyAt = Date.now();
      try {
        const value = await call("Page.getNavigationHistory");
        const entries = Array.isArray(value?.entries) ? value.entries : [],
          index = value?.currentIndex;
        const current = entries[index];
        if (!current) return;
        history = { entries: entries.map((entry) => entry.id), index };
        state = {
          ...state,
          title: String(current.title || current.url || "").slice(0, 300),
          url: String(current.url ?? "").slice(0, 2048),
          canGoBack: index > 0,
          canGoForward: index < entries.length - 1,
        };
      } catch {}
    }
    const scheduleHistory = () => {
      clearTimeout(historyTimer);
      historyTimer = setTimeout(() => void refreshHistory(), 100);
      historyTimer.unref?.();
    };
    socket.addEventListener("message", ({ data }) => {
      if (typeof data !== "string" || data.length > MAX_MESSAGE) return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        clearTimeout(item.timer);
        if (message.error) item.reject(new Error("The browser rejected the command."));
        else item.resolve(message.result);
        return;
      }
      const params = message.params ?? {};
      switch (message.method) {
        case "Page.screencastFrame": {
          quiet(call("Page.screencastFrameAck", { sessionId: params.sessionId }));
          const width = Math.round(params.metadata?.deviceWidth),
            height = Math.round(params.metadata?.deviceHeight);
          if (typeof params.data !== "string" || params.data.length > MAX_FRAME || !(width > 0 && width <= 16384 && height > 0 && height <= 16384)) return;
          latest = { sequence: ++sequence, data: params.data, viewport: { width, height } };
          state = { ...state, ready: true, width, height };
          // A copy: a frame callback may resubscribe to the capture.
          for (const listener of Array.from(listeners)) listener();
          return;
        }
        case "Page.frameNavigated":
          if (!params.frame?.parentId) scheduleHistory();
          return;
        case "Page.navigatedWithinDocument":
        case "Page.loadEventFired":
          scheduleHistory();
          return;
        case "Inspector.detached":
          fail("This page closed. Choose another page.");
          return;
        case "Inspector.targetCrashed":
          fail("This page crashed. Reload it in the browser, then retry.");
          return;
      }
    });
    socket.addEventListener("close", () => {
      if (!localClosed) fail("The browser connection closed. Retry to reconnect.");
    });
    socket.addEventListener("error", () => fail("Could not connect to the browser. Retry to reconnect."));
    const channel = {
      // document.title changes raise no Page event; viewers poll status, so refresh the title at most once a second.
      status() {
        if (state.ready && Date.now() - historyAt > 1000) {
          historyAt = Date.now();
          scheduleHistory();
        }
        return { ...state };
      },
      frame() {
        return latest;
      },
      onFrame(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send(event) {
        if (!state.ready || state.error) throw new Error("The browser page is not ready.");
        const point = () => ({ x: event.x * state.width, y: event.y * state.height });
        if (event.kind === "mouse") {
          const type = { down: "mousePressed", move: "mouseMoved", up: "mouseReleased" }[event.phase];
          if (event.phase === "down") pressed = event.button;
          const button = event.phase === "move" ? pressed : event.button;
          quiet(
            call("Input.dispatchMouseEvent", {
              type,
              ...point(),
              button,
              buttons: event.phase === "up" ? 0 : BUTTON_BITS[pressed],
              clickCount: event.clickCount,
              modifiers: event.modifiers ?? 0,
            }),
          );
          if (event.phase === "up") pressed = "none";
        } else if (event.kind === "wheel") {
          quiet(
            call("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              ...point(),
              button: "none",
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              modifiers: event.modifiers ?? 0,
            }),
          );
        } else if (event.kind === "key") {
          const type = event.phase === "up" ? "keyUp" : event.text ? "keyDown" : "rawKeyDown";
          quiet(
            call("Input.dispatchKeyEvent", {
              type,
              key: event.key,
              code: event.code,
              windowsVirtualKeyCode: event.keyCode,
              modifiers: event.modifiers ?? 0,
              ...(event.text ? { text: event.text, unmodifiedText: event.text } : {}),
              ...(event.commands ? { commands: event.commands } : {}),
            }),
          );
        } else if (event.kind === "text") {
          quiet(call("Input.insertText", { text: event.text }));
        } else if (event.kind === "viewport") {
          // The page lays out at the viewer's size, not its window's. A Browser panel page resizes its own <webview> for
          // this instead (browser-panel-pages.cjs): emulation there lays out the page but frames stay the guest's size.
          emulated = true;
          quiet(call("Emulation.setDeviceMetricsOverride", { width: event.width, height: event.height, deviceScaleFactor: 0, mobile: false }));
        } else if (event.action === "reload") {
          quiet(call("Page.reload"));
        } else {
          const entryId = history?.entries[history.index + (event.action === "back" ? -1 : 1)];
          if (entryId !== undefined) quiet(call("Page.navigateToHistoryEntry", { entryId }));
        }
      },
      async close() {
        if (localClosed) return;
        // Stop Milagre's screencast and size only. Never Target.closeTarget or Browser.close.
        if (socket.readyState === Socket.OPEN && !state.error) {
          try {
            if (emulated) socket.send(JSON.stringify({ id: ++nextId, method: "Emulation.clearDeviceMetricsOverride", params: {} }));
            socket.send(JSON.stringify({ id: ++nextId, method: "Page.stopScreencast", params: {} }));
          } catch {}
        }
        localClosed = true;
        clearTimeout(historyTimer);
        channels.delete(channel);
        listeners.clear();
        for (const item of pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error("Browser viewer closed."));
        }
        pending.clear();
        state = { ...state, ready: false };
        if (socket.readyState === Socket.OPEN || socket.readyState === Socket.CONNECTING) socket.close(1000);
      },
    };
    channels.add(channel);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The browser did not accept the connection. Retry to reconnect.")), 8000);
        socket.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          "close",
          () => {
            clearTimeout(timer);
            reject(new Error("The browser refused the connection. Retry to reconnect."));
          },
          { once: true },
        );
      });
      await call("Page.enable");
      await refreshHistory();
      await call("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 1280, everyNthFrame: 1 });
      return channel;
    } catch (error) {
      await channel.close();
      throw error;
    }
  }

  /**
   * A plain DevTools session on one page, for the agent's browser tools: commands with replies, and events. Unlike
   * `connect` it starts no capture and sends no input of its own.
   */
  async function session(browser, pageId) {
    if (!PAGE_ID.test(pageId) || ![...LOOPBACK.values()].includes(browser?.host) || !Number.isInteger(browser.port) || browser.port < 1 || browser.port > 65535)
      throw new Error("Invalid browser page.");
    if (browser.prefix !== undefined && !/^\/[a-f0-9]{48}$/.test(browser.prefix)) throw new Error("Invalid browser page.");
    const socket = new Socket(`ws://${browser.host}:${browser.port}${browser.prefix ?? ""}/devtools/page/${pageId}`);
    const pending = new Map(),
      listeners = new Set();
    let nextId = 0,
      closed = false;
    const fail = (error) => {
      closed = true;
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(error);
      }
      pending.clear();
    };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The page did not answer.")), 10000);
      socket.addEventListener("open", () => (clearTimeout(timer), resolve()), { once: true });
      socket.addEventListener("error", () => (clearTimeout(timer), reject(new Error("Could not reach the page."))), { once: true });
    });
    socket.addEventListener("message", ({ data }) => {
      if (typeof data !== "string" || data.length > MAX_MESSAGE) return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (Number.isSafeInteger(message.id) && pending.has(message.id)) {
        const call = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) call.reject(new Error(String(message.error.message ?? "The page refused the command.")));
        else call.resolve(message.result ?? {});
      } else if (typeof message.method === "string") for (const listener of Array.from(listeners)) listener(message.method, message.params ?? {});
    });
    socket.addEventListener("close", () => fail(new Error("The page closed.")));
    return {
      get closed() {
        return closed;
      },
      send(method, params = {}, timeoutMs = 15000) {
        if (closed || socket.readyState !== Socket.OPEN) return Promise.reject(new Error("The page closed."));
        const id = ++nextId;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`The page did not answer ${method} in time.`));
          }, timeoutMs);
          pending.set(id, { resolve, reject, timer });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        fail(new Error("The page closed."));
        if (socket.readyState === Socket.OPEN || socket.readyState === Socket.CONNECTING) socket.close(1000);
      },
    };
  }

  return {
    discover,
    connect,
    session,
    async stop() {
      await Promise.all([...channels].map((channel) => channel.close()));
    },
  };
}
module.exports = { createBrowserAdapter, parseProcesses, productName };
