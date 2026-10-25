const test = require("node:test");
const assert = require("node:assert/strict");
const { createSimulators } = require("./simulators.cjs");

const DEVICE = { id: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", name: "iPhone", platform: "ios", version: "27.0" };
const BEGIN = { kind: "touch", phase: "begin", points: [{ x: 0.25, y: 0.75 }] };
function fixture(t, options = {}) {
  let time = 1000;
  const events = [],
    channels = [],
    offers = [],
    closed = [],
    repaired = [];
  const adapter = {
    async list() {
      return [DEVICE];
    },
    async connect(deviceId) {
      const channel = {
        deviceId,
        ...(options.frame ? { frame: options.frame } : {}),
        state: { width: 588, height: 1280, orientation: "portrait", ready: true },
        status() {
          return { ...this.state };
        },
        send(event) {
          events.push(structuredClone(event));
        },
        async close() {
          this.closed = true;
        },
      };
      channels.push(channel);
      return channel;
    },
    async offer(deviceId, sessionId, sdp) {
      offers.push({ deviceId, sessionId, sdp });
      return { type: "answer", sdp: "v=0\r\nanswer" };
    },
    async closeViewer(deviceId, sessionId) {
      closed.push({ deviceId, sessionId });
    },
    async repairInput(deviceId) {
      repaired.push(deviceId);
    },
    async stop() {
      this.stopped = true;
    },
  };
  const service = createSimulators({ adapter, supported: true, now: () => time, ...options });
  t.after(() => service.close());
  return {
    service,
    adapter,
    events,
    channels,
    offers,
    closed,
    repaired,
    advance: (ms) => {
      time += ms;
    },
  };
}
async function controller(f, owner = "owner-a") {
  const viewer = await f.service.open({ deviceId: DEVICE.id }, owner);
  const status = await f.service.control({ viewerId: viewer.viewerId, takeOver: false }, owner);
  return { ...viewer, ...status, owner };
}
function input(f, viewer, event = BEGIN, sequence = 1, generation = viewer.generation) {
  return f.service.input({ viewerId: viewer.viewerId, sequence, generation, event }, viewer.owner);
}

test("taking control invalidates the input lease without requiring an unchanged display to repaint", async (t) => {
  const f = fixture(t),
    first = await controller(f),
    second = await f.service.open({ deviceId: DEVICE.id }, "owner-b");
  const taken = await f.service.control({ viewerId: second.viewerId, takeOver: true }, "owner-b");
  assert.ok(taken.generation > first.generation);
  assert.equal(taken.displayGeneration, first.displayGeneration);
  f.channels[0].state.orientation = "landscape-left";
  const rotated = await f.service.status({ viewerId: second.viewerId }, "owner-b");
  assert.ok(rotated.displayGeneration > taken.displayGeneration, "actual display changes invalidate painted pixels");
});

test("Duo poses require control and capability, await dispatch, and invalidate old touch geometry", async (t) => {
  let deliverFrame;
  const f = fixture(t, {
      frame: () =>
        new Promise((resolve) => {
          deliverFrame = resolve;
        }),
    }),
    a = await controller(f);
  const b = await f.service.open({ deviceId: DEVICE.id }, "owner-b");
  const state = f.channels[0].state;
  await assert.rejects(input(f, a, { kind: "pose", pose: "book" }), /hinge|fold/i);
  Object.assign(state, { supportsHingeAngle: true, hingeAngle: 0, hingePose: "closed" });
  let current = { ...a, ...(await f.service.status({ viewerId: a.viewerId }, a.owner)) };
  assert.equal(current.hingePose, "closed");
  assert.deepEqual(await input(f, { ...b, owner: "owner-b", generation: current.generation }, { kind: "pose", pose: "open" }), { accepted: false });
  await input(f, current, BEGIN, 1);
  let acknowledge;
  const send = f.channels[0].send;
  f.channels[0].send = (event) => {
    send(event);
    if (event.kind === "pose")
      return new Promise((resolve) => {
        acknowledge = resolve;
      });
  };
  let settled = false;
  const inFlightFrame = f.service.frame({ viewerId: a.viewerId, after: 0 }, a.owner);
  await new Promise((resolve) => setImmediate(resolve));
  const changing = input(f, current, { kind: "pose", pose: "book", ignored: "shell" }, 2).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  deliverFrame({ sequence: 1, data: "test", mimeType: "image/jpeg" });
  assert.equal((await inFlightFrame).status.ready, false, "frames cannot reenable input while guest acknowledgement is pending");
  assert.deepEqual(f.events.slice(-2), [
    { ...BEGIN, phase: "end" },
    { kind: "pose", pose: "book" },
  ]);
  Object.assign(state, { hingeAngle: 90, hingePose: "book" });
  acknowledge();
  assert.deepEqual(await changing, { accepted: true });
  const next = await f.service.status({ viewerId: a.viewerId }, a.owner);
  assert.equal(next.ready, true);
  assert.ok(next.generation > current.generation);
  assert.equal(next.hingeAngle, 90);
  assert.deepEqual(await input(f, current, BEGIN, 3), { accepted: false });
  current = { ...a, ...next };
  for (const event of [
    { kind: "pose", pose: "arbitrary" },
    { kind: "hinge", angle: -1 },
    { kind: "hinge", angle: 181 },
    { kind: "hinge", angle: NaN },
  ])
    await assert.rejects(input(f, current, event, 4), /invalid/i);
  assert.deepEqual(await input(f, current, { kind: "hinge", angle: 120 }, 4), { accepted: true });
  assert.deepEqual(f.events.at(-1), { kind: "hinge", angle: 120 });
});

test("a failed Duo pose reports its error and releases the pending readiness gate", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  f.channels[0].state.supportsHingeAngle = true;
  f.channels[0].send = async () => {
    throw new Error("Simulator could not change the device pose.");
  };
  await assert.rejects(input(f, v, { kind: "pose", pose: "open" }), /could not change/);
  const state = await f.service.status({ viewerId: v.viewerId }, v.owner);
  assert.equal(state.ready, true);
  assert.equal(state.controlling, false);
});

