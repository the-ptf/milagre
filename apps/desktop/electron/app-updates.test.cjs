const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createAppUpdates, createAutoInstall, watchAppUpdates, INPUT_IDLE_SECONDS } = require("./app-updates.cjs");
function fixture() {
  let time = 0,
    checks = 0,
    stops = 0,
    installs = 0;
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => {
    checks++;
    updater.emit("update-not-available");
  };
  updater.quitAndInstall = () => {
    installs++;
  };
  const controller = createAppUpdates({
    updater,
    enabled: true,
    prepare: async () => {},
    stopHost: async () => {
      stops++;
    },
    publish() {},
    now: () => time,
  });
  return {
    updater,
    controller,
    advance: (ms) => {
      time += ms;
    },
    counts: () => ({ checks, stops, installs }),
  };
}
test("startup, focus and wake find releases without reopening the app; rapid focus is throttled and quit cleans up", async () => {
  const f = fixture(),
    app = new EventEmitter(),
    power = new EventEmitter();
  let tick,
    cancelled = false;
  watchAppUpdates(f.controller, {
    app,
    powerMonitor: power,
    schedule: (callback, ms) => {
      tick = () => {
        f.advance(ms);
        callback();
      };
      return () => {
        cancelled = true;
      };
    },
  });
  await new Promise(setImmediate);
  app.emit("browser-window-focus");
  assert.equal(f.counts().checks, 1);
  f.advance(60000);
  app.emit("browser-window-focus");
  await new Promise(setImmediate);
  assert.equal(f.counts().checks, 2);
  tick();
  await new Promise(setImmediate);
  assert.equal(f.counts().checks, 3);
  f.advance(60000);
  power.emit("resume");
  await new Promise(setImmediate);
  assert.equal(f.counts().checks, 4);
  app.emit("will-quit");
  assert.equal(cancelled, true);
  assert.equal(power.listenerCount("resume"), 0);
});
test("checks coalesce and an empty background check keeps the ready download", async () => {
  const f = fixture();
  let release;
  f.updater.checkForUpdates = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const first = f.controller.check(true),
    second = f.controller.check(true);
  assert.equal(first, second);
  await new Promise(setImmediate);
  f.updater.emit("update-downloaded", { version: "1.2.3" });
  release();
  await first;
  f.updater.checkForUpdates = async () => f.updater.emit("update-not-available");
  await f.controller.check(true);
  assert.equal(f.controller.get().status, "downloaded");
  assert.equal(f.controller.get().version, "1.2.3");
});

test("polling replaces a pending installer with the newest release, skipping the same or older version", async () => {
  const f = fixture();
  let version = "1.2.3",
    downloads = [];
  f.updater.checkForUpdates = async () => {
    f.updater.emit("update-available", { version });
    return { isUpdateAvailable: true, updateInfo: { version } };
  };
  f.updater.downloadUpdate = async () => {
    downloads.push(version);
    f.updater.emit("update-downloaded", { version });
  };
  assert.equal(f.updater.autoDownload, false);
  await f.controller.check();
  await f.controller.check(true);
  version = "1.2.2";
  await f.controller.check(true);
  assert.deepEqual(downloads, ["1.2.3"]);
  version = "1.2.4";
  f.advance(60000);
  await f.controller.check();
  assert.deepEqual(downloads, ["1.2.3", "1.2.4"]);
  assert.equal(f.controller.get().version, "1.2.4");
  assert.equal(f.controller.get().status, "downloaded");
});

test("offline refresh preserves the ready installer, but a failed replacement disables installation until retry", async () => {
  const f = fixture();
  f.updater.emit("update-downloaded", { version: "1.2.3" });
  f.updater.checkForUpdates = async () => {
    f.updater.emit("error");
    throw new Error("offline");
  };
  await f.controller.check(true);
  assert.equal(f.controller.get().status, "downloaded");
  f.updater.checkForUpdates = async () => {
    f.updater.emit("update-available", { version: "1.2.4" });
    return { isUpdateAvailable: true, updateInfo: { version: "1.2.4" } };
  };
  f.updater.downloadUpdate = async () => {
    throw new Error("download failed");
  };
  await f.controller.check(true);
  assert.equal(f.controller.get().status, "error");
  await f.controller.install();
  assert.equal(f.counts().stops, 0);
  f.updater.downloadUpdate = async () => f.updater.emit("update-downloaded", { version: "1.2.4" });
  await f.controller.check(true);
  assert.equal(f.controller.get().status, "downloaded");
});

