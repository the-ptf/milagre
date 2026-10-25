const { randomBytes, randomUUID } = require("node:crypto");

const ORIENTATIONS = new Set(["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]);
const POSES = new Set(["closed", "open", "book", "laptop", "tent"]);
const MAX_SDP_BYTES = 262144;
function identifier() {
  return randomBytes(24).toString("base64url");
}
function validEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  if (event.kind === "touch")
    return (
      ["begin", "move", "end"].includes(event.phase) &&
      Array.isArray(event.points) &&
      event.points.length >= 1 &&
      event.points.length <= 2 &&
      event.points.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)
    );
  if (event.kind === "button") return event.button === "home" || event.button === "back";
  if (event.kind === "rotate") return ORIENTATIONS.has(event.orientation);
  if (event.kind === "pose") return POSES.has(event.pose);
  if (event.kind === "hinge") return Number.isFinite(event.angle) && event.angle >= 0 && event.angle <= 180;
  return (
    event.kind === "key" &&
    ["down", "up"].includes(event.phase) &&
    Number.isInteger(event.usage) &&
    event.usage >= 4 &&
    event.usage <= 255 &&
    (event.key === undefined || (typeof event.key === "string" && event.key.length === 1)) &&
    (event.shifted === undefined || typeof event.shifted === "boolean")
  );
}
// Copy only admitted fields; callers cannot forward arbitrary helper commands.
function cleanEvent(event) {
  if (event.kind === "touch") return { kind: "touch", phase: event.phase, points: event.points.map(({ x, y }) => ({ x, y })) };
  if (event.kind === "button") return { kind: "button", button: event.button };
  if (event.kind === "rotate") return { kind: "rotate", orientation: event.orientation };
  if (event.kind === "pose") return { kind: "pose", pose: event.pose };
  if (event.kind === "hinge") return { kind: "hinge", angle: event.angle };
  return {
    kind: "key",
    phase: event.phase,
    usage: event.usage,
    ...(event.key === undefined ? {} : { key: event.key }),
    ...(event.shifted === undefined ? {} : { shifted: event.shifted }),
  };
}