test("discovery is private and unknown devices cannot reach the helper", async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.service.list(), { devices: [DEVICE], supported: true });
  await assert.rejects(f.service.open({ deviceId: "../shell" }, "a"), /device/i);
  assert.equal(f.channels.length, 0);
  const viewer = await f.service.open({ deviceId: DEVICE.id }, "a");
  assert.match(viewer.viewerId, /^[a-zA-Z0-9_-]{32,}$/);
  assert.equal(JSON.stringify(await f.service.list()).includes(viewer.viewerId), false);
});

test("every viewer command checks the trusted connection owner", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  for (const [method, extra] of [
    ["status", {}],
    ["control", { takeOver: true }],
    ["offer", { sdp: "v=0\r\n" }],
    ["input", { event: BEGIN, sequence: 1, generation: v.generation }],
    ["closeViewer", {}],
  ]) {
    await assert.rejects(f.service[method]({ viewerId: v.viewerId, ...extra }, "intruder"), /viewer|owner/i);
    await assert.rejects(f.service[method]({ viewerId: "missing", ...extra }, v.owner), /viewer/i);
  }
  assert.equal(f.events.length, 0);
  assert.equal(f.closed.length, 0);
});

test("takeover ends held input and invalidates both old controller and stale generations", async (t) => {
  const f = fixture(t),
    a = await controller(f);
  const b = await f.service.open({ deviceId: DEVICE.id }, "owner-b");
  assert.equal((await f.service.control({ viewerId: b.viewerId, takeOver: false }, "owner-b")).controlling, false);
  assert.deepEqual(await input(f, a), { accepted: true });
  await input(f, a, { kind: "key", phase: "down", usage: 4 }, 2);
  const bs = await f.service.control({ viewerId: b.viewerId, takeOver: true }, "owner-b");
  assert.equal(bs.controlling, true);
  assert.ok(bs.generation > a.generation);
  assert.deepEqual(f.events.slice(-2), [
    { ...BEGIN, phase: "end" },
    { kind: "key", phase: "up", usage: 4 },
  ]);
  assert.deepEqual(await input(f, a, BEGIN, 3), { accepted: false });
  assert.deepEqual(await input(f, { ...b, ...bs, owner: "owner-b" }, BEGIN, 1, a.generation), { accepted: false });
  assert.deepEqual(await input(f, { ...b, ...bs, owner: "owner-b" }), { accepted: true });
  assert.equal(f.channels.length, 1);
});