test("install waits for an active refresh and applies its replacement only once", async () => {
  const f = fixture();
  f.updater.emit("update-downloaded", { version: "1.2.3" });
  let finish;
  f.updater.checkForUpdates = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  f.updater.downloadUpdate = async () => f.updater.emit("update-downloaded", { version: "1.2.4" });
  const refresh = f.controller.check(true);
  const install = f.controller.install();
  assert.equal(f.controller.install(), install);
  await new Promise(setImmediate);
  assert.equal(f.counts().stops, 0);
  f.updater.emit("update-available", { version: "1.2.4" });
  finish({ isUpdateAvailable: true, updateInfo: { version: "1.2.4" } });
  await Promise.all([refresh, install]);
  assert.equal(f.controller.get().version, "1.2.4");
  assert.equal(f.counts().installs, 1);
});
test("only a downloaded update can stop agents; duplicate install clicks stop the host once", async () => {
  const f = fixture();
  await f.controller.install();
  assert.equal(f.counts().stops, 0);
  f.updater.emit("update-downloaded", { version: "1.2.3" });
  await Promise.all([f.controller.install(), f.controller.install()]);
  assert.deepEqual(f.counts(), { checks: 0, stops: 1, installs: 1 });
  assert.equal(f.controller.get().status, "installing");
});
test("failed host shutdown keeps the downloaded update retryable and does not run the installer", async () => {
  const updater = new EventEmitter();
  let attempts = 0,
    installs = 0;
  updater.quitAndInstall = () => {
    installs++;
  };
  const controller = createAppUpdates({
    updater,
    enabled: true,
    prepare: async () => {},
    publish() {},
    stopHost: async () => {
      if (++attempts === 1) throw new Error("save failed");
    },
  });
  updater.emit("update-downloaded", { version: "1.2.3" });
  await controller.install();
  assert.equal(controller.get().status, "downloaded");
  assert.match(controller.get().error, /restart/i);
  assert.equal(installs, 0);
  await controller.install();
  assert.equal(installs, 1);
});
test("offline check and failed download retry without losing the known version", async () => {
  const f = fixture();
  f.updater.checkForUpdates = async () => {
    throw new Error("offline");
  };
  await f.controller.check(true);
  assert.equal(f.controller.get().status, "error");
  f.updater.checkForUpdates = async () => {
    f.updater.emit("update-available", { version: "1.2.3" });
    f.updater.emit("error", new Error("download failed"));
  };
  await f.controller.check(true);
  assert.equal(f.controller.get().version, "1.2.3");
  assert.match(f.controller.get().error, /download/i);
  f.updater.checkForUpdates = async () => {
    f.updater.emit("update-downloaded", { version: "1.2.3" });
  };
  await f.controller.check(true);
  assert.equal(f.controller.get().status, "downloaded");
  assert.equal(f.controller.get().error, undefined);
});

test("auto update shows on the state and installs only after two quiet checks with nobody at the Mac", async () => {
  const published = [];
  const f = fixture();
  const updates = createAppUpdates({
    updater: f.updater,
    enabled: true,
    prepare: async () => {},
    stopHost: async () => {},
    publish: (state) => published.push(state),
  });
  let installs = 0;
  f.updater.quitAndInstall = () => {
    installs++;
  };
  let busy = { chats: 1, routines: 0 };
  let idle = INPUT_IDLE_SECONDS;
  const auto = createAutoInstall(updates, { activity: async () => busy, inputIdleSeconds: () => idle });
  f.updater.emit("update-downloaded", { version: "1.2.3" });
  assert.equal(await auto.tick(), false, "off by default");
  updates.setAuto(true);
  assert.equal(published.at(-1).auto, true);
  assert.equal(await auto.tick(), false, "a Chat is running");
  busy = { chats: 0, routines: 1 };
  assert.equal(await auto.tick(), false, "a Routine Run is under way");
  busy = { chats: 0, routines: 0 };
  idle = INPUT_IDLE_SECONDS - 1;
  assert.equal(await auto.tick(), false, "someone used the Mac recently");
  idle = INPUT_IDLE_SECONDS;
  assert.equal(await auto.tick(), false, "the first quiet check only counts");
  busy = { chats: 1, routines: 0 };
  assert.equal(await auto.tick(), false, "a busy check starts the count over");
  busy = { chats: 0, routines: 0 };
  assert.equal(await auto.tick(), false);
  assert.equal(installs, 0);
  assert.equal(await auto.tick(), true);
  assert.equal(installs, 1);
  assert.equal(updates.get().status, "installing");
});

test("auto update waits while the host can't answer, and gives up on a version whose install failed", async () => {
  const f = fixture();
  let stops = 0;
  const updates = createAppUpdates({
    updater: f.updater,
    enabled: true,
    prepare: async () => {},
    publish() {},
    stopHost: async () => {
      stops++;
      throw new Error("save failed");
    },
  });
  let hostUp = false;
  const activity = async () => {
    if (!hostUp) throw new Error("host gone");
    return { chats: 0, routines: 0 };
  };
  const auto = createAutoInstall(updates, { activity, inputIdleSeconds: () => INPUT_IDLE_SECONDS });
  updates.setAuto(true);
  f.updater.emit("update-downloaded", { version: "1.2.3" });
  for (let i = 0; i < 3; i++) assert.equal(await auto.tick(), false);
  hostUp = true;
  await auto.tick();
  assert.equal(await auto.tick(), true);
  assert.equal(stops, 1);
  assert.equal(updates.get().status, "downloaded");
  for (let i = 0; i < 3; i++) assert.equal(await auto.tick(), false, "the notice offers Install & restart instead");
  assert.equal(stops, 1);
  f.updater.emit("update-downloaded", { version: "1.2.4" });
  await auto.tick();
  assert.equal(await auto.tick(), true, "a newer version tries again");
  assert.equal(stops, 2);
});

test("the auto update check runs every minute next to the five-minute refresh", async () => {
  const f = fixture(),
    app = new EventEmitter(),
    power = new EventEmitter();
  const intervals = [];
  let ticks = 0;
  watchAppUpdates(f.controller, {
    app,
    powerMonitor: power,
    autoInstall: { tick: async () => ticks++ },
    schedule: (callback, ms) => {
      intervals.push({ callback, ms, cancelled: false });
      const entry = intervals.at(-1);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  assert.deepEqual(
    intervals.map((entry) => entry.ms),
    [5 * 60000, 60000],
  );
  intervals[1].callback();
  assert.equal(ticks, 1);
  app.emit("will-quit");
  assert.ok(intervals.every((entry) => entry.cancelled));
});
