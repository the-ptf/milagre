import { BROWSER_RECEIVER_SCRIPT } from "./browser-script.mjs";
export { BROWSER_RECEIVER_SCRIPT } from "./browser-script.mjs";

/** Letterboxes the page's CSS viewport inside the stage. */
export function browserGeometry(viewport, box) {
  if (!viewport || !(viewport.width > 0) || !(viewport.height > 0) || !(box.width > 0) || !(box.height > 0)) return null;
  const scale = Math.min(box.width / viewport.width, box.height / viewport.height);
  return {
    left: (box.width - viewport.width * scale) / 2,
    top: (box.height - viewport.height * scale) / 2,
    width: viewport.width * scale,
    height: viewport.height * scale,
    scale,
  };
}

/** Stage coordinates to the page's 0-1 space. Starts outside the page are ignored; captured drags clamp at its edge. */
export function browserPoint(point, geometry, clamp = false) {
  if (!geometry) return null;
  const x = (point.x - geometry.left) / geometry.width,
    y = (point.y - geometry.top) / geometry.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (!clamp && (x < 0 || x > 1 || y < 0 || y > 1))) return null;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

/** One RPC at a time. Consecutive moves collapse to the newest and consecutive wheels add up; presses, releases and keys are never merged. */
export function createBrowserInputQueue(send, failed, limit = 32) {
  let queue = [],
    sending = false,
    disposed = false;
  const drain = async () => {
    if (sending || disposed) return;
    sending = true;
    try {
      // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- dispose() and the catch/push paths flip `disposed` from other closures while the loop awaits send()
      while (queue.length && !disposed) await send(queue.shift());
    } catch (error) {
      if (!disposed) {
        disposed = true;
        queue = [];
        failed(error);
      }
    } finally {
      sending = false;
    }
  };
  return {
    push(event) {
      if (disposed) return;
      const previous = queue[queue.length - 1];
      if (event.kind === "mouse" && event.phase === "move" && previous?.kind === "mouse" && previous.phase === "move") queue[queue.length - 1] = event;
      else if (event.kind === "wheel" && previous?.kind === "wheel" && (previous.modifiers || 0) === (event.modifiers || 0))
        queue[queue.length - 1] = {
          ...event,
          deltaX: Math.max(-10000, Math.min(10000, previous.deltaX + event.deltaX)),
          deltaY: Math.max(-10000, Math.min(10000, previous.deltaY + event.deltaY)),
        };
      else if (queue.length >= limit) {
        disposed = true;
        queue = [];
        failed(new Error("The connection is too slow for input. Retry the browser."));
        return;
      } else queue.push(event);
      void drain();
    },
    dispose() {
      disposed = true;
      queue = [];
    },
  };
}

/**
 * Touch has no hover or wheel, so a finger chooses its meaning: a quick tap clicks, moving scrolls the page
 * under the finger, and holding still first presses the mouse for a drag (text selection, sliders).
 */
export function createTouchGesture(handlers, timers, slop = 8, holdMs = 450) {
  let active = null;
  const clear = () => {
    if (active?.timer) timers.clearTimeout(active.timer);
  };
  return {
    begin(id, screen, point) {
      if (active) return false;
      active = { id, mode: "pending", start: screen, last: screen, point, timer: null };
      const current = active;
      current.timer = timers.setTimeout(() => {
        if (active === current && current.mode === "pending") {
          current.mode = "pressing";
          current.timer = null;
          handlers.pressStart(current.point);
        }
      }, holdMs);
      return true;
    },
    move(id, screen, point) {
      if (active?.id !== id) return;
      if (active.mode === "pending" && Math.hypot(screen.x - active.start.x, screen.y - active.start.y) > slop) {
        clear();
        active.timer = null;
        active.mode = "scrolling";
      }
      if (active.mode === "scrolling") handlers.scroll(screen.x - active.last.x, screen.y - active.last.y, active.point);
      else if (active.mode === "pressing" && point) {
        active.point = point;
        handlers.pressMove(point);
      }
      active.last = screen;
    },
    end(id, point) {
      if (active?.id !== id) return;
      const { mode } = active,
        start = active.point;
      clear();
      active = null;
      if (mode === "pending") handlers.tap(start);
      else if (mode === "pressing") handlers.pressEnd(point || start);
    },
    cancel() {
      if (!active) return;
      const { mode, point } = active;
      clear();
      active = null;
      if (mode === "pressing") handlers.pressEnd(point);
    },
    get active() {
      return !!active;
    },
  };
}

