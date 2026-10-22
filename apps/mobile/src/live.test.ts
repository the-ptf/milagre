import { test } from "node:test";
import assert from "node:assert/strict";
import { LIVE_ORIGIN, openLive, syncProject, type LiveSocket, type Timers } from "./live.ts";
import { createClient } from "./client.ts";

// Timers that only run when the test says so, recording each wait.
function clock() {
  const queue: { fn: () => void; ms: number }[] = [];
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const timer = { fn, ms };
      queue.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      const index = queue.indexOf(timer as never);
      if (index !== -1) queue.splice(index, 1);
    },
  };
  /** Runs the pending timer that waits `ms`, or the next one; returns how long it waited. */
  const run = (ms?: number) => {
    const index = ms === undefined ? 0 : queue.findIndex((timer) => timer.ms === ms);
    assert.ok(index !== -1, `No timer waiting ${ms ?? ""}ms; waiting: ${queue.map((timer) => timer.ms).join(", ")}`);
    const [timer] = queue.splice(index, 1);
    assert.ok(timer !== undefined);
    timer.fn();
    return timer.ms;
  };
  return { timers, run, queue };
}
type Fake = LiveSocket & { url: string; headers: Record<string, string>; closed?: number; emit(type: string, event?: object): void };
function sockets() {
  const made: Fake[] = [];
  const create = (url: string, headers: Record<string, string>) => {
    const target = new EventTarget();
    const socket: Fake = {
      url,
      headers,
      addEventListener: target.addEventListener.bind(target) as LiveSocket["addEventListener"],
      emit(type, event = {}) {
        target.dispatchEvent(Object.assign(new Event(type), event));
      },
      close(code) {
        socket.closed = code ?? 1005;
      },
    };
    made.push(socket);
    return socket;
  };
  return { made, create };
}

test("the live socket reconnects with growing waits until it opens, then starts over", () => {
  const { timers, run } = clock();
  const { made, create } = sockets();
  const status: boolean[] = [];
  openLive("ws://127.0.0.1:1/live", { Authorization: "Bearer t" }, { onSignal() {}, onStatus: (open) => status.push(open), create, timers, random: () => 0.5 });
  assert.ok(made[0] !== undefined);
  assert.deepEqual(made[0].headers, { Authorization: "Bearer t", Origin: LIVE_ORIGIN });
  const waits = [];
  for (let i = 0; i < 6; i++) {
    // React Native reports a failed connect as an error and then a close; that is one failure.
    made.at(-1)!.emit("error", { message: "Connection refused" });
    made.at(-1)!.emit("close");
    waits.push(run());
  }
  assert.deepEqual(waits, [1000, 2000, 5000, 10000, 30000, 30000]);
  assert.equal(made.length, 7);
  assert.deepEqual(status, [], "a socket that never opened changes nothing for the session");
  assert.ok(made[6] !== undefined);
  made[6].emit("open");
  made[6].emit("close");
  assert.deepEqual(status, [true, false]);
  assert.equal(run(), 1000, "an open socket resets the backoff");
});

test("signals pass through, pings only keep the socket alive, and a silent socket is replaced", () => {
  const { timers, run, queue } = clock();
  const { made, create } = sockets();
  const signals: string[] = [];
  const status: boolean[] = [];
  openLive(
    "wss://mac.example/live",
    {},
    { onSignal: (signal) => signals.push(signal), onStatus: (open) => status.push(open), create, timers, random: () => 0.5 },
  );
  assert.ok(made[0] !== undefined);
  made[0].emit("open");
  for (const data of ['{"type":"runs"}', '{"type":"ping"}', "not json", '{"type":"project"}', '{"type":"state","state":{}}']) made[0].emit("message", { data });
  assert.deepEqual(signals, ["runs", "project"]);
  assert.deepEqual(
    queue.map((timer) => timer.ms),
    [60000],
  );
  run(60000);
  assert.equal(made[0].closed, 1005);
  assert.deepEqual(status, [true, false]);
  run(1000);
  assert.equal(made.length, 2);
  made[0].emit("message", { data: '{"type":"runs"}' });
  assert.deepEqual(signals, ["runs", "project"], "a replaced socket is ignored");
});

test("an older bridge refusing the upgrade is asked again only after minutes, and close stops everything", () => {
  const { timers, run, queue } = clock();
  const { made, create } = sockets();
  const live = openLive("ws://127.0.0.1:1/live", {}, { onSignal() {}, onStatus() {}, create, timers, random: () => 0.5 });
  assert.ok(made[0] !== undefined);
  made[0].emit("error", { message: "Expected HTTP 101 response but was '404 Not Found'" });
  assert.equal(run(), 300000);
  assert.ok(made[1] !== undefined);
  made[1].emit("open");
  live.close();
  assert.equal(made[1].closed, 1000);
  made[1].emit("close");
  assert.deepEqual(queue, [], "nothing reconnects after close");
});

test("the client opens its live socket on the same address and headers as its requests", () => {
  const { made, create } = sockets();
  const access = { id: `${"c".repeat(32)}.access`, secret: "S".repeat(43) };
  createClient({ address: "https://mac.example.cloud", token: "token", access }, fetch, 30000)
    .live("/Users/me/My Project", { onSignal() {}, onStatus() {}, create })
    .close();
  assert.ok(made[0] !== undefined);
  assert.equal(made[0].url, "wss://mac.example.cloud/live?projectPath=%2FUsers%2Fme%2FMy%20Project");
  assert.deepEqual(made[0].headers, {
    Authorization: "Bearer token",
    "CF-Access-Client-Id": access.id,
    "CF-Access-Client-Secret": access.secret,
    Origin: LIVE_ORIGIN,
  });
  createClient({ address: "http://127.0.0.1:8787", token: "token" })
    .live("/p", { onSignal() {}, onStatus() {}, create })
    .close();
  assert.ok(made[1] !== undefined);
  assert.match(made[1].url, /^ws:\/\/127\.0\.0\.1:8787\/live\?/);
});

