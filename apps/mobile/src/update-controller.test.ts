import assert from "node:assert/strict";
import { test } from "node:test";
import { createUpdateController, watchUpdates, type NativeUpdateState } from "./update-controller.ts";

const idle: NativeUpdateState = { isStartupProcedureRunning: false, isChecking: false, isDownloading: false, isUpdatePending: false };

test("ready updates keep polling, skip the same ID, and replace stale native pending state with the latest download", async () => {
  let id = "first",
    downloads = 0;
  const manifest = () => ({ id, extra: { expoClient: { extra: { releaseNotes: `Notes for ${id}` } } } });
  const download = deferred<{ isNew: boolean; isRollBackToEmbedded: boolean; manifest: unknown }>();
  const controller = createUpdateController({
    enabled: true,
    check: async () => ({ isAvailable: true, isRollBackToEmbedded: false, manifest: manifest() }),
    fetch: async () => {
      downloads++;
      return download.promise;
    },
    reload: async () => {},
  });
  const native = { ...idle, isUpdatePending: true, downloadedUpdate: { updateId: id, manifest: manifest() } };
  controller.syncNative(native);
  await controller.check(true);
  assert.equal(downloads, 0);
  id = "second";
  const checking = controller.check(true);
  await Promise.resolve();
  assert.equal(controller.get().status, "downloading");
  controller.syncNative(native);
  assert.equal(controller.get().status, "downloading");
  download.resolve({ isNew: true, isRollBackToEmbedded: false, manifest: manifest() });
  await checking;
  controller.syncNative(native);
  assert.equal(downloads, 1);
  assert.equal(controller.get().updateId, "second");
  assert.equal(controller.get().releaseNotes, "Notes for second");
  assert.equal(controller.get().status, "ready");
});

test("an offline check or no newer release keeps a pending update ready", async () => {
  const { controller, failCheck, available } = setup();
  await controller.check();
  failCheck(true);
  await controller.check(true);
  assert.equal(controller.get().status, "ready");
  failCheck(false);
  available(false);
  await controller.check(true);
  assert.equal(controller.get().status, "ready");
});