/** A keydown that should reach the page as a key, or null to let the text field insert it as text. */
export function browserKey(event) {
  const special = {
    Enter: 13,
    Backspace: 8,
    Tab: 9,
    Escape: 27,
    Delete: 46,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
  };
  const modifiers = (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  const code = typeof event.code === "string" && /^[A-Za-z0-9]{0,32}$/.test(event.code) ? event.code : "";
  const key = event.key;
  if (typeof key !== "string" || !key || key.length > 32) return null;
  if (special[key] !== undefined)
    return { key, code: code || key, keyCode: special[key], ...(key === "Enter" ? { text: "\r" } : {}), ...(modifiers ? { modifiers } : {}) };
  if ((event.metaKey || event.ctrlKey) && key.length === 1) {
    const command = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: event.shiftKey ? "redo" : "undo", y: "redo" }[key.toLowerCase()];
    return { key, code, keyCode: key.toUpperCase().charCodeAt(0), modifiers, ...(command ? { commands: [command] } : {}) };
  }
  if (key.length === 1 && !event.isComposing)
    return { key, code, keyCode: /^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0, text: key, ...(modifiers ? { modifiers } : {}) };
  return null;
}

/** The wrapper is capability-scoped: a receiver cannot address another viewer or call arbitrary RPC. `transform` may rewrite results (mobile swaps frame bytes for a local file). */
export function createBrowserBridge(call, respond, transform = (_method, result) => result) {
  const viewers = new Set();
  const openings = new Map();
  let disposed = false;
  const close = (viewerId) =>
    Promise.resolve()
      .then(() => call("close", { viewerId }))
      .catch(() => {});
  return {
    async receive(message) {
      if (disposed || !message || message.channel !== "milagre-browser" || !Number.isSafeInteger(message.id)) return;
      const { id, method, args } = message;
      if (message.event === "cancel") {
        const opening = openings.get(id);
        if (opening) {
          opening.cancelled = true;
          if (opening.viewerId) {
            viewers.delete(opening.viewerId);
            await close(opening.viewerId);
            openings.delete(id);
          }
        }
        return;
      }
      const reply = (value) => {
        if (!disposed) respond({ channel: "milagre-browser", id, ...value });
      };
      try {
        if (!["open", "frame", "status", "control", "input", "close"].includes(method)) throw new Error("Unknown browser command.");
        if (!args || typeof args !== "object") throw new Error("Invalid browser request.");
        if (method === "open") {
          if ([...openings.values()].some((value) => !value.cancelled) || viewers.size) throw new Error("Close the current viewer before opening another.");
          const opening = { cancelled: false, viewerId: null };
          openings.set(id, opening);
          let result;
          try {
            result = await call(method, args);
          } catch (error) {
            openings.delete(id);
            throw error;
          }
          if (disposed || opening.cancelled) {
            if (result?.viewerId) await close(result.viewerId);
            openings.delete(id);
            return;
          }
          opening.viewerId = result.viewerId;
          viewers.add(result.viewerId);
          reply({ result });
        } else {
          if (!viewers.has(args.viewerId)) throw new Error("This browser viewer is closed.");
          let result;
          try {
            result = await transform(method, await call(method, args));
          } finally {
            if (method === "close") {
              viewers.delete(args.viewerId);
              for (const [requestId, item] of openings) if (item.viewerId === args.viewerId) openings.delete(requestId);
            }
          }
          reply({ result });
        }
      } catch (error) {
        reply({ error: error instanceof Error ? error.message : "Browser request failed." });
      }
    },
    dispose() {
      disposed = true;
      for (const viewerId of viewers) void close(viewerId);
      viewers.clear();
      openings.clear();
    },
  };
}