test("input rejects malformed packets, replay, missing admission and unmatched touch phases", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  for (const event of [
    { ...BEGIN, points: [] },
    { ...BEGIN, points: [{ x: NaN, y: 0 }] },
    { ...BEGIN, points: [{ x: 1.1, y: 0 }] },
    { kind: "button", button: "shutdown" },
    { kind: "rotate", orientation: "bad" },
    { kind: "key", phase: "down", usage: 256 },
    { kind: "key", phase: "down", usage: 4, key: "many characters" },
  ]) {
    await assert.rejects(input(f, v, event), /input|event|point|key/i);
  }
  assert.deepEqual(await input(f, v, { ...BEGIN, phase: "move" }), { accepted: false });
  f.channels[0].state.ready = false;
  assert.deepEqual(await input(f, v, BEGIN, 2), { accepted: false });
  f.channels[0].state.ready = true;
  const status = await f.service.status(v, v.owner);
  assert.deepEqual(await input(f, { ...v, ...status }, BEGIN, 3), { accepted: true });
  assert.deepEqual(await input(f, { ...v, ...status }, BEGIN, 3), { accepted: false });
  assert.deepEqual(await input(f, { ...v, ...status }, { ...BEGIN, phase: "end" }, 4), { accepted: true });
});

test("orientation readback ends held gestures and rejects coordinates from the old frame", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  await input(f, v);
  f.channels[0].state.orientation = "landscape-left";
  assert.deepEqual(await input(f, v, { ...BEGIN, phase: "move" }, 2), { accepted: false });
  const status = await f.service.status(v, v.owner);
  assert.equal(status.orientation, "landscape-left");
  assert.ok(status.generation > v.generation);
  assert.equal(f.events.at(-1).phase, "end");
});

test("rotation invalidates queued old-frame input before config readback arrives", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  assert.deepEqual(await input(f, v, { kind: "rotate", orientation: "landscape-left" }), { accepted: true });
  assert.deepEqual(await input(f, v, BEGIN, 2), { accepted: false });
  assert.equal((await f.service.status(v, v.owner)).ready, false);
  f.channels[0].state.orientation = "landscape-left";
  assert.equal((await f.service.status(v, v.owner)).ready, true);
});

test("viewer close and owner disconnect release media and sockets without stopping the simulator", async (t) => {
  const f = fixture(t),
    a = await controller(f),
    b = await f.service.open({ deviceId: DEVICE.id }, "b");
  await input(f, a);
  assert.equal(await f.service.closeViewer(a, a.owner), null);
  assert.equal(f.events.at(-1).phase, "end");
  assert.equal(f.channels[0].closed, undefined);
  await f.service.disconnect("b");
  assert.equal(f.channels[0].closed, true);
  assert.equal(f.closed.length, 2);
  await assert.rejects(f.service.status(b, "b"), /viewer/i);
});

test("negotiation renews the lease after cumulative startup delays", async (t) => {
  const f = fixture(t),
    owner = "slow-start";
  const viewer = await f.service.open({ deviceId: DEVICE.id }, owner);
  f.advance(11000);
  f.adapter.offer = async () => {
    f.advance(19000);
    return { type: "answer", sdp: "v=0\r\nanswer" };
  };
  await f.service.offer({ viewerId: viewer.viewerId, sdp: "v=0\r\noffer" }, owner);
  f.advance(29000);
  assert.equal((await f.service.control({ viewerId: viewer.viewerId, takeOver: false }, owner)).controlling, true);
  f.advance(30001);
  await assert.rejects(f.service.status(viewer, owner), /viewer|expired/i);
});

