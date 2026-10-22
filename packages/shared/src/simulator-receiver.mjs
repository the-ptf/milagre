import { SIMULATOR_RECEIVER_SCRIPT } from "./simulator-browser.mjs";
export { SIMULATOR_RECEIVER_SCRIPT } from "./simulator-browser.mjs";

export const SIMULATOR_CONNECTION_LABELS = {
  connecting: "Connecting",
  live: "Live",
  "view-only": "View only",
  rotating: "Rotating",
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
export function createSimulatorBridge(call, respond) {
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
        if (!["open", "offer", "status", "control", "input", "repair", "close"].includes(method)) throw new Error("Unknown simulator command.");
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
          reply({ result });
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
function receiver(config, geometryFor, pointFor, inputQueue, appearanceFor) {
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
    video = document.getElementById("video");
  const deviceFrame = document.getElementById("device"),
    screen = document.getElementById("screen"),
    hardware = document.getElementById("hardware"),
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
  back.hidden = config.device?.platform !== "android";
  let nextId = 0,
    epoch = 0,
    viewerId = null,
    peer = null,
    status = null,
    queue = null,
    sequence = 0;
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
      long = Math.max(g.width, g.height),
      bezel = Math.min(8, short * 0.025),
      radius = short * appearance.radius;
    // Android reports only buffer dimensions, so landscape cannot identify the camera's edge.
    deviceFrame.dataset.cutout = device?.platform === "android" && g.width > g.height ? "none" : appearance.cutout;
    deviceFrame.dataset.sideways = String(g.width > g.height);
    deviceFrame.style.left = g.left - bezel + "px";
    deviceFrame.style.top = g.top - bezel + "px";
    deviceFrame.style.width = g.width + bezel * 2 + "px";
    deviceFrame.style.height = g.height + bezel * 2 + "px";
    deviceFrame.style.setProperty("--bezel", bezel + "px");
    deviceFrame.style.borderRadius = radius + bezel + "px";
    screen.style.borderRadius = radius + "px";
    const degrees =
      {
        "landscape-left": 90,
        "landscape-right": -90,
        "portrait-upside-down": 180,
      }[capture().orientation] || 0;
    hardware.style.width = short + "px";
    hardware.style.height = long + "px";
    hardware.style.transform = "translate(-50%,-50%) rotate(" + degrees + "deg)";
    video.style.width = g.rawWidth + "px";
    video.style.height = g.rawHeight + "px";
    video.style.transform = "translate(-50%,-50%) rotate(" + g.rotation + "deg)";
  };
  new ResizeObserver(layout).observe(stage);
  const resetRepair = () => {
    clearTimeout(confirmRepair);
    confirmRepair = null;
    blockedText.textContent = "Xcode Device Hub is blocking touches.";
    repair.textContent = "Fix";
    repair.disabled = repairing;
  };
  const render = (reportConnection = true) => {
    const ready = active && frames && status?.ready;
    const touchesBlocked = !!(ready && status.controlling && status.inputBlocked);
    if (reportConnection)
      reportState(
        !active
          ? connectionState === "error"
            ? "error"
            : "paused"
          : !ready
            ? rotatingGeneration !== null
              ? "rotating"
              : "connecting"
            : touchesBlocked
              ? "blocked"
              : status.controlling
                ? "live"
                : "view-only",
      );
    if (!touchesBlocked && confirmRepair) resetRepair();
    blocked.hidden = !touchesBlocked;
    back.disabled = home.disabled = rotate.disabled = !(ready && status.controlling);
    control.disabled = !ready || claiming;
    control.hidden = !ready || !!status?.controlling;
    waiting.hidden = frames || !active;
    video.hidden = !frames;
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
            ? status.inputBlocked
              ? "Xcode Device Hub is blocking touches."
              : "You control this simulator"
            : "View only. Another viewer may control it.";
    if (ready) {
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
    clearInput();
    clearInterval(heartbeat);
    clearTimeout(deadline);
    clearTimeout(disconnected);
    clearTimeout(rotationTimer);
    heartbeat = deadline = disconnected = rotationTimer = rotatingGeneration = null;
    clearPeerListeners();
    clearPeerListeners = () => {};
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
  };
  const acceptStatus = (value) => {
    if (status && status.generation > value.generation) return;
    if (rotatingGeneration !== null) {
      if (value.generation === rotatingGeneration) value = { ...value, ready: false };
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
    if (repairing || !viewerId) return;
    if (!confirmRepair) {
      blockedText.textContent = "Fixing restarts the simulator's home screen and closes its apps.";
      repair.textContent = "Restart";
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
    clearInput();
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
  rotate.addEventListener("click", () => {
    if (!queue || pointers.size) return;
    // iPhones do not support upside-down portrait. A two-way toggle always offers a usable next orientation.
    const orientation = status.orientation.startsWith("landscape") ? "portrait" : "landscape-left";
    rotatingGeneration = status.generation;
    const currentEpoch = epoch;
    rotationTimer = setTimeout(() => {
      if (currentEpoch === epoch) fail(new Error("The simulator did not finish rotating. Retry to reconnect."));
    }, 8000);
    queue.push({ kind: "rotate", orientation });
    // Wait for the new generation before accepting touches in the old geometry.
    back.disabled = home.disabled = rotate.disabled = true;
    status.ready = false;
    render();
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
    if (!active || !frames || !status?.controlling || !status.ready || pointers.size >= 2 || event.button > 0) return;
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
      const connection = new RTCPeerConnection({
        iceServers: opened.iceServers,
      });
      peer = connection;
      connection.addTransceiver("video", { direction: "recvonly" });
      const endedTracks = new Set();
      const trackEnded = () => {
        if (currentEpoch === epoch) fail(new Error("The simulator video stopped. Retry to reconnect."));
      };
      const receiveTrack = (event) => {
        if (currentEpoch !== epoch) return;
        video.srcObject = event.streams[0] || new MediaStream([event.track]);
        endedTracks.add(event.track);
        event.track.addEventListener("ended", trackEnded);
        void video.play().catch((error) => {
          if (currentEpoch === epoch) fail(error);
        });
      };
      const playing = () => {
        if (currentEpoch === epoch) {
          frames = true;
          render();
        }
      };
      const checkConnection = () => {
        if (currentEpoch !== epoch) return;
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
      let polling = false,
        triedControl = false;
      const poll = async () => {
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
      if (currentEpoch === epoch && active) heartbeat = setInterval(poll, 1000);
    } catch (error) {
      if (currentEpoch === epoch) fail(error);
    }
  };
  // Video pauses while hidden and reconnects on its own when shown again, unless it had already failed.
  let resumeOnShow = false;
  retry.addEventListener("click", () => {
    resumeOnShow = false;
    void start();
  });
  window.simulatorDispose = stop;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      resumeOnShow ||= !stopped;
      stop();
      message.textContent = "Viewer paused while hidden.";
      retry.hidden = false;
    } else if (resumeOnShow) {
      resumeOnShow = false;
      void start();
    }
  });
  window.addEventListener("pagehide", stop);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") post({ channel: "milagre-simulator", event: "close" });
  });
  void start();
}

/** Build-time only. A checked-in string keeps script bytes stable across Vite/Metro minification and CSP hashing. */
export function buildSimulatorReceiverScript() {
  return `(${receiver.toString()})(JSON.parse(document.getElementById('config').dataset.config),${simulatorGeometry.toString()},${simulatorPoint.toString()},${createSimulatorInputQueue.toString()},${simulatorAppearance.toString()});`;
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
video,#hardware{position:absolute;left:50%;top:50%;pointer-events:none}video{object-fit:fill}
#hardware{z-index:1}#cutout{position:absolute;left:50%;transform:translateX(-50%);background:#000}
#device[data-cutout=none] #cutout{display:none}
#device[data-cutout=island] #cutout{top:1.3%;width:30%;height:4%;border-radius:999px}
#device[data-cutout=notch] #cutout{top:-1px;width:44%;height:3.8%;border-radius:0 0 14px 14px}
#device[data-cutout=notch] #cutout::before{content:"";position:absolute;left:32%;top:24%;width:32%;height:12%;border-radius:3px;background:#1e2125}
#device[data-cutout=camera] #cutout{top:1.4%;width:4%;aspect-ratio:1;border-radius:50%;box-shadow:0 0 0 1px #303641}
#cutout::after{content:"";position:absolute;right:8%;top:32%;height:34%;aspect-ratio:1;border-radius:50%;background:radial-gradient(circle at 40% 40%,#183148,#080d15 65%);box-shadow:0 0 0 2px #050506}
#device[data-cutout=camera] #cutout::after{inset:28%;height:auto;box-shadow:none}
#waiting{position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;color:#9199a4}
#failure{position:absolute;left:24px;right:24px;top:50%;transform:translateY(-50%);margin:0;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--ink);text-align:center;line-height:1.5}
footer{padding:2px 12px 16px;flex-shrink:0;display:flex;flex-direction:column;align-items:center}
#message{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
nav{display:flex;gap:3px;align-items:center;justify-content:center;padding:3px 5px;border:1px solid var(--line);border-radius:999px;background:color-mix(in srgb,var(--hover) 50%,var(--surface))}
button{display:grid;place-items:center;width:35px;height:35px;padding:0;border:1px solid transparent;border-radius:50%;background:transparent;color:var(--ink2);cursor:pointer}
html[data-touch-controls=true] nav button{width:44px;height:44px}
button:hover:not(:disabled){background:var(--hover);color:var(--ink)}button:disabled{opacity:.3;cursor:default}
button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
#retry{margin-left:5px;position:relative}#retry::before{content:"";position:absolute;left:-5px;width:1px;height:16px;background:var(--line)}
#blocked{display:flex;gap:8px;align-items:center;justify-content:center;padding:0 0 10px;color:var(--ink2);line-height:1.4;text-align:center}
#blocked button{flex-shrink:0;width:auto;height:32px;padding:0 10px;border-color:var(--line);border-radius:8px;color:var(--ink)}
button svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
</style></head><body><div id="config" hidden data-config="${escaped}"></div><div id="stage" aria-label="Simulator touch screen"><div id="device"><div id="screen"><video id="video" autoplay muted playsinline></video><div id="hardware" aria-hidden="true"><span id="cutout"></span></div><span id="waiting" aria-hidden="true">Connecting...</span></div></div><p id="failure" role="alert" hidden></p></div><footer><p id="message" role="status" aria-live="polite">Connecting...</p><div id="blocked" hidden><span id="blocked-text">Xcode Device Hub is blocking touches.</span><button id="repair" type="button">Fix</button></div><nav aria-label="Simulator controls"><button id="back" aria-label="Back" title="Back" hidden disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 5-7 7 7 7"/></svg></button><button id="home" aria-label="Home" title="Home" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/></svg></button><button id="rotate" aria-label="Rotate" title="Rotate" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="5" width="9" height="14" rx="2" transform="rotate(30 12.5 12)"/><path d="M3 10a9 9 0 0 1 14-7M3 5v5h5m13 4a9 9 0 0 1-14 7m14-2v-5h-5"/></svg></button><button id="retry" aria-label="Retry" title="Retry" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5m5 0a8 8 0 1 0-2 6"/></svg></button><button id="control" aria-label="Take control" title="Take control" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 13V6a2 2 0 0 1 4 0v6-2a2 2 0 0 1 4 0v2a2 2 0 0 1 4 0v4c0 4-3 6-6 6h-1c-2 0-3-1-4-2l-5-6a2 2 0 0 1 3-2l1 1Z"/></svg></button></nav></footer><script>${SIMULATOR_RECEIVER_SCRIPT}</script></body></html>`;
}