// This function is serialized with its dependencies as arguments. It must not close over module state.
function receiver(config, geometryFor, pointFor, inputQueue, touchGesture, keyFor) {
  window.browserTheme = (theme) => {
    if (!theme || typeof theme !== "object") return;
    const style = document.documentElement.style;
    for (const key of ["surface", "ink", "ink2", "line", "hover", "accent"]) {
      if (typeof theme[key] === "string" && theme[key].length <= 128) style.setProperty("--" + key, theme[key]);
    }
    style.colorScheme = theme.scheme === "dark" ? "dark" : "light";
  };
  window.browserTheme(config.theme);
  const $ = (id) => document.getElementById(id);
  const stage = $("stage"),
    image = $("frame"),
    commentPin = $("comment-pin"),
    message = $("message"),
    live = $("live"),
    keys = $("keys");
  const back = $("back"),
    forward = $("forward"),
    reload = $("reload"),
    keyboard = $("keyboard"),
    control = $("control"),
    retry = $("retry");
  let nextId = 0,
    epoch = 0,
    viewerId = null,
    status = null,
    queue = null,
    sequence = 0,
    shown = null,
    page = "";
  let heartbeat = null,
    deadline = null,
    active = false,
    claiming = false,
    mouse = null,
    sentSize = "",
    sizeTimer = null,
    poll = null;
  const pending = new Map(),
    heldKeys = new Set();
  const post = (data) => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- the srcdoc parent has an opaque origin, same as the simulator receiver
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(data));
    else window.parent.postMessage(data, "*");
  };
  const rpc = (method, args) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = method === "open" ? 25000 : 12000;
      const timer = setTimeout(() => {
        pending.delete(id);
        if (method === "open") post({ channel: "milagre-browser", id, event: "cancel" });
        reject(new Error("The computer did not respond. Check the connection and retry."));
      }, timeout);
      pending.set(id, { resolve, reject, timer, method });
      post({ channel: "milagre-browser", id, method, args });
    });
  window.browserReply = (data) => {
    if (data?.channel !== "milagre-browser") return;
    const item = pending.get(data.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error));
    else item.resolve(data.result);
  };
  window.addEventListener("message", (event) => {
    if (event.source === window.parent) {
      if (event.data?.channel === "milagre-browser-theme") window.browserTheme(event.data.theme);
      else window.browserReply(event.data);
    }
  });
  const geometry = () => geometryFor(shown?.viewport, { width: stage.clientWidth, height: stage.clientHeight });
  let commentPoint = null;
  const layout = () => {
    const g = geometry();
    if (!g) return;
    image.style.left = g.left + "px";
    image.style.top = g.top + "px";
    image.style.width = g.width + "px";
    image.style.height = g.height + "px";
    commentPin.hidden = !commentPoint;
    if (commentPoint) {
      commentPin.style.left = g.left + commentPoint.x * g.width + "px";
      commentPin.style.top = g.top + commentPoint.y * g.height + "px";
    }
  };
  window.browserCommentPoint = (point) => {
    commentPoint = point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1 ? point : null;
    commentPin.hidden = !commentPoint;
    layout();
  };
  // The page lays out at the stage's size while this viewer controls it, whatever size its own window is.
  const sendSize = () => {
    // Older hosts reject unknown input events and may outlive an OTA update of the viewer.
    // Without an explicit capability, keep their existing viewport and letterboxed input mapping.
    if (!canInput() || status.supportsViewport !== true) return;
    const width = Math.min(4096, Math.round(stage.clientWidth)),
      height = Math.min(4096, Math.round(stage.clientHeight));
    if (width < 100 || height < 100 || width + "x" + height === sentSize) return;
    sentSize = width + "x" + height;
    queue.push({ kind: "viewport", width, height });
  };
  new ResizeObserver(() => {
    layout();
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(sendSize, 150);
  }).observe(stage);
  const say = (text) => {
    message.textContent = text;
    message.hidden = !text;
  };
  const render = () => {
    const ready = active && !!shown && !!status?.ready;
    const controlling = ready && !!status.controlling;
    back.disabled = !(controlling && status.canGoBack);
    forward.disabled = !(controlling && status.canGoForward);
    reload.disabled = keyboard.disabled = !controlling;
    control.hidden = !active || !!status?.controlling;
    control.disabled = !ready || claiming;
    image.hidden = !shown;
    if (active) {
      if (!shown) say("Connecting to the page...");
      else say("");
      live.textContent = !ready ? "Connecting to the page" : controlling ? "You control this page" : "View only. Take control to interact.";
    }
    if (ready) {
      clearTimeout(deadline);
      deadline = null;
    }
    if (!sentSize) sendSize();
    const next = status ? status.title + "\n" + status.url : "";
    if (next !== page) {
      page = next;
      if (status) post({ channel: "milagre-browser", event: "page", title: status.title, url: status.url });
    }
    layout();
  };
  const releaseInput = () => {
    if (queue) {
      if (mouse) queue.push({ kind: "mouse", phase: "up", ...mouse });
      for (const key of heldKeys) queue.push({ kind: "key", phase: "up", ...JSON.parse(key) });
    }
    mouse = null;
    heldKeys.clear();
    gesture.cancel();
  };
  const clearInput = () => {
    queue?.dispose();
    queue = null;
    sentSize = "";
    mouse = null;
    heldKeys.clear();
    gesture.cancel();
  };
  const stop = () => {
    epoch++;
    active = false;
    clearInput();
    clearInterval(heartbeat);
    clearTimeout(deadline);
    clearTimeout(sizeTimer);
    heartbeat = deadline = poll = null;
    const old = viewerId;
    viewerId = null;
    status = null;
    shown = null;
    image.removeAttribute("src");
    const closing = old ? rpc("close", { viewerId: old }).catch(() => {}) : Promise.resolve();
    for (const [id, item] of pending) {
      if (item.method === "close") continue;
      if (item.method === "open") post({ channel: "milagre-browser", id, event: "cancel" });
      clearTimeout(item.timer);
      item.reject(new Error("Viewer closed."));
      pending.delete(id);
    }
    render();
    return closing;
  };
  const fail = (error) => {
    stop();
    say(error?.message || "The browser connection was lost. Retry to reconnect.");
    retry.title = message.textContent + " Retry";
    retry.hidden = false;
    live.textContent = message.textContent;
  };
  const acceptStatus = (value) => {
    if (status && status.generation > value.generation) return;
    if (status && (status.generation !== value.generation || status.controlling !== value.controlling)) clearInput();
    status = value;
    if (status.controlling && !queue) {
      const currentViewer = viewerId,
        generation = status.generation,
        currentEpoch = epoch;
      queue = inputQueue(
        async (event) => {
          const result = await rpc("input", { viewerId: currentViewer, sequence: ++sequence, generation, event });
          if (currentEpoch !== epoch) return;
          if (!result.accepted) {
            clearInput();
            const value = await rpc("status", { viewerId: currentViewer });
            if (currentEpoch === epoch) acceptStatus(value);
          }
        },
        (error) => {
          if (currentEpoch === epoch) fail(error);
        },
      );
    }
    render();
  };
  const claim = async (takeOver) => {
    const currentEpoch = epoch;
    claiming = true;
    render();
    try {
      const value = await rpc("control", { viewerId, takeOver });
      if (active && currentEpoch === epoch) acceptStatus(value);
    } catch (error) {
      if (active && currentEpoch === epoch) fail(error);
    } finally {
      if (currentEpoch === epoch) {
        claiming = false;
        render();
      }
    }
  };
  const canInput = () => active && !!shown && !!status?.ready && !!status.controlling && !!queue;
  const push = (event) => {
    if (canInput()) queue.push(event);
  };
  const modifiers = (event) => (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  const local = (event) => {
    const rect = stage.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  control.addEventListener("click", () => {
    void claim(true);
  });
  back.addEventListener("click", () => push({ kind: "navigate", action: "back" }));
  forward.addEventListener("click", () => push({ kind: "navigate", action: "forward" }));
  reload.addEventListener("click", () => push({ kind: "navigate", action: "reload" }));
  keyboard.addEventListener("click", () => {
    if (document.activeElement === keys) keys.blur();
    else keys.focus({ preventScroll: true });
  });
  const gesture = touchGesture(
    {
      tap: (point) => {
        push({ kind: "mouse", phase: "down", ...point, button: "left", clickCount: 1 });
        push({ kind: "mouse", phase: "up", ...point, button: "left", clickCount: 1 });
      },
      // Content follows the finger, so scroll by the finger's travel in page pixels.
      scroll: (dx, dy, point) => {
        const g = geometry();
        if (g) push({ kind: "wheel", ...point, deltaX: -dx / g.scale, deltaY: -dy / g.scale });
      },
      pressStart: (point) => {
        if (!canInput()) return;
        mouse = { ...point, button: "left", clickCount: 1 };
        queue.push({ kind: "mouse", phase: "down", ...mouse });
      },
      pressMove: (point) => {
        if (mouse) {
          mouse = { ...mouse, ...point };
          push({ kind: "mouse", phase: "move", ...point, button: "left" });
        }
      },
      pressEnd: (point) => {
        if (mouse) {
          push({ kind: "mouse", phase: "up", ...mouse, ...point });
          mouse = null;
        }
      },
    },
    { setTimeout, clearTimeout },
  );
  const buttons = ["left", "middle", "right"];
  stage.addEventListener("pointerdown", (event) => {
    if (!canInput() || event.button > 2) return;
    const point = pointFor(local(event), geometry());
    if (!point) return;
    event.preventDefault();
    stage.setPointerCapture(event.pointerId);
    if (event.pointerType === "mouse") {
      // Typing goes to the page after clicking it, as in a local browser.
      keys.focus({ preventScroll: true });
      if (mouse) return;
      mouse = {
        ...point,
        button: buttons[event.button],
        clickCount: Math.min(3, Math.max(1, event.detail || 1)),
        ...(modifiers(event) ? { modifiers: modifiers(event) } : {}),
      };
      queue.push({ kind: "mouse", phase: "down", ...mouse });
    } else gesture.begin(event.pointerId, local(event), point);
  });
  stage.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse") {
      if (!canInput()) return;
      const point = pointFor(local(event), geometry(), !!mouse);
      if (!point) return;
      if (mouse) mouse = { ...mouse, ...point };
      queue.push({ kind: "mouse", phase: "move", ...point, button: "none" });
    } else gesture.move(event.pointerId, local(event), pointFor(local(event), geometry(), true));
  });
  stage.addEventListener("pointerup", (event) => {
    if (event.pointerType === "mouse") {
      if (!mouse) return;
      const point = pointFor(local(event), geometry(), true) || mouse;
      push({ kind: "mouse", phase: "up", ...mouse, x: point.x, y: point.y });
      mouse = null;
    } else gesture.end(event.pointerId, pointFor(local(event), geometry(), true));
  });
  const cancelPointer = () => {
    if (mouse && !gesture.active) {
      push({ kind: "mouse", phase: "up", ...mouse });
      mouse = null;
    }
    gesture.cancel();
  };
  stage.addEventListener("pointercancel", cancelPointer);
  stage.addEventListener("lostpointercapture", cancelPointer);
  stage.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const point = pointFor(local(event), geometry());
      if (!point) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
      const clamp = (value) => Math.max(-10000, Math.min(10000, value * unit));
      push({ kind: "wheel", ...point, deltaX: clamp(event.deltaX), deltaY: clamp(event.deltaY), ...(modifiers(event) ? { modifiers: modifiers(event) } : {}) });
    },
    { passive: false },
  );
  stage.addEventListener("contextmenu", (event) => event.preventDefault());
  // A hidden field receives the keyboard: real key events for keys, inserted text for IME, dictation and predictions.
  const sendKey = (key) => {
    push({ kind: "key", phase: "down", ...key });
    push({ kind: "key", phase: "up", key: key.key, code: key.code, keyCode: key.keyCode });
  };
  keys.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !canInput()) {
      post({ channel: "milagre-browser", event: "close" });
      return;
    }
    if (!canInput() || event.isComposing) return;
    const key = keyFor(event);
    if (!key) return;
    event.preventDefault();
    const held = JSON.stringify({ key: key.key, code: key.code, keyCode: key.keyCode });
    if (event.repeat && heldKeys.has(held)) {
      push({ kind: "key", phase: "down", ...key });
      return;
    }
    heldKeys.add(held);
    push({ kind: "key", phase: "down", ...key });
  });
  keys.addEventListener("keyup", (event) => {
    const key = keyFor(event);
    if (!key) return;
    const held = JSON.stringify({ key: key.key, code: key.code, keyCode: key.keyCode });
    if (heldKeys.delete(held)) push({ kind: "key", phase: "up", ...JSON.parse(held) });
  });
  keys.addEventListener("beforeinput", (event) => {
    if (!canInput() || event.inputType === "insertCompositionText") return;
    const text = event.data ?? event.dataTransfer?.getData?.("text/plain") ?? "";
    const named = {
      insertLineBreak: ["Enter", 13, "\r"],
      insertParagraph: ["Enter", 13, "\r"],
      deleteContentBackward: ["Backspace", 8],
      deleteContentForward: ["Delete", 46],
    }[event.inputType];
    event.preventDefault();
    if (named) sendKey({ key: named[0], code: named[0], keyCode: named[1], ...(named[2] ? { text: named[2] } : {}) });
    else if (text) for (let index = 0; index < text.length; index += 1024) push({ kind: "text", text: text.slice(index, index + 1024) });
  });
  let composing = false;
  keys.addEventListener("compositionstart", () => {
    composing = true;
  });
  keys.addEventListener("compositionend", (event) => {
    composing = false;
    if (event.data) push({ kind: "text", text: event.data.slice(0, 1024) });
    keys.value = "";
  });
  // Fallback for text a platform inserted without a cancelable beforeinput.
  keys.addEventListener("input", () => {
    if (composing || !keys.value) return;
    push({ kind: "text", text: keys.value.slice(0, 1024) });
    keys.value = "";
  });
  keys.addEventListener("blur", releaseInput);
  window.addEventListener("blur", releaseInput);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && event.target !== keys) post({ channel: "milagre-browser", event: "close" });
  });
  const pull = async (currentEpoch) => {
    let after = 0;
    // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- stop() bumps `epoch` from another closure while the loop awaits the next frame
    while (currentEpoch === epoch) {
      const frame = await rpc("frame", { viewerId, after });
      if (currentEpoch !== epoch) return;
      if (!frame) continue;
      after = frame.sequence;
      image.src = frame.uri || "data:image/jpeg;base64," + frame.data;
      try {
        await image.decode();
      } catch {
        /* A frame replaced mid-decode is followed by the next one. */
      }
      if (currentEpoch !== epoch) return;
      if (shown && (shown.viewport.width !== frame.viewport.width || shown.viewport.height !== frame.viewport.height)) releaseInput();
      shown = { viewport: frame.viewport, generation: frame.generation };
      render();
      // A resized page (often by this viewer's own size) refuses input sent for the old one: catch up now, not at the next poll.
      if (status && frame.generation > status.generation) void poll?.();
    }
  };
  const start = async () => {
    const closing = stop();
    active = true;
    claiming = false;
    sequence = 0;
    const currentEpoch = epoch;
    retry.hidden = true;
    render();
    deadline = setTimeout(() => {
      if (currentEpoch === epoch) fail(new Error("The page did not show. Check that the browser is still open, then retry."));
    }, 30000);
    try {
      await closing;
      if (currentEpoch !== epoch) return;
      const opened = await rpc("open", { chatId: config.chatId, targetId: config.targetId });
      if (currentEpoch !== epoch) {
        void rpc("close", { viewerId: opened.viewerId }).catch(() => {});
        return;
      }
      viewerId = opened.viewerId;
      let polling = false,
        triedControl = false;
      poll = async () => {
        if (polling || currentEpoch !== epoch) return;
        polling = true;
        try {
          const value = await rpc("status", { viewerId });
          if (currentEpoch !== epoch) return;
          acceptStatus(value);
          if (value.ready && !triedControl) {
            triedControl = true;
            await claim(false);
          }
        } catch (error) {
          if (currentEpoch === epoch) fail(error);
        } finally {
          polling = false;
        }
      };
      await poll();
      if (currentEpoch !== epoch || !active) return;
      heartbeat = setInterval(poll, 1000);
      void pull(currentEpoch).catch((error) => {
        if (currentEpoch === epoch) fail(error);
      });
    } catch (error) {
      if (currentEpoch === epoch) fail(error);
    }
  };
  retry.addEventListener("click", () => {
    void start();
  });
  window.browserDispose = stop;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
      say("Viewer paused while hidden.");
      retry.hidden = false;
    }
  });
  window.addEventListener("pagehide", stop);
  void start();
}