test("heartbeat expiry releases abandoned control while status extends active viewers", async (t) => {
  const f = fixture(t, { viewerTtlMs: 100 }),
    a = await controller(f);
  await input(f, a);
  f.advance(75);
  await f.service.status(a, a.owner);
  f.advance(75);
  assert.equal((await f.service.status(a, a.owner)).controlling, true);
  f.advance(101);
  await assert.rejects(f.service.status(a, a.owner), /viewer|expired/i);
  assert.equal(f.events.at(-1).phase, "end");
  assert.equal(f.channels[0].closed, true);
});

test("viewer count remains bounded even for concurrent opens", async (t) => {
  const f = fixture(t, { maxViewers: 2 });
  const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => f.service.open({ deviceId: DEVICE.id }, `owner-${i}`)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(results.filter((r) => r.status === "rejected").length, 2);
});

test("signaling is bounded, uses a private session and cannot renegotiate an existing viewer", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  await assert.rejects(f.service.offer({ ...v, sdp: "x".repeat(262145) }, v.owner), /SDP/i);
  assert.deepEqual(await f.service.offer({ ...v, sdp: "v=0\r\n" }, v.owner), { type: "answer", sdp: "v=0\r\nanswer" });
  assert.notEqual(f.offers[0].sessionId, v.viewerId);
  assert.match(f.offers[0].sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await assert.rejects(f.service.offer({ ...v, sdp: "v=0\r\n" }, v.owner), /offer|negotiat/i);
});

test("disconnect invalidates an in-flight open before it can publish a capability", async (t) => {
  const f = fixture(t);
  let finish, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const connect = f.adapter.connect;
  f.adapter.connect = async (...args) => {
    started();
    await new Promise((resolve) => {
      finish = resolve;
    });
    return connect(...args);
  };
  const opening = f.service.open({ deviceId: DEVICE.id }, "a");
  await ready;
  const disconnecting = f.service.disconnect("a");
  finish();
  await assert.rejects(opening, /disconnect|owner/i);
  await disconnecting;
  assert.equal(f.channels[0].closed, true);
});

test("helper socket loss invalidates input and requires a fresh viewer", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  f.channels[0].state = { ...f.channels[0].state, ready: false, error: "Helper stopped. Reopen the viewer." };
  await assert.rejects(f.service.status(v, v.owner), /Helper stopped/);
  assert.deepEqual(await input(f, v), { accepted: false });
});

test("service shutdown releases held keys, closes viewers and rejects new work", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  await input(f, v, { kind: "key", phase: "down", usage: 4 });
  await f.service.close();
  assert.equal(f.events.at(-1).phase, "up");
  assert.equal(f.channels[0].closed, true);
  assert.equal(f.adapter.stopped, true);
  await assert.rejects(f.service.open({ deviceId: DEVICE.id }, "a"), /closed/i);
});

test("unsupported hosts never start the adapter", async (t) => {
  const f = fixture(t, { supported: false });
  assert.deepEqual(await f.service.list(), { devices: [], supported: false });
  await assert.rejects(f.service.open({ deviceId: DEVICE.id }, "a"), /support/i);
  assert.equal(f.channels.length, 0);
});

test("shutdown stops the helper immediately to interrupt pending negotiation", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  let started, finish;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  f.adapter.offer = async () => {
    started();
    return new Promise((_, reject) => {
      finish = () => reject(new Error("stopped"));
    });
  };
  const stop = f.adapter.stop;
  f.adapter.stop = async () => {
    await stop.call(f.adapter);
    finish();
  };
  const offering = f.service.offer({ ...v, sdp: "v=0\r\n" }, v.owner).catch(() => {});
  await ready;
  const closing = f.service.close();
  await new Promise(setImmediate);
  try {
    assert.equal(f.adapter.stopped, true);
  } finally {
    finish();
    await offering;
    await closing;
  }
});

test("a fresh viewer recovers a crashed shared channel without waiting for other owners to close", async (t) => {
  const f = fixture(t),
    old = await controller(f);
  f.channels[0].state.error = "Helper stopped";
  const next = await f.service.open({ deviceId: DEVICE.id }, "new-owner");
  assert.equal(f.channels.length, 2);
  assert.equal(f.channels[0].closed, true);
  assert.equal((await f.service.status(next, "new-owner")).ready, true);
  await assert.rejects(f.service.status(old, old.owner), /viewer/);
});