test("a failed replacement is retryable and an old native pending flag cannot offer the stale update", async () => {
  const { controller, failDownload, setNative, counts } = setup();
  setNative({ isUpdatePending: true, downloadedUpdate: { updateId: "old" } });
  failDownload(true);
  await controller.check(true);
  controller.syncNative();
  assert.equal(controller.get().status, "error");
  await controller.install();
  assert.equal(counts().reloads, 0);
  failDownload(false);
  await controller.check(true);
  assert.equal(controller.get().status, "ready");
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup() {
  let now = 0,
    checks = 0,
    downloads = 0,
    reloads = 0;
  let available = true,
    downloadFails = false,
    reloadFails = false,
    checkFails = false;
  const controller = createUpdateController({
    enabled: true,
    now: () => now,
    check: async () => {
      checks++;
      if (checkFails) throw new Error("Offline");
      return { isAvailable: available, isRollBackToEmbedded: false };
    },
    fetch: async () => {
      downloads++;
      if (downloadFails) throw new Error("Offline");
      return { isNew: true, isRollBackToEmbedded: false };
    },
    reload: async () => {
      reloads++;
      if (reloadFails) throw new Error("Reload failed");
    },
  });
  return {
    controller,
    counts: () => ({ checks, downloads, reloads }),
    setNative: (value: Partial<NativeUpdateState>) => controller.syncNative({ ...idle, ...value }),
    advance: (ms: number) => {
      now += ms;
    },
    available: (value: boolean) => {
      available = value;
    },
    failDownload: (value: boolean) => {
      downloadFails = value;
    },
    failReload: (value: boolean) => {
      reloadFails = value;
    },
    failCheck: (value: boolean) => {
      checkFails = value;
    },
  };
}

test("downloads an update while the app stays open and reloads only on request", async () => {
  const { controller, counts } = setup();
  await controller.check();
  assert.equal(controller.get().status, "ready");
  assert.deepEqual(counts(), { checks: 1, downloads: 1, reloads: 0 });
  await controller.check(true);
  assert.equal(counts().checks, 2, "a pending update must still check for newer releases");
  await controller.install();
  assert.equal(counts().reloads, 1);
  assert.equal(controller.get().status, "restarting");
  await controller.install();
  assert.equal(counts().reloads, 1);
});

test("observes a download from the native startup check without making another request", async () => {
  const { controller, setNative, counts } = setup();
  setNative({ isStartupProcedureRunning: true, isDownloading: true });
  controller.syncNative();
  assert.equal(controller.get().status, "downloading");
  await controller.check();
  setNative({ isUpdatePending: true });
  controller.syncNative();
  await controller.check();
  assert.equal(controller.get().status, "ready");
  assert.deepEqual(counts(), { checks: 0, downloads: 0, reloads: 0 });
});

test("overlapping checks share a download and expose its pending state", async () => {
  const download = deferred<{ isNew: boolean; isRollBackToEmbedded: boolean }>();
  let downloads = 0;
  const controller = createUpdateController({
    enabled: true,
    check: async () => ({ isAvailable: true, isRollBackToEmbedded: false }),
    fetch: () => {
      downloads++;
      return download.promise;
    },
    reload: async () => {},
  });
  const first = controller.check();
  const second = controller.check();
  await Promise.resolve();
  assert.equal(controller.get().status, "downloading");
  assert.equal(downloads, 1);
  download.resolve({ isNew: true, isRollBackToEmbedded: false });
  await Promise.all([first, second]);
  assert.equal(controller.get().status, "ready");
});

test("throttles foreground checks but an explicit retry bypasses the wait", async () => {
  const { controller, available, advance, counts } = setup();
  available(false);
  await controller.check();
  await controller.check();
  advance(59999);
  await controller.check();
  assert.equal(counts().checks, 1);
  advance(1);
  await controller.check();
  assert.equal(counts().checks, 2);
  await controller.check(true);
  assert.equal(counts().checks, 3);
  assert.equal(controller.get().status, "up-to-date");
  await controller.install();
  assert.equal(counts().reloads, 0);
});

test("failed downloads can retry and a failed reload keeps the downloaded update ready", async () => {
  const { controller, failDownload, failReload, counts } = setup();
  failDownload(true);
  await controller.check();
  assert.equal(controller.get().status, "error");
  assert.ok(controller.get().error);
  failDownload(false);
  await controller.check(true);
  assert.equal(controller.get().status, "ready");
  failReload(true);
  await controller.install();
  assert.equal(controller.get().status, "ready");
  assert.ok(controller.get().error);
  controller.syncNative();
  assert.ok(controller.get().error, "native state updates must not erase the retry notice");
  failReload(false);
  await controller.install();
  assert.equal(controller.get().status, "restarting");
  assert.deepEqual(counts(), { checks: 2, downloads: 2, reloads: 2 });
});

test("offline checks do not show a false update notice and recover on the next check", async () => {
  const { controller, failCheck, advance } = setup();
  failCheck(true);
  await controller.check();
  assert.equal(controller.get().status, "idle");
  failCheck(false);
  advance(60000);
  await controller.check();
  assert.equal(controller.get().status, "ready");
});

test("a late check cannot hide or replace an update already being applied", async () => {
  const checking = deferred<{ isAvailable: boolean; isRollBackToEmbedded: boolean }>();
  const controller = createUpdateController({
    enabled: true,
    check: () => checking.promise,
    fetch: async () => ({ isNew: true, isRollBackToEmbedded: false }),
    reload: async () => {},
  });
  const pending = controller.check();
  controller.syncNative({ ...idle, isUpdatePending: true });
  const installing = controller.install();
  checking.resolve({ isAvailable: false, isRollBackToEmbedded: false });
  await Promise.all([pending, installing]);
  assert.equal(controller.get().status, "restarting");
});

test("supports rollback updates and does not offer reload when nothing was downloaded", async () => {
  for (const rollback of [true, false]) {
    const controller = createUpdateController({
      enabled: true,
      check: async () => ({ isAvailable: !rollback, isRollBackToEmbedded: rollback }),
      fetch: async () => ({ isNew: false, isRollBackToEmbedded: rollback }),
      reload: async () => {},
    });
    await controller.check();
    assert.equal(controller.get().status, rollback ? "ready" : "error");
  }
});

test("development builds never call the update APIs", async () => {
  const unexpected = async () => {
    assert.fail("updates are disabled");
  };
  const controller = createUpdateController({ enabled: false, check: unexpected, fetch: unexpected, reload: unexpected });
  controller.syncNative({ ...idle, isUpdatePending: true });
  await controller.check(true);
  await controller.install();
  assert.equal(controller.get().status, "disabled");
});

test("manual checks report progress, no update, and a retryable connection failure", async () => {
  const checking = deferred<{ isAvailable: boolean; isRollBackToEmbedded: boolean }>();
  const controller = createUpdateController({
    enabled: true,
    check: () => checking.promise,
    fetch: async () => ({ isNew: true, isRollBackToEmbedded: false }),
    reload: async () => {},
  });
  const pending = controller.check(true);
  assert.equal(controller.get().status, "checking");
  checking.resolve({ isAvailable: false, isRollBackToEmbedded: false });
  await pending;
  assert.equal(controller.get().status, "up-to-date");
  const failing = setup();
  failing.failCheck(true);
  await failing.controller.check(true);
  assert.equal(failing.controller.get().status, "check-error");
  assert.ok(failing.controller.get().error);
  failing.failCheck(false);
  await failing.controller.check(true);
  assert.equal(failing.controller.get().status, "ready");
});

test("a native startup check counts toward the foreground rate limit", async () => {
  const { controller, setNative, advance, counts } = setup();
  setNative({ isStartupProcedureRunning: true, isChecking: true });
  await controller.check();
  setNative({});
  await controller.check();
  assert.equal(counts().checks, 0, "startup must not immediately trigger another network check");
  advance(60000);
  await controller.check();
  assert.equal(counts().checks, 1);
});

test("checks in the foreground and cleans up both its timer and app-state listener", async () => {
  const state = setup();
  state.available(false);
  let active = true,
    tick = () => {},
    changed = () => {},
    timerRemoved = false,
    listenerRemoved = false;
  const stop = watchUpdates(state.controller, {
    active: () => active,
    watchActive: (listener) => {
      changed = listener;
      return () => {
        listenerRemoved = true;
      };
    },
    schedule: (refresh, delay) => {
      assert.ok(delay >= 15 * 60000);
      tick = refresh;
      return () => {
        timerRemoved = true;
      };
    },
  });
  await Promise.resolve();
  assert.equal(state.counts().checks, 1);
  active = false;
  state.advance(15 * 60000);
  tick();
  changed();
  await Promise.resolve();
  assert.equal(state.counts().checks, 1);
  active = true;
  changed();
  await Promise.resolve();
  assert.equal(state.counts().checks, 2);
  stop();
  state.advance(15 * 60000);
  tick();
  changed();
  await Promise.resolve();
  assert.equal(state.counts().checks, 2);
  assert.ok(timerRemoved && listenerRemoved);
});