/** Build-time only. A checked-in string keeps script bytes stable across Vite/Metro minification and CSP hashing. */
export function buildBrowserReceiverScript() {
  return `(${receiver.toString()})(JSON.parse(document.getElementById('config').dataset.config),${browserGeometry.toString()},${browserPoint.toString()},${createBrowserInputQueue.toString()},${createTouchGesture.toString()},${browserKey.toString()});`;
}

const icon = (path) => `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
const button = (id, label, path, extra = "") => `<button id="${id}" aria-label="${label}" title="${label}"${extra}>${icon(path)}</button>`;

/** No hosted asset or native resource: this string travels inside desktop and OTA JS bundles. */
export function createBrowserReceiverHtml(config) {
  const escaped = JSON.stringify(config).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>
:root{--surface:#ffffff;--ink:#1f2124;--ink2:#62656b;--line:#ecedef;--hover:#f4f5f6;--accent:#0285ff}*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font:13px -apple-system,BlinkMacSystemFont,sans-serif;background:var(--surface);color:var(--ink);display:flex;flex-direction:column;color-scheme:inherit}#stage{position:relative;min-height:0;flex:1;background:var(--surface);touch-action:none;user-select:none;-webkit-user-select:none;overflow:hidden;outline:none}#frame{position:absolute;pointer-events:none;-webkit-user-drag:none}#frame[hidden]{display:none}#comment-pin{position:absolute;width:24px;height:24px;transform:translateY(-100%);border-radius:12px 12px 12px 0;background:var(--accent);color:white;box-shadow:0 0 0 2px white,0 2px 5px #0004;text-align:center;font:600 12px/24px -apple-system,system-ui,sans-serif;pointer-events:none}#comment-pin[hidden]{display:none}#message{position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;color:var(--ink2);line-height:1.4}#message[hidden]{display:none}#keys{position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:0;border:0;padding:0;resize:none;font-size:16px;caret-color:transparent}#live{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}footer{padding:6px 12px;flex-shrink:0;border-top:1px solid var(--line);background:var(--surface)}nav{display:flex;gap:8px;align-items:center;justify-content:center}button{display:grid;place-items:center;width:44px;height:44px;padding:0;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--ink2);cursor:pointer}button:hover:not(:disabled){background:var(--hover);color:var(--ink)}button:disabled{opacity:.3;cursor:default}button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}button[hidden]{display:none}button svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
</style></head><body><div id="config" hidden data-config="${escaped}"></div><div id="stage" aria-label="Browser page"><img id="frame" alt="" hidden draggable="false"><div id="comment-pin" aria-label="Comment pin" hidden>1</div><div id="message" role="status">Connecting to the page...</div><textarea id="keys" aria-label="Type into the page" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go"></textarea></div><footer><p id="live" aria-live="polite"></p><nav aria-label="Browser controls">${button("back", "Back", '<path d="m14 5-7 7 7 7"/>', " disabled")}${button("forward", "Forward", '<path d="m10 5 7 7-7 7"/>', " disabled")}${button("reload", "Reload", '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>', " disabled")}${button("keyboard", "Keyboard", '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8"/>', " disabled")}${button("control", "Take control. The agent can still use this page.", '<path d="M8 13V6a2 2 0 0 1 4 0v6-2a2 2 0 0 1 4 0v2a2 2 0 0 1 4 0v4c0 4-3 6-6 6h-1c-2 0-3-1-4-2l-5-6a2 2 0 0 1 3-2l1 1Z"/>', " hidden disabled")}${button("retry", "Retry", '<path d="M20 7v5h-5m5 0a8 8 0 1 0-2 6"/>', " hidden")}</nav></footer><script>${BROWSER_RECEIVER_SCRIPT}</script></body></html>`;
}
