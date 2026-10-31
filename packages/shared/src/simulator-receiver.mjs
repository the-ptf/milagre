import { SIMULATOR_RECEIVER_SCRIPT } from "./simulator-browser.mjs";
import { avcCodecString, avccEnvelopes, simulatorAvcConfig } from "./simulator-avc.mjs";
export { SIMULATOR_RECEIVER_SCRIPT } from "./simulator-browser.mjs";

export const SIMULATOR_CONNECTION_LABELS = {
  connecting: "Connecting",
  live: "Live",
  "view-only": "View only",
  rotating: "Changing display",
  blocked: "Input blocked",
  paused: "Paused",
  error: "Disconnected",
};

/** Geometry follows Device Hub's raw portrait capture orientation, including already-rotated buffers. */
export function simulatorGeometry(status, box, inset = 0) {
  if (!status || status.width <= 0 || status.height <= 0 || box.width <= inset * 2 || box.height <= inset * 2) return null;
  const degrees =
    {
      "landscape-left": 90,
      "landscape-right": -90,
      "portrait-upside-down": 180,
    }[status.orientation] || 0;
  const rotation = Math.abs(degrees) === 90 && status.width > status.height ? 0 : degrees;
  const sideways = Math.abs(rotation) === 90;
  const width = sideways ? status.height : status.width;
  const height = sideways ? status.width : status.height;
  const scale = Math.min((box.width - inset * 2) / width, (box.height - inset * 2) / height);
  return {
    left: (box.width - width * scale) / 2,
    top: (box.height - height * scale) / 2,
    width: width * scale,
    height: height * scale,
    rawWidth: status.width * scale,
    rawHeight: status.height * scale,
    rotation,
  };
}

/** Unknown models keep their screen intact. A custom simulator name cannot override a known model. */
export function simulatorAppearance(device) {
  const model = String(device?.deviceType || device?.name || "").replaceAll(/[-_]/g, " ");
  if (device?.platform === "android")
    return {
      cutout: !/\bFold\b/i.test(model) && /pixel\s*(?:[6-9]|\d{2})a?\b/i.test(model) ? "camera" : "none",
      radius: 0.09,
    };
  if (/iPad/i.test(model)) return { cutout: "none", radius: 0.045 };
  if (/iPhone\s*SE/i.test(model)) return { cutout: "none", radius: 0.025 };
  const phone = /iPhone\s*(\d+)(e)?(?:\s|$)/i.exec(model);
  if (phone) {
    const generation = Number(phone[1]);
    const island = !phone[2] && (generation >= 15 || (generation === 14 && /\bPro\b/i.test(model)));
    return {
      cutout: island ? "island" : generation >= 11 ? "notch" : "none",
      radius: generation >= 11 ? 0.14 : 0.025,
    };
  }
  if (/iPhone\s*X(?:R|S)?\b/i.test(model)) return { cutout: "notch", radius: 0.12 };
  if (/iPhone\s*Air\b/i.test(model)) return { cutout: "island", radius: 0.14 };
  return { cutout: "none", radius: 0.09 };
}

/** Coordinates are relative to the stage; outside starts are ignored, captured drags clamp at the edge. */
export function simulatorPoint(point, geometry, clamp = false, radius = 0) {
  if (!geometry) return null;
  let x = (point.x - geometry.left) / geometry.width,
    y = (point.y - geometry.top) / geometry.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (!clamp && (x < 0 || x > 1 || y < 0 || y > 1))) return null;
  if (!clamp && radius > 0) {
    const r = Math.min(radius, geometry.width / 2, geometry.height / 2),
      px = x * geometry.width,
      py = y * geometry.height,
      cx = Math.max(r, Math.min(geometry.width - r, px)),
      cy = Math.max(r, Math.min(geometry.height - r, py));
    if ((px - cx) ** 2 + (py - cy) ** 2 > r ** 2) return null;
  }
  x = Math.max(0, Math.min(1, x));
  y = Math.max(0, Math.min(1, y));
  switch (geometry.rotation) {
    case 90:
      return { x: y, y: 1 - x };
    case -90:
      return { x: 1 - y, y: x };
    case 180:
      return { x: 1 - x, y: 1 - y };
    default:
      return { x, y };
  }
}