test("native input is rate bounded and resumes after the budget refills", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  let accepted = 0;
  for (let sequence = 1; sequence <= 300; sequence++) if ((await input(f, v, { kind: "button", button: "home" }, sequence)).accepted) accepted++;
  assert.equal(accepted, 240);
  assert.equal(f.events.length, 240);
  f.advance(1001);
  assert.deepEqual(await input(f, v, { kind: "button", button: "home" }, 301), { accepted: true });
});

test("Android Back retains its identity and requires the controller lease", async (t) => {
  const f = fixture(t);
  f.adapter.list = async () => [{ ...DEVICE, platform: "android" }];
  const v = await controller(f);
  assert.deepEqual(await input(f, v, { kind: "button", button: "back" }), { accepted: true });
  assert.deepEqual(f.events.at(-1), { kind: "button", button: "back" });
});

test("Back cannot accidentally press Home on an iOS device", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  await assert.rejects(input(f, v, { kind: "button", button: "back" }), /Android/);
  assert.equal(f.events.length, 0);
});

test("Device Hub's input flag reaches the viewer, and only its controller can repair it", async (t) => {
  const f = fixture(t),
    v = await controller(f),
    other = await f.service.open({ deviceId: DEVICE.id }, "owner-b");
  assert.equal(v.deviceHubInputActive, undefined);
  f.channels[0].state = { ...f.channels[0].state, deviceHubInputActive: true };
  const status = await f.service.status({ viewerId: v.viewerId }, v.owner);
  assert.equal(status.deviceHubInputActive, true);
  assert.equal(status.inputBlocked, true, "older clients still need this alias to expose their manual reset action");
  assert.deepEqual(await f.service.input({ viewerId: v.viewerId, generation: v.generation, sequence: 1, event: { kind: "button", button: "home" } }, v.owner), {
    accepted: true,
  });
  assert.equal((await f.service.status({ viewerId: other.viewerId }, "owner-b")).generation, v.generation);
  await assert.rejects(f.service.repair({ viewerId: other.viewerId }, "owner-b"), /control/i);
  await assert.rejects(f.service.repair({ viewerId: v.viewerId }, "owner-b"), /owner/i);
  assert.deepEqual(f.repaired, []);
  assert.equal(await f.service.repair({ viewerId: v.viewerId }, v.owner), null);
  assert.deepEqual(f.repaired, [DEVICE.id]);
  // Every viewer of the device reopens on a fresh input channel.
  assert.equal(f.channels[0].closed, true);
  await assert.rejects(f.service.status({ viewerId: other.viewerId }, "owner-b"), /Reopen/);
  await f.service.open({ deviceId: DEVICE.id }, v.owner);
  assert.equal(f.channels.length, 2);
});

test("relayed frames keep owner checks and do not block input or close behind a slow viewer", async (t) => {
  const f = await fixture(t, { frame: (_after, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true })) });
  const v = await controller(f);
  assert.equal(v.transport, "frames");
  await assert.rejects(f.service.frame({ viewerId: v.viewerId, after: 0 }, "wrong-owner"), /owner/);
  const wait = f.service.frame({ viewerId: v.viewerId, after: 0 }, v.owner);
  await new Promise(setImmediate);
  await assert.rejects(f.service.frame({ viewerId: v.viewerId, after: 0 }, v.owner), /pending/);
  assert.equal((await input(f, v)).accepted, true);
  await f.service.closeViewer({ viewerId: v.viewerId }, v.owner);
  assert.equal(await wait, null);
});

test("frame replies contain current input geometry and keep the viewer alive", async (t) => {
  const f = await fixture(t, { frame: async () => ({ sequence: 2, data: "aW1hZ2U=", mimeType: "image/jpeg" }) });
  const v = await controller(f);
  f.advance(25000);
  const frame = await f.service.frame({ viewerId: v.viewerId, after: 0 }, v.owner);
  assert.equal(frame.data, "aW1hZ2U=");
  assert.equal(frame.status.generation, v.generation);
  assert.equal(frame.status.controlling, true);
  f.advance(25000);
  assert.equal((await f.service.status({ viewerId: v.viewerId }, v.owner)).ready, true);
});