test("signals during a fetch collapse into one, and a Project fetch covers the runs", async () => {
  const { timers } = clock();
  let release!: () => void;
  const fetched: string[] = [];
  let options!: { onSignal: (signal: "runs" | "project") => void; onStatus: (open: boolean) => void };
  const stop = syncProject({
    connect: (given) => {
      options = given;
      return { close() {} };
    },
    snapshot: () => {
      fetched.push("project");
      return fetched.length === 1
        ? new Promise<void>((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    },
    runs: async () => {
      fetched.push("runs");
    },
    onError: () => {},
    active: () => true,
    watchActive: () => () => {},
    pollDelay: () => 4000,
    timers,
  });
  options.onSignal("runs");
  options.onSignal("project");
  options.onSignal("runs");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetched, ["project", "project"]);
  options.onSignal("runs");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fetched, ["project", "project", "runs"]);
  stop();
});

test("account changes pass through the socket and refresh account state without fetching a Project", () => {
  const { timers } = clock();
  const { made, create } = sockets();
  let accountChanges = 0;
  const stop = syncProject({
    connect: (options) => openLive("ws://mac/live", {}, { ...options, create, timers }),
    snapshot: async () => {},
    runs: async () => {
      throw new Error("Accounts must not fetch runs");
    },
    accounts: () => {
      accountChanges++;
    },
    onError: (error) => {
      throw error;
    },
    active: () => true,
    watchActive: () => () => {},
    pollDelay: () => 1000,
    timers,
  });
  assert.ok(made[0] !== undefined);
  made[0].emit("message", { data: '{"type":"accounts"}' });
  assert.equal(accountChanges, 1);
  stop();
});

test("a Link change passes through the socket and rereads the Links without fetching a Project", () => {
  const { timers } = clock();
  const { made, create } = sockets();
  let linkChanges = 0;
  const stop = syncProject({
    connect: (options) => openLive("ws://mac/live", {}, { ...options, create, timers }),
    snapshot: async () => {},
    runs: async () => {
      throw new Error("Links must not fetch runs");
    },
    links: () => {
      linkChanges++;
    },
    onError: (error) => {
      throw error;
    },
    active: () => true,
    watchActive: () => () => {},
    pollDelay: () => 1000,
    timers,
  });
  assert.ok(made[0] !== undefined);
  made[0].emit("open");
  assert.equal(linkChanges, 1, "opening the socket catches up on Links changed while it was down");
  made[0].emit("message", { data: '{"type":"links"}' });
  assert.equal(linkChanges, 2);
  // A signal a newer bridge adds later is ignored.
  made[0].emit("message", { data: '{"type":"something-new"}' });
  assert.equal(linkChanges, 2);
  stop();
});

test("Designs changes and connection status use the existing Project socket without fetching Project state", async () => {
  const { timers } = clock();
  const { made, create } = sockets();
  let designs = 0;
  let snapshots = 0;
  const statuses: boolean[] = [];
  const stop = syncProject({
    connect: (options) => openLive("ws://mac/live?projectPath=/allowed", {}, { ...options, create, timers }),
    snapshot: async () => {
      snapshots++;
    },
    runs: async () => {
      throw new Error("A Designs signal must not fetch runs");
    },
    designs: () => {
      designs++;
    },
    liveStatus: (open) => statuses.push(open),
    onError: (error) => {
      throw error;
    },
    active: () => true,
    watchActive: () => () => {},
    pollDelay: () => 4000,
    timers,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(made[0] !== undefined);
  made[0].emit("open");
  await new Promise((resolve) => setImmediate(resolve));
  const beforeSignal = snapshots;
  made[0].emit("message", { data: '{"type":"designs"}' });
  assert.equal(designs, 1);
  assert.equal(snapshots, beforeSignal);
  made[0].emit("close");
  assert.deepEqual(statuses, [true, false]);
  stop();
});

test("a Routines change passes through the socket without fetching the Project or its runs", async () => {
  const { timers } = clock();
  const { made, create } = sockets();
  const signals: string[] = [];
  let snapshots = 0;
  const stop = syncProject({
    connect: (options) =>
      openLive(
        "ws://mac/live",
        {},
        {
          ...options,
          onSignal: (signal) => {
            signals.push(signal);
            options.onSignal(signal);
          },
          create,
          timers,
        },
      ),
    snapshot: async () => {
      snapshots++;
    },
    runs: async () => {
      throw new Error("A Routines signal must not fetch runs");
    },
    onError: (error) => {
      throw error;
    },
    active: () => true,
    watchActive: () => () => {},
    pollDelay: () => 4000,
    timers,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(made[0] !== undefined);
  made[0].emit("open");
  await new Promise((resolve) => setImmediate(resolve));
  const before = snapshots;
  made[0].emit("message", { data: '{"type":"routines"}' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ["routines"], "the app knows the routines signal");
  assert.equal(snapshots, before);
  stop();
});

test("a usage signal reaches subscribers without fetching Project state", () => {
  const { timers } = clock();
  const { made, create } = sockets();
  const signals: string[] = [];
  const live = openLive("ws://mac/live", {}, { onSignal: (signal) => signals.push(signal), onStatus() {}, create, timers });
  made[0]!.emit("message", { data: '{"type":"usage"}' });
  assert.deepEqual(signals, ["usage"]);
  live.close();
});