/** One RPC at a time. Replace only consecutive moves, never a gesture boundary. Overflow ends the session. */
export function createSimulatorInputQueue(send, failed, limit = 32) {
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
      if (
        event.kind === "touch" &&
        event.phase === "move" &&
        previous?.kind === "touch" &&
        previous.phase === "move" &&
        previous.points.length === event.points.length
      )
        queue[queue.length - 1] = event;
      else if (queue.length >= limit) {
        disposed = true;
        queue = [];
        failed(new Error("Connection is too slow for input. Retry the simulator."));
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

/** The wrapper is capability-scoped too: a receiver cannot address another viewer or call arbitrary RPC. */
export function createSimulatorBridge(call, respond, transform = (_method, result) => result) {
  const viewers = new Set();
  const openings = new Map();
  let disposed = false;
  const close = (viewerId) =>
    Promise.resolve()
      .then(() => call("close", { viewerId }))
      .catch(() => {});
  return {
    async receive(message) {
      if (disposed || !message || message.channel !== "milagre-simulator" || !Number.isSafeInteger(message.id)) return;
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
        if (!disposed) respond({ channel: "milagre-simulator", id, ...value });
      };
      try {
        if (!["open", "offer", "frame", "status", "control", "input", "repair", "close"].includes(method)) throw new Error("Unknown simulator command.");
        if (!args || typeof args !== "object") throw new Error("Invalid simulator request.");
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
          if (!viewers.has(args.viewerId)) throw new Error("This simulator viewer is closed.");
          // Keep ownership until close finishes, so disposal can still close an in-flight request.
          let result;
          try {
            result = await call(method, args);
          } finally {
            // A network failure must not bind Retry to a dead capability. The host also expires disconnected viewers.
            if (method === "close") {
              viewers.delete(args.viewerId);
              for (const [requestId, item] of openings) if (item.viewerId === args.viewerId) openings.delete(requestId);
            }
          }
          if (!disposed) reply({ result: transform(method, result) });
        }
      } catch (error) {
        reply({ error: error instanceof Error ? error.message : "Simulator request failed." });
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
function receiver(config, geometryFor, pointFor, inputQueue, appearanceFor, codecFor, avcConfigFor, envelopesFor) {
  window.simulatorTheme = (theme) => {
    if (!theme || typeof theme !== "object") return;
    const style = document.documentElement.style;
    for (const key of ["surface", "ink", "ink2", "line", "hover", "accent", "green"]) {
      if (typeof theme[key] === "string" && theme[key].length <= 128) style.setProperty("--" + key, theme[key]);
    }
    style.colorScheme = theme.scheme === "dark" ? "dark" : "light";
  };
  window.simulatorTheme(config.theme);
  document.documentElement.dataset.touchControls = String(!!config.touchControls);
  const stage = document.getElementById("stage"),
    video = document.getElementById("video"),
    image = document.getElementById("image"),
    canvas = document.getElementById("canvas");
  const deviceFrame = document.getElementById("device"),
    screen = document.getElementById("screen"),
    waiting = document.getElementById("waiting");
  const message = document.getElementById("message"),
    retry = document.getElementById("retry");
  const failure = document.getElementById("failure");
  const back = document.getElementById("back");
  const control = document.getElementById("control"),
    home = document.getElementById("home"),
    rotate = document.getElementById("rotate");
  const blocked = document.getElementById("blocked"),
    blockedText = document.getElementById("blocked-text"),
    repair = document.getElementById("repair");
  const more = document.getElementById("more"),
    extras = document.getElementById("extras"),
    hinge = document.getElementById("hinge");
  extras.hidden = true;
  more.addEventListener("click", () => {
    extras.hidden = !extras.hidden;
    more.setAttribute("aria-expanded", String(!extras.hidden));
    render();
  });
  const duo = document.getElementById("duo"),
    hingeAngle = document.getElementById("hinge-angle"),
    hingeApply = document.getElementById("hinge-apply");
  const poses = ["closed", "open", "book", "laptop", "tent"].map((pose) => [pose, document.getElementById("pose-" + pose)]);
  let hingeDraft = false;
  hingeAngle.addEventListener("input", () => {
    hingeDraft = true;
  });
  back.hidden = config.device?.platform !== "android";
  let nextId = 0,
    epoch = 0,
    viewerId = null,
    peer = null,
    status = null,
    queue = null,
    sequence = 0;
  let reconnectTimer = null,
    reconnectAttempts = 0,
    disposed = false,
    relaying = false,
    paintedGeneration = null,
    frameTimer = null,
    cancelImage = null,
    decoder = null,
    decoding = false,
    decodeStatus = null,
    needKeyframe = true,
    decodeTime = 0;
  let heartbeat = null,
    deadline = null,
    disconnected = null,
    rotationTimer = null,
    rotatingGeneration = null,
    frames = false,
    active = false,
    stopped = false,
    claiming = false,
    repairing = false,
    confirmRepair = null,
    device = config.device,
    lastCapture = null,
    connectionState = null;
  const pending = new Map(),
    pointers = new Map();
  const post = (data) => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- flagged for review, see PR body
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(data));
    else window.parent.postMessage(data, "*");
  };
  const reportState = (state) => {
    if (connectionState === state) return;
    connectionState = state;
    post({ channel: "milagre-simulator", event: "state", state });
  };
  const rpc = (method, args) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      // Helper startup and the host's bounded 20-second offer may run slowly on a busy Mac.
      const timeout = method === "open" || method === "offer" || method === "repair" ? 25000 : 12000;
      const timer = setTimeout(() => {
        pending.delete(id);
        if (method === "open") post({ channel: "milagre-simulator", id, event: "cancel" });
        reject(new Error("The Mac did not respond. Check the connection and retry."));
      }, timeout);
      pending.set(id, { resolve, reject, timer, method });
      post({ channel: "milagre-simulator", id, method, args });
    });
  window.simulatorReply = (data) => {
    if (data?.channel !== "milagre-simulator") return;
    const item = pending.get(data.id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error));
    else item.resolve(data.result);
  };
  window.addEventListener("message", (event) => {
    if (event.source === window.parent) {
      if (event.data?.channel === "milagre-simulator-theme") window.simulatorTheme(event.data.theme);
      else window.simulatorReply(event.data);
    }
  });
  const capture = () => (status?.width > 0 && status?.height > 0 ? status : lastCapture || { width: 390, height: 844, orientation: "portrait" });
  // The same inset geometry lays out the screen and maps touches. The bezel stays outside it.
  const geometry = () => geometryFor(capture(), { width: stage.clientWidth, height: stage.clientHeight }, 24);
  const layout = () => {
    const g = geometry();
    deviceFrame.hidden = !g;
    if (!g) return;
    const appearance = appearanceFor(device),
      short = Math.min(g.width, g.height),
      bezel = Math.min(8, short * 0.025),
      radius = short * appearance.radius;
    // Hardware cutouts belong to the captured pixels. A second mask can drift or cover expanded Island content.
    deviceFrame.dataset.cutout = "stream";
    deviceFrame.dataset.sideways = String(g.width > g.height);
    deviceFrame.style.left = g.left - bezel + "px";
    deviceFrame.style.top = g.top - bezel + "px";
    deviceFrame.style.width = g.width + bezel * 2 + "px";
    deviceFrame.style.height = g.height + bezel * 2 + "px";
    deviceFrame.style.setProperty("--bezel", bezel + "px");
    deviceFrame.style.borderRadius = radius + bezel + "px";
    screen.style.borderRadius = radius + "px";
    for (const media of [video, image, canvas]) {
      media.style.width = g.rawWidth + "px";
      media.style.height = g.rawHeight + "px";
      media.style.transform = "translate(-50%,-50%) rotate(" + g.rotation + "deg)";
    }
  };
  new ResizeObserver(layout).observe(stage);
  const resetRepair = () => {
    clearTimeout(confirmRepair);
    confirmRepair = null;
    blockedText.textContent = "If touches don't respond, reset input.";
    repair.textContent = "Reset input";
    repair.disabled = repairing || !active || !frames || !status?.ready || !status.controlling;
    if (!status?.deviceHubInputActive && !status?.inputBlocked) blocked.hidden = true;
  };
  const displayGeneration = (value) => value?.displayGeneration ?? value?.generation;
  const displayReady = () => active && frames && status?.ready && (!relaying || paintedGeneration === displayGeneration(status));
  const render = (reportConnection = true) => {
    const ready = displayReady() && !repairing;
    // Older hosts named this hint inputBlocked, but neither flag confirms touch delivery failed.
    const inputHint = !!(ready && status.controlling && (status.deviceHubInputActive || status.inputBlocked));
    if (reportConnection)
      reportState(
        !active
          ? connectionState === "error"
            ? "error"
            : "paused"
          : !ready
            ? rotatingGeneration !== null || (frames && relaying && paintedGeneration !== displayGeneration(status))
              ? "rotating"
              : "connecting"
            : status.controlling
              ? "live"
              : "view-only",
      );
    if (!(ready && status.controlling) && confirmRepair) resetRepair();
    blocked.hidden = !(inputHint || confirmRepair || repairing);
    back.disabled = home.disabled = rotate.disabled = !(ready && status.controlling);
    duo.hidden = hinge.hidden = status?.supportsHingeAngle !== true;
    repair.hidden = device?.platform === "android";
    repair.disabled = !(ready && status.controlling) || repairing;
    for (const [pose, button] of poses) {
      button.disabled = !(ready && status.controlling);
      button.setAttribute("aria-pressed", String(status?.hingePose === pose));
    }
    hingeAngle.disabled = hingeApply.disabled = !(ready && status.controlling);
    if (!hingeDraft && document.activeElement !== hingeAngle) hingeAngle.value = Number.isFinite(status?.hingeAngle) ? String(status.hingeAngle) : "";
    control.disabled = !ready || claiming;
    control.hidden = !ready || !!status?.controlling;
    waiting.hidden = frames || !active;
    video.hidden = !frames || relaying;
    image.hidden = !frames || !relaying || decoding;
    canvas.hidden = !frames || !decoding;
    retry.disabled = active && (!frames || rotatingGeneration !== null);
    if (ready) {
      retry.hidden = false;
      retry.title = retry.ariaLabel = "Reconnect";
    }
    if (active)
      message.textContent = !frames
        ? "Connecting video..."
        : !status?.ready
          ? "Preparing simulator input..."
          : status.controlling
            ? "You control this simulator"
            : "View only. Another viewer may control it.";
    if (ready) {
      reconnectAttempts = 0;
      clearTimeout(deadline);
      deadline = null;
    }
    layout();
  };
  const clearInput = () => {
    queue?.dispose();
    queue = null;
    pointers.clear();
  };
  let clearPeerListeners = () => {};
  const stop = (reportConnection = true) => {
    epoch++;
    active = false;
    stopped = true;
    frames = false;
    paintedGeneration = null;
    clearInput();
    clearInterval(heartbeat);
    clearTimeout(frameTimer);
    frameTimer = null;
    cancelImage?.();
    image.removeAttribute("src");
    if (decoder && decoder.state !== "closed") decoder.close();
    decoder = null;
    decoding = false;
    decodeStatus = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearTimeout(deadline);
    clearTimeout(disconnected);
    clearTimeout(rotationTimer);
    heartbeat = deadline = disconnected = rotationTimer = rotatingGeneration = null;
    clearPeerListeners();
    clearPeerListeners = () => {};
    hingeDraft = false;
    if (peer) {
      peer.close();
      peer = null;
    }
    if (video.srcObject) for (const track of video.srcObject.getTracks()) track.stop();
    video.srcObject = null;
    const old = viewerId;
    viewerId = null;
    status = null;
    const closing = old ? rpc("close", { viewerId: old }).catch(() => {}) : Promise.resolve();
    for (const [id, item] of pending) {
      if (item.method === "close") continue;
      if (item.method === "open") post({ channel: "milagre-simulator", id, event: "cancel" });
      clearTimeout(item.timer);
      item.reject(new Error("Viewer closed."));
      pending.delete(id);
    }
    render(reportConnection);
    return closing;
  };
  const fail = (error) => {
    stop(false);
    reportState("error");
    message.textContent = error?.message || "Simulator connection lost. Retry to reconnect.";
    failure.textContent = message.textContent;
    failure.hidden = false;
    retry.title = message.textContent + " Retry";
    retry.ariaLabel = "Retry";
    retry.hidden = false;
    extras.hidden = false;
    more.setAttribute("aria-expanded", "true");
    // Reopen with fresh ownership and ICE candidates after a network or host interruption.
    // Bound retries so a stopped simulator cannot churn capture forever.
    if (!disposed && !document.hidden && reconnectAttempts < 5) {
      const delay = Math.min(1000 * 2 ** reconnectAttempts++, 15000);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void start();
      }, delay);
    }
  };
  const acceptStatus = (value) => {
    if (status && status.generation > value.generation) return;
    if (rotatingGeneration !== null) {
      if (value.generation === rotatingGeneration || !value.ready) value = { ...value, ready: false };
      else {
        rotatingGeneration = null;
        clearTimeout(rotationTimer);
        rotationTimer = null;
      }
    }
    if (status && (status.generation !== value.generation || status.controlling !== value.controlling)) clearInput();
    status = value;
    if (value.width > 0 && value.height > 0) lastCapture = value;
    if (status.controlling && !queue) {
      const currentViewer = viewerId,
        generation = status.generation,
        currentEpoch = epoch;
      queue = inputQueue(
        async (event) => {
          const result = await rpc("input", {
            viewerId: currentViewer,
            sequence: ++sequence,
            generation,
            event,
          });
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
  control.addEventListener("click", () => {
    void claim(true);
  });
  // Restarting the simulator's input closes its apps, so the first tap only says so.
  repair.addEventListener("click", async () => {
    if (repairing || !viewerId || !displayReady() || !status.controlling) return;
    if (!confirmRepair) {
      blockedText.textContent = "Resetting input restarts the simulator's home screen and closes its apps.";
      repair.textContent = "Restart";
      blocked.hidden = false;
      confirmRepair = setTimeout(resetRepair, 6000);
      return;
    }
    const currentEpoch = epoch;
    repairing = true;
    resetRepair();
    repair.textContent = "Restarting...";
    // The host drops this viewer while it repairs, so no poll or input may use it in the meantime.
    clearInterval(heartbeat);
    heartbeat = null;
    clearTimeout(frameTimer);
    frameTimer = null;
    cancelImage?.();
    clearTimeout(disconnected);
    disconnected = null;
    clearInput();
    render();
    try {
      await rpc("repair", { viewerId });
      if (currentEpoch === epoch) void start();
    } catch (error) {
      if (currentEpoch === epoch) fail(error);
    } finally {
      repairing = false;
      resetRepair();
    }
  });
  back.addEventListener("click", () => queue?.push({ kind: "button", button: "back" }));
  home.addEventListener("click", () => queue?.push({ kind: "button", button: "home" }));
  const changeGeometry = (event) => {
    if (!queue || pointers.size || !displayReady() || repairing || !status.controlling) return;
    rotatingGeneration = status.generation;
    const currentEpoch = epoch;
    rotationTimer = setTimeout(() => {
      if (currentEpoch === epoch) fail(new Error("The simulator did not finish changing its display. Retry to reconnect."));
    }, 8000);
    queue.push(event);
    // Wait for the new generation before accepting touches in the old geometry.
    back.disabled = home.disabled = rotate.disabled = true;
    status.ready = false;
    render();
    return true;
  };
  rotate.addEventListener("click", () => {
    if (!status) return;
    // iPhones do not support upside-down portrait. Always offer a usable next orientation.
    changeGeometry({ kind: "rotate", orientation: status.orientation.startsWith("landscape") ? "portrait" : "landscape-left" });
  });
  for (const [pose, button] of poses)
    button.addEventListener("click", () => {
      if (status?.supportsHingeAngle && changeGeometry({ kind: "pose", pose })) hingeDraft = false;
    });
  const applyHinge = () => {
    const angle = Number(hingeAngle.value);
    if (status?.supportsHingeAngle && hingeAngle.value.trim() && Number.isFinite(angle) && angle >= 0 && angle <= 180)
      if (changeGeometry({ kind: "hinge", angle })) hingeDraft = false;
  };
  hingeApply.addEventListener("click", applyHinge);
  hingeAngle.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      applyHinge();
    }
  });
  const sendTouch = (phase) => {
    if (pointers.size && queue)
      queue.push({
        kind: "touch",
        phase,
        points: Array.from(pointers.values()),
      });
  };
  stage.addEventListener("pointerdown", (event) => {
    if (!displayReady() || repairing || !status?.controlling || pointers.size >= 2 || event.button > 0) return;
    const rect = stage.getBoundingClientRect();
    const g = geometry();
    if (!g) return;
    const point = pointFor({ x: event.clientX - rect.left, y: event.clientY - rect.top }, g, false, Math.min(g.width, g.height) * appearanceFor(device).radius);
    if (!point) return;
    event.preventDefault();
    stage.setPointerCapture(event.pointerId);
    // Device Hub starts a gesture with its entire contact set. End/rebegin when adding a second contact.
    if (pointers.size) sendTouch("end");
    pointers.set(event.pointerId, point);
    sendTouch("begin");
  });
  stage.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    const point = pointFor({ x: event.clientX - rect.left, y: event.clientY - rect.top }, geometry(), true);
    if (point) {
      pointers.set(event.pointerId, point);
      sendTouch("move");
    }
  });
  const release = (event) => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    sendTouch("end");
    pointers.delete(event.pointerId);
    if (pointers.size) sendTouch("begin");
  };
  const cancelTouches = () => {
    sendTouch("end");
    pointers.clear();
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", cancelTouches);
  stage.addEventListener("lostpointercapture", (event) => {
    if (pointers.has(event.pointerId)) cancelTouches();
  });
  window.addEventListener("blur", () => {
    sendTouch("end");
    pointers.clear();
  });
  stage.addEventListener("contextmenu", (event) => event.preventDefault());
  // Simlock leases relay H.264 as serve-sim envelopes: 1 decoder configuration, 2 keyframe, 3 delta.
  const decodeVideo = async (frame, currentEpoch) => {
    if (typeof VideoDecoder !== "function" || typeof EncodedVideoChunk !== "function")
      throw new Error("This viewer cannot decode simulator video. Update the app, or watch from the Milagre desktop app.");
    decoding = true;
    decodeStatus = frame.status;
    for (const { tag, payload } of envelopesFor(frame.data)) {
      if (currentEpoch !== epoch) return;
      if (tag === 1) {
        const settings = { codec: codecFor(payload), description: avcConfigFor(payload), optimizeForLatency: true };
        const support = await VideoDecoder.isConfigSupported(settings).catch(() => null);
        if (currentEpoch !== epoch) return;
        if (!support?.supported) throw new Error("This viewer cannot decode the simulator's " + settings.codec + " video.");
        if (decoder && decoder.state !== "closed") decoder.close();
        const context = canvas.getContext("2d");
        const current = (decoder = new VideoDecoder({
          output: (picture) => {
            try {
              if (current !== decoder || currentEpoch !== epoch) return;
              if (canvas.width !== picture.displayWidth || canvas.height !== picture.displayHeight) {
                canvas.width = picture.displayWidth;
                canvas.height = picture.displayHeight;
              }
              context.drawImage(picture, 0, 0, canvas.width, canvas.height);
            } finally {
              picture.close();
            }
            const generation = displayGeneration(decodeStatus);
            if (!frames || paintedGeneration !== generation) {
              frames = true;
              paintedGeneration = generation;
              render();
            }
          },
          error: () => {
            if (current === decoder && currentEpoch === epoch && !repairing) fail(new Error("The simulator video could not be decoded. Retry to reconnect."));
          },
        }));
        current.configure(settings);
        needKeyframe = true;
      } else if (tag === 2 || tag === 3) {
        if (!decoder || decoder.state !== "configured" || (tag === 3 && needKeyframe)) continue;
        if (tag === 2) needKeyframe = false;
        decodeTime += 33333;
        decoder.decode(new EncodedVideoChunk({ type: tag === 2 ? "key" : "delta", timestamp: decodeTime, data: payload }));
      }
    }
  };
  const start = async () => {
    const closing = stop(false);
    stopped = false;
    active = true;
    claiming = false;
    sequence = 0;
    const currentEpoch = epoch;
    retry.hidden = true;
    failure.hidden = true;
    render();
    deadline = setTimeout(() => {
      if (currentEpoch === epoch) fail(new Error("Video or input could not connect. Check that the simulator is running and retry."));
    }, 45000);
    try {
      await closing;
      if (currentEpoch !== epoch) return;
      const opened = await rpc("open", { deviceId: config.deviceId });
      if (currentEpoch !== epoch || stopped) {
        void rpc("close", { viewerId: opened.viewerId }).catch(() => {});
        return;
      }
      device = opened.device || config.device;
      back.hidden = device?.platform !== "android";
      layout();
      viewerId = opened.viewerId;
      let polling = false,
        triedControl = false;
      const poll = async () => {
        if (polling || currentEpoch !== epoch || repairing) return;
        polling = true;
        try {
          const value = await rpc("status", { viewerId });
          if (currentEpoch !== epoch || repairing) return;
          acceptStatus(value);
          if (value.ready && !triedControl) {
            triedControl = true;
            await claim(false);
          }
        } catch (error) {
          if (currentEpoch === epoch && !repairing) fail(error);
        } finally {
          polling = false;
        }
      };
      relaying = opened.transport === "frames";
      if (relaying) {
        let after = 0;
        const pull = async () => {
          if (currentEpoch !== epoch || repairing) return;
          try {
            const frame = await rpc("frame", { viewerId, after });
            if (currentEpoch !== epoch || repairing) return;
            if (frame && frame.mimeType === "video/avcc") {
              if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= after) throw new Error("Invalid simulator frame.");
              if (typeof frame.data !== "string" || frame.data.length > 2796204 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data))
                throw new Error("Invalid simulator video data.");
              await decodeVideo(frame, currentEpoch);
              if (currentEpoch !== epoch || repairing) return;
              after = frame.sequence;
              acceptStatus(frame.status);
              render();
              if (frame.status.ready && !triedControl) {
                triedControl = true;
                await claim(false);
              }
            } else if (frame) {
              if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= after || !["image/jpeg", "image/png"].includes(frame.mimeType))
                throw new Error("Invalid simulator frame.");
              let source;
              if (window.ReactNativeWebView && typeof frame.uri === "string" && frame.uri.startsWith("file:///")) source = frame.uri;
              else {
                if (typeof frame.data !== "string" || frame.data.length > 2796204 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data))
                  throw new Error("Invalid simulator frame data.");
                source = "data:" + frame.mimeType + ";base64," + frame.data;
              }
              await new Promise((resolve, reject) => {
                const done = (error) => {
                  clearTimeout(timer);
                  cancelImage = null;
                  image.removeEventListener("load", loaded);
                  image.removeEventListener("error", failed);
                  if (error) reject(error);
                  else resolve();
                };
                const timer = setTimeout(() => done(new Error("The simulator frame did not load. Retry to reconnect.")), 8000);
                cancelImage = () => done(new Error("Viewer closed."));
                const loaded = () => done();
                const failed = () => done(new Error("The simulator frame could not be displayed."));
                image.addEventListener("load", loaded);
                image.addEventListener("error", failed);
                image.src = source;
              });
              if (currentEpoch !== epoch || repairing) return;
              after = frame.sequence;
              frames = true;
              paintedGeneration = displayGeneration(frame.status);
              acceptStatus(frame.status);
              render();
              if (frame.status.ready && !triedControl) {
                triedControl = true;
                await claim(false);
              }
            }
            if (currentEpoch === epoch) frameTimer = setTimeout(() => void pull(), decoding ? 0 : 67);
          } catch (error) {
            if (currentEpoch === epoch && !repairing) fail(error);
          }
        };
        void pull();
        await poll();
        if (currentEpoch === epoch && active) heartbeat = setInterval(poll, 1000);
        return;
      }
      const connection = new RTCPeerConnection({
        iceServers: opened.iceServers,
      });
      peer = connection;
      connection.addTransceiver("video", { direction: "recvonly" });
      const endedTracks = new Set();
      const trackEnded = () => {
        if (currentEpoch === epoch && !repairing) fail(new Error("The simulator video stopped. Retry to reconnect."));
      };
      const receiveTrack = (event) => {
        if (currentEpoch !== epoch) return;
        video.srcObject = event.streams[0] || new MediaStream([event.track]);
        endedTracks.add(event.track);
        event.track.addEventListener("ended", trackEnded);
        void video.play().catch((error) => {
          if (currentEpoch === epoch && !repairing) fail(error);
        });
      };
      const playing = () => {
        if (currentEpoch === epoch) {
          frames = true;
          render();
        }
      };
      const checkConnection = () => {
        if (currentEpoch !== epoch || repairing) return;
        const state = connection.connectionState,
          ice = connection.iceConnectionState;
        if (state === "failed" || ice === "failed") fail(new Error("Video could not reach this device. Check the network and retry."));
        else if (state === "disconnected" || ice === "disconnected")
          disconnected ||= setTimeout(() => fail(new Error("Video connection lost. Retry to reconnect.")), 6000);
        else {
          clearTimeout(disconnected);
          disconnected = null;
        }
      };
      connection.addEventListener("track", receiveTrack);
      video.addEventListener("playing", playing);
      connection.addEventListener("connectionstatechange", checkConnection);
      connection.addEventListener("iceconnectionstatechange", checkConnection);
      clearPeerListeners = () => {
        connection.removeEventListener("track", receiveTrack);
        video.removeEventListener("playing", playing);
        connection.removeEventListener("connectionstatechange", checkConnection);
        connection.removeEventListener("iceconnectionstatechange", checkConnection);
        for (const track of endedTracks) track.removeEventListener("ended", trackEnded);
      };
      await connection.setLocalDescription(await connection.createOffer());
      await new Promise((resolve, reject) => {
        if (connection.iceGatheringState === "complete") {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          connection.removeEventListener("icegatheringstatechange", changed);
          reject(new Error("Video negotiation timed out. Retry on another network."));
        }, 8000);
        const changed = () => {
          if (connection.iceGatheringState === "complete") {
            clearTimeout(timer);
            connection.removeEventListener("icegatheringstatechange", changed);
            resolve();
          }
        };
        connection.addEventListener("icegatheringstatechange", changed);
      });
      if (currentEpoch !== epoch) return;
      const answer = await rpc("offer", {
        viewerId,
        sdp: connection.localDescription.sdp,
      });
      if (currentEpoch !== epoch) return;
      await connection.setRemoteDescription(answer);
      if (currentEpoch !== epoch) return;
      await poll();
      if (currentEpoch === epoch && active) heartbeat = setInterval(poll, 1000);
    } catch (error) {
      if (currentEpoch === epoch) fail(error);
    }
  };
  let resumeOnShow = false;
  retry.addEventListener("click", () => {
    extras.hidden = true;
    more.setAttribute("aria-expanded", "false");
    resumeOnShow = false;
    reconnectAttempts = 0;
    void start();
  });
  const pause = () => {
    resumeOnShow ||= !stopped || reconnectTimer !== null;
    stop();
    message.textContent = "Viewer paused while hidden.";
    retry.hidden = false;
  };
  const resume = () => {
    if (disposed || !resumeOnShow || document.hidden) return;
    resumeOnShow = false;
    reconnectAttempts = 0;
    void start();
  };
  const dispose = () => {
    disposed = true;
    resumeOnShow = false;
    return stop();
  };
  window.simulatorDispose = dispose;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
    else resume();
  });
  window.addEventListener("online", () => {
    if (disposed || document.hidden || (active && connectionState !== "error")) return;
    reconnectAttempts = 0;
    void start();
  });
  window.addEventListener("pagehide", dispose);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!extras.hidden) {
        extras.hidden = true;
        more.setAttribute("aria-expanded", "false");
        more.focus?.();
      } else post({ channel: "milagre-simulator", event: "close" });
    }
  });
  void start();
}