/** One host owns devices; capabilities belong to a trusted transport connection. */
function createSimulators(options = {}) {
  const supported = options.supported ?? (process.platform === "darwin" && process.arch === "arm64");
  const adapter = options.adapter ?? require("./simulators-helper.cjs").createSimulatorAdapter(options);
  const iceServers = options.iceServers ?? adapter.iceServers ?? [];
  const now = options.now ?? Date.now;
  const ttl = options.viewerTtlMs ?? 30000;
  const maxViewers = options.maxViewers ?? 8;
  const owners = new Map(),
    viewers = new Map(),
    devices = new Map();
  let closed = false,
    queue = Promise.resolve(),
    pending = 0;

  function serial(fn, allowClosed = false) {
    if (closed && !allowClosed) return Promise.reject(new Error("Simulator service is closed."));
    // Input must never grow an unbounded replay queue on a slow helper.
    if (pending >= 128 && !allowClosed) return Promise.reject(new Error("Simulator is busy. Retry after pending commands finish."));
    pending++;
    const result = queue.then(fn);
    queue = result
      .catch(() => {})
      .finally(() => {
        pending--;
      });
    return result;
  }
  function ownerState(owner) {
    if (typeof owner !== "string" || !owner || owner.length > 1024) throw new Error("A trusted simulator owner is required.");
    let state = owners.get(owner);
    if (!state) {
      state = { dead: false, count: 0 };
      owners.set(owner, state);
    }
    return state;
  }
  function requireViewer(request, owner) {
    const v = viewers.get(request?.viewerId);
    if (!v || v.owner !== owner || v.ownerState.dead) throw new Error("Unknown simulator viewer or owner. Reopen the viewer.");
    return v;
  }
  function releaseHeld(device) {
    const touch = device.touch;
    device.touch = null;
    if (touch) {
      try {
        device.channel.send({ ...touch, phase: "end" });
      } catch {}
    }
    for (const usage of device.keys) {
      try {
        device.channel.send({ kind: "key", phase: "up", usage });
      } catch {}
    }
    device.keys.clear();
  }
  function revoke(device) {
    releaseHeld(device);
    device.controller = null;
    device.generation++;
  }
  function metadata(device) {
    const state = device.channel.status();
    const signature = `${state.width}:${state.height}:${state.orientation}:${state.ready}:${state.hingeAngle ?? ""}:${state.hingePose ?? ""}:${state.error ?? ""}`;
    if (device.signature !== signature) {
      if (device.signature !== undefined) {
        releaseHeld(device);
        device.generation++;
        device.displayGeneration++;
      }
      device.signature = signature;
    }
    if (device.rotation && (state.orientation === device.rotation.orientation || now() - device.rotation.at >= 5000)) device.rotation = null;
    return { ...state, ready: !!state.ready && !state.error && !device.rotation && !device.poseChanging };
  }
  function statusOf(v) {
    const device = v.device,
      state = metadata(device);
    if (state.error) throw new Error(state.error);
    return {
      width: state.width,
      height: state.height,
      orientation: state.orientation,
      generation: device.generation,
      displayGeneration: device.displayGeneration,
      controlling: device.controller === v.id,
      ready: state.ready,
      ...(state.supportsHingeAngle === true
        ? {
            supportsHingeAngle: true,
            ...(Number.isFinite(state.hingeAngle) && state.hingeAngle >= 0 && state.hingeAngle <= 180 ? { hingeAngle: state.hingeAngle } : {}),
            ...(POSES.has(state.hingePose) ? { hingePose: state.hingePose } : {}),
          }
        : {}),
      // Older clients need the legacy wire name to expose their manual reset action.
      ...(state.deviceHubInputActive ? { deviceHubInputActive: true, inputBlocked: true } : {}),
    };
  }
  async function remove(v) {
    if (!viewers.delete(v.id)) return;
    v.abort.abort();
    const device = v.device;
    v.ownerState.count--;
    if (v.ownerState.count === 0 && owners.get(v.owner) === v.ownerState) owners.delete(v.owner);
    if (device.controller === v.id) revoke(device);
    device.viewers.delete(v.id);
    await adapter.closeViewer(device.id, v.sessionId).catch(() => {});
    if (device.viewers.size === 0) {
      devices.delete(device.id);
      await device.channel.close().catch(() => {});
    }
  }
  async function expire() {
    for (const v of viewers.values()) if (now() - v.heartbeat >= ttl || v.ownerState.dead) await remove(v);
  }
  async function active(request, owner) {
    await expire();
    return requireViewer(request, owner);
  }
  const expiryTimer = setInterval(
    () => {
      if (!closed) void serial(expire).catch(() => {});
    },
    Math.min(5000, ttl),
  );
  expiryTimer.unref();

  return {
    async list() {
      if (closed) throw new Error("Simulator service is closed.");
      if (!supported) return { devices: [], supported: false };
      try {
        return { devices: await adapter.list(), supported: true };
      } catch {
        return { devices: [], supported: true, error: "Could not list simulators. Check that Xcode is installed and available." };
      }
    },
    async open(request, owner) {
      const ownership = ownerState(owner);
      return serial(async () => {
        await expire();
        if (!supported) throw new Error("Simulator viewing is supported on Apple silicon Macs only.");
        if (ownership.dead || closed) throw new Error("Simulator owner disconnected.");
        if (viewers.size >= maxViewers) throw new Error("Too many simulator viewers. Close a viewer first.");
        const found = (await adapter.list()).find((d) => d.id === request?.deviceId);
        if (!found) throw new Error("Unknown or stopped simulator device.");
        let device = devices.get(found.id);
        if (device?.channel.status().error) {
          // A copy: channel cleanup awaits while the viewer set can change.
          for (const id of Array.from(device.viewers)) await remove(viewers.get(id));
          device = null;
        }
        if (!device) {
          const channel = await adapter.connect(found.id);
          device = {
            id: found.id,
            platform: found.platform,
            channel,
            viewers: new Set(),
            controller: null,
            generation: 1,
            displayGeneration: 1,
            touch: null,
            keys: new Set(),
            rotation: null,
          };
          if (ownership.dead || closed) {
            await channel.close();
            throw new Error("Simulator owner disconnected.");
          }
          devices.set(found.id, device);
        }
        if (ownership.dead || closed) throw new Error("Simulator owner disconnected.");
        const id = identifier();
        ownership.count++;
        owners.set(owner, ownership);
        viewers.set(id, {
          id,
          owner,
          ownerState: ownership,
          device,
          sessionId: randomUUID(),
          sequence: -1,
          heartbeat: now(),
          rateAt: now(),
          inputTokens: 240,
          offered: false,
          waiting: false,
          abort: new AbortController(),
        });
        device.viewers.add(id);
        return { viewerId: id, device: { ...found }, iceServers: structuredClone(iceServers), ...(device.channel.frame ? { transport: "frames" } : {}) };
      });
    },
    // Wait outside the input queue. A slow video link must never delay a touch, close or another viewer.
    async frame(request, owner) {
      const v = await serial(async () => {
        const viewer = await active(request, owner);
        if (!Number.isSafeInteger(request.after) || request.after < 0) throw new Error("Invalid simulator frame request.");
        if (!viewer.device.channel.frame) throw new Error("Update Milagre on this Mac to relay simulator video.");
        if (viewer.waiting) throw new Error("A simulator frame request is already pending for this viewer.");
        viewer.waiting = true;
        viewer.heartbeat = now();
        return viewer;
      });
      try {
        const frame = await v.device.channel.frame(request.after, v.abort.signal);
        if (v.abort.signal.aborted || v.ownerState.dead) return null;
        const status = statusOf(v);
        v.heartbeat = now();
        return frame ? { ...frame, status } : null;
      } finally {
        v.waiting = false;
      }
    },
    offer(request, owner) {
      return serial(async () => {
        const v = await active(request, owner);
        if (typeof request.sdp !== "string" || !request.sdp.startsWith("v=0") || Buffer.byteLength(request.sdp) > MAX_SDP_BYTES)
          throw new Error("Invalid or oversized simulator SDP.");
        if (v.offered) throw new Error("This viewer has already negotiated an offer. Reopen the viewer.");
        v.offered = true;
        v.heartbeat = now();
        const answer = await adapter.offer(v.device.id, v.sessionId, request.sdp);
        if (v.ownerState.dead || closed) throw new Error("Simulator owner disconnected.");
        if (answer?.type !== "answer" || typeof answer.sdp !== "string" || Buffer.byteLength(answer.sdp) > MAX_SDP_BYTES)
          throw new Error("Invalid simulator SDP answer.");
        v.heartbeat = now();
        return { type: "answer", sdp: answer.sdp };
      });
    },
    status(request, owner) {
      return serial(async () => {
        const v = await active(request, owner);
        v.heartbeat = now();
        return statusOf(v);
      });
    },
    control(request, owner) {
      return serial(async () => {
        const v = await active(request, owner),
          device = v.device;
        if (typeof request.takeOver !== "boolean") throw new Error("Invalid simulator control request.");
        if (device.controller !== v.id && (!device.controller || request.takeOver)) {
          revoke(device);
          device.controller = v.id;
        }
        v.heartbeat = now();
        return statusOf(v);
      });
    },
    input(request, owner) {
      return serial(async () => {
        const v = await active(request, owner),
          device = v.device;
        if (!Number.isSafeInteger(request.sequence) || request.sequence < 0 || !Number.isSafeInteger(request.generation) || !validEvent(request.event))
          throw new Error("Invalid simulator input event.");
        if (request.event.kind === "button" && request.event.button === "back" && device.platform !== "android")
          throw new Error("Back is available only on Android.");
        const state = metadata(device);
        if ((request.event.kind === "pose" || request.event.kind === "hinge") && (device.platform !== "ios" || !state.supportsHingeAngle))
          throw new Error("This simulator does not support hinge controls.");
        if (device.controller !== v.id || !state.ready || request.generation !== device.generation || request.sequence <= v.sequence)
          return { accepted: false };
        v.sequence = request.sequence;
        v.inputTokens = Math.min(240, v.inputTokens + Math.max(0, now() - v.rateAt) * 0.24);
        v.rateAt = now();
        if (v.inputTokens < 1) {
          releaseHeld(device);
          return { accepted: false };
        }
        v.inputTokens--;
        const event = cleanEvent(request.event);
        if (event.kind === "touch") {
          if (event.phase === "begin" ? !!device.touch : !device.touch || device.touch.points.length !== event.points.length) return { accepted: false };
        }
        if (event.kind === "rotate") {
          releaseHeld(device);
          device.generation++;
          device.displayGeneration++;
          device.rotation = { orientation: event.orientation, at: now() };
        }
        if (event.kind === "pose" || event.kind === "hinge") {
          releaseHeld(device);
          // A panel can change before its dimensions do. Reject all input using the old geometry.
          device.generation++;
          device.displayGeneration++;
          device.poseChanging = true;
        }
        try {
          await device.channel.send(event);
        } catch (error) {
          revoke(device);
          if (event.kind === "pose" || event.kind === "hinge") throw error;
          return { accepted: false };
        } finally {
          device.poseChanging = false;
        }
        if (event.kind === "touch") device.touch = event.phase === "end" ? null : event;
        if (event.kind === "key") {
          if (event.phase === "down") device.keys.add(event.usage);
          else device.keys.delete(event.usage);
        }
        v.heartbeat = now();
        return { accepted: true };
      });
    },
    repair(request, owner) {
      return serial(async () => {
        const v = await active(request, owner),
          device = v.device;
        if (device.controller !== v.id) throw new Error("Take control of the simulator before fixing its input.");
        if (device.platform !== "ios") throw new Error("Input repair is available only on iOS simulators.");
        await adapter.repairInput(device.id);
        // backboardd restarted under the open channel; every viewer reopens on a fresh one.
        // A copy: repair closes only viewers of the old channel.
        for (const id of Array.from(device.viewers)) await remove(viewers.get(id));
        return null;
      });
    },
    closeViewer(request, owner) {
      return serial(async () => {
        await remove(await active(request, owner));
        return null;
      });
    },
    disconnect(owner) {
      const state = owners.get(owner);
      if (state) {
        state.dead = true;
        owners.delete(owner);
      }
      return serial(async () => {
        for (const v of viewers.values()) if (v.owner === owner) await remove(v);
      }, true);
    },
    close() {
      if (closed) return queue;
      closed = true;
      clearInterval(expiryTimer);
      for (const state of owners.values()) state.dead = true;
      for (const device of devices.values()) releaseHeld(device);
      // Stop immediately: an in-flight offer must not delay daemon shutdown.
      const stopping = Promise.resolve(adapter.stop());
      return serial(async () => {
        for (const v of viewers.values()) await remove(v);
        owners.clear();
        await stopping;
      }, true);
    },
  };
}
module.exports = { createSimulators };