/** Build-time only. A checked-in string keeps script bytes stable across Vite/Metro minification and CSP hashing. */
export function buildSimulatorReceiverScript() {
  return `(${receiver.toString()})(JSON.parse(document.getElementById('config').dataset.config),${simulatorGeometry.toString()},${simulatorPoint.toString()},${createSimulatorInputQueue.toString()},${simulatorAppearance.toString()},${avcCodecString.toString()},${simulatorAvcConfig.toString()},${avccEnvelopes.toString()});`;
}

/** No hosted asset or native resource: this string travels inside desktop and OTA JS bundles. */
export function createSimulatorReceiverHtml(config) {
  const escaped = JSON.stringify(config).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>
:root{--surface:#fff;--ink:#1f2124;--ink2:#62656b;--line:#ecedef;--hover:#f4f5f6;--accent:#0285ff;--green:#199a4d}
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
body{font:12px -apple-system,BlinkMacSystemFont,sans-serif;background:var(--surface);color:var(--ink);display:flex;flex-direction:column;color-scheme:inherit}
[hidden]{display:none!important}
#stage{position:relative;min-height:0;flex:1;touch-action:none;user-select:none;overflow:hidden}
#device{position:absolute;padding:var(--bezel,7px);background:#060709;box-shadow:inset 0 0 0 1px #6c7178,inset 0 0 0 3px #30343a,0 0 0 1px #000,0 4px 20px #0002;pointer-events:none}
#device::before,#device::after{content:"";position:absolute;width:3px;border-radius:2px;background:#666b72}
#device::before{left:-2px;top:24%;height:12%}#device::after{right:-2px;top:29%;height:15%}
#device[data-sideways=true]::before{top:-2px;left:24%;height:3px;width:12%}
#device[data-sideways=true]::after{top:auto;bottom:-2px;left:29%;height:3px;width:15%}
#screen{position:relative;width:100%;height:100%;overflow:hidden;background:#08090b}
video,#image,#canvas{position:absolute;left:50%;top:50%;pointer-events:none}video,#image{object-fit:fill}
#waiting{position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;color:#9199a4}
#failure{position:absolute;left:24px;right:24px;top:50%;transform:translateY(-50%);margin:0;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink);text-align:center;line-height:1.5}
#viewer{display:flex;flex:1;min-height:0;container-type:size;container-name:simulator-viewer}
#viewport{display:flex;flex:1;min-width:0;min-height:0;gap:8px;padding-right:12px}
#rail{display:flex;flex:0 0 auto;flex-direction:column;align-items:center;justify-content:center;gap:12px;width:47px;padding:12px 0}
html[data-touch-controls=true] #rail{width:56px}
#rail nav{flex-direction:column}
footer{flex-shrink:0}
#message{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
nav{display:flex;gap:3px;align-items:center;justify-content:center;padding:3px 5px;border:1px solid var(--line);border-radius:999px;background:color-mix(in srgb,var(--hover) 50%,var(--surface))}
button{display:grid;place-items:center;width:35px;height:35px;padding:0;border:1px solid transparent;border-radius:50%;background:transparent;color:var(--ink2);cursor:pointer}
html[data-touch-controls=true] nav button{width:44px;height:44px}
button:hover:not(:disabled){background:var(--hover);color:var(--ink)}button:disabled{opacity:.3;cursor:default}
button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}

#blocked{display:flex;gap:8px;align-items:center;justify-content:center;padding:0 0 10px;color:var(--ink2);line-height:1.4;text-align:center}
#blocked button{flex-shrink:0;width:auto;height:32px;padding:0 10px;border-color:var(--line);border-radius:8px;color:var(--ink)}
#duo{display:flex;flex-direction:column;gap:12px;align-items:center}
#extras{flex-shrink:0;padding:8px 16px 12px;border-top:1px solid var(--line)}
.extra-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
#extras button{width:auto;min-height:35px;padding:0 10px;border-color:var(--line);border-radius:9px;color:var(--ink);gap:8px;grid-auto-flow:column}
html[data-touch-controls=true] #extras button,html[data-touch-controls=true] #hinge-angle{min-height:44px}
#more[aria-expanded=true]{background:var(--hover);color:var(--accent)}
#hinge{display:flex;gap:8px;align-items:center;justify-content:center;margin-top:10px}
@container simulator-viewer (max-height:500px){#viewport{flex-direction:column;padding-right:0}#rail{width:auto!important;flex-direction:row;flex-wrap:wrap;padding:0 12px 8px;gap:8px}#rail nav,#duo{flex-direction:row}#duo{gap:8px}}
#duo button[aria-pressed=true]{background:var(--hover);color:var(--accent)}
#hinge label{display:flex;align-items:center;gap:6px;color:var(--ink2)}
#hinge-angle{font:inherit;width:52px;min-height:35px;box-sizing:border-box;padding:4px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink)}
button svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
</style></head><body><div id="config" hidden data-config="${escaped}"></div><div id="viewer"><div id="viewport"><div id="stage" aria-label="Simulator touch screen"><div id="device"><div id="screen"><video id="video" autoplay muted playsinline></video><img id="image" alt="" hidden><canvas id="canvas" hidden></canvas><span id="waiting" aria-hidden="true">Connecting...</span></div></div><p id="failure" role="alert" hidden></p></div><aside id="rail" aria-label="Simulator controls"><nav aria-label="General controls"><button id="home" aria-label="Home" title="Home" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/></svg></button><button id="back" aria-label="Back" title="Back" hidden disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7"/></svg></button><button id="rotate" aria-label="Rotate" title="Rotate" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="5" width="9" height="14" rx="2" transform="rotate(30 12.5 12)"/><path d="M3 10a9 9 0 0 1 14-7M3 5v5h5m13 4a9 9 0 0 1-14 7m14-2v-5h-5"/></svg></button><button id="more" type="button" aria-label="More simulator controls" title="More controls" aria-expanded="false" aria-controls="extras"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button><button id="control" aria-label="Take control" title="Take control" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 13V6a2 2 0 0 1 4 0v6-2a2 2 0 0 1 4 0v2a2 2 0 0 1 4 0v4c0 4-3 6-6 6h-1c-2 0-3-1-4-2l-5-6a2 2 0 0 1 3-2l1 1Z"/></svg></button></nav><div id="duo" role="group" aria-label="Duo pose" hidden><nav aria-label="Fold shape"><button id="pose-closed" type="button" aria-label="Closed" title="Closed" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="3" width="8" height="18" rx="2"/><path d="M13 6h1"/></svg></button><button id="pose-book" type="button" aria-label="Book" title="Book" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 6-8-3v15l8 3 8-3V3l-8 3Zm0 0v15"/></svg></button><button id="pose-open" type="button" aria-label="Open" title="Open" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/></svg></button></nav><nav aria-label="Device stand"><button id="pose-laptop" type="button" aria-label="Laptop" title="Laptop" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v10H5zM3 20l2-6h14l2 6H3Z"/></svg></button><button id="pose-tent" type="button" aria-label="Tent" title="Tent" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 19 8-14h2l8 14-9-3-9 3ZM12 5v11"/></svg></button></nav></div></aside></div></div><section id="extras" aria-label="Additional simulator controls" hidden><div class="extra-actions"><button id="retry" aria-label="Retry" title="Retry" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5m5 0a8 8 0 1 0-2 6"/></svg><span>Reconnect</span></button><button id="repair" type="button">Reset input</button></div><div id="blocked" hidden><span id="blocked-text">If touches don't respond, reset input.</span></div><div id="hinge" hidden><label>Hinge <input id="hinge-angle" type="number" min="0" max="180" step="1" inputmode="decimal" aria-label="Hinge angle in degrees">°</label><button id="hinge-apply" type="button" aria-label="Apply hinge angle" title="Apply hinge angle"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button></div></section><footer><p id="message" role="status" aria-live="polite">Connecting...</p></footer><script>${SIMULATOR_RECEIVER_SCRIPT}</script></body></html>`;
}
