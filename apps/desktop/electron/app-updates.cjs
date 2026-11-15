// @ts-check
const { isChannelNotPublished, isNewerRelease } = require("./release-channel.cjs");

/**
 * An updater that loads on the first check: electron-updater takes tens of milliseconds to require, and nothing needs it
 * while the app launches. Settings and listeners made before then wait for it.
 * @param {() => any} load
 */
function deferUpdater(load) {
  let updater = null;
  /** @type {((updater: any) => void)[]} */
  const waiting = [];
  const whenLoaded = (apply) => (updater ? apply(updater) : waiting.push(apply));
  const loaded = () => {
    if (!updater) {
      updater = load();
      for (const apply of waiting.splice(0)) apply(updater);
    }
    return updater;
  };
  return {
    loaded,
    set autoDownload(value) {
      whenLoaded((target) => {
        target.autoDownload = value;
      });
    },
    set autoInstallOnAppQuit(value) {
      whenLoaded((target) => {
        target.autoInstallOnAppQuit = value;
      });
    },
    on: (event, listener) => void whenLoaded((target) => target.on(event, listener)),
    checkForUpdates: () => loaded().checkForUpdates(),
    downloadUpdate: () => loaded().downloadUpdate(),
    quitAndInstall: () => loaded().quitAndInstall(),
  };
}

// How long the app may take to quit once it has handed the update over. Past this it never will (the installer failed
// or a window refused to close): with its host already stopped, it starts again rather than sit there without one.
const QUIT_TIMEOUT_MS = 60_000;
// How long macOS's updater may take to unpack and verify the downloaded update before the host stops.
const STAGE_TIMEOUT_MS = 3 * 60_000;

/**
 * Hands a downloaded update to macOS's updater (Squirrel.Mac) and waits until it has unpacked and verified it.
 * electron-updater only does this when the app quits (autoInstallOnAppQuit) or inside quitAndInstall; both happen after
 * the host has stopped, so a failure there left the Mac without a host. Done first, quitAndInstall only relaunches.
 * @param {{ squirrelDownloadedUpdate?: boolean }} target electron-updater's MacUpdater
 * @param {import('node:events').EventEmitter & { checkForUpdates(): void }} native Electron's autoUpdater
 */
function stageNativeUpdate(target, native, { timeoutMs = STAGE_TIMEOUT_MS } = {}) {
  if (target.squirrelDownloadedUpdate) return Promise.resolve();
  return new Promise((resolve, reject) => {
    /** @param {Error} [error] */
    const finish = (error) => {
      clearTimeout(timer);
      native.removeListener("update-downloaded", ready);
      native.removeListener("update-not-available", none);
      native.removeListener("error", fail);
      if (error) reject(error);
      else resolve(undefined);
    };
    const ready = () => finish();
    const none = () => finish(new Error("macOS's updater found no update to install"));
    const fail = (error) => finish(error instanceof Error ? error : new Error(String(error)));
    const timer = setTimeout(() => finish(new Error("macOS's updater took too long to prepare the update")), timeoutMs);
    native.on("update-downloaded", ready);
    native.on("update-not-available", none);
    native.on("error", fail);
    try {
      native.checkForUpdates();
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * One updater owns downloads, background checks, and explicit host shutdown for installation. An install prepares the
 * update first (`stage`), then stops the host, then quits: a failure before the host stops leaves everything running,
 * one while it stops brings it back (`resumeHost`), and a quit that never comes starts Milagre again (`relaunch`).
 */
function createAppUpdates({
  updater,
  enabled,
  prepare,
  stage = async () => {},
  stopHost,
  resumeHost = async () => {},
  prepareQuit = async () => {},
  relaunch = () => {},
  publish,
  log = (/** @type {string} */ _line) => {},
  now = Date.now,
  setTimer = (/** @type {() => void} */ callback, /** @type {number} */ ms) => void setTimeout(callback, ms).unref(),
}) {
  /** @type {import('../app/src/electron').UpdateState} */
  let state = { status: "idle", version: null, progress: 0, auto: false };
  /** @type {Promise<typeof state> | null} */
  let checking = null;
  /** @type {Promise<void> | null} */
  let installing = null;
  /** Where an install is: its errors are the step's own until it quits (see failed). */
  let phase = /** @type {"" | "staging" | "stopping" | "quitting"} */ ("");
  let lastCheck = -Infinity;
  /** @param {Partial<typeof state>} next */
  const update = (next) => {
    const before = state;
    state = { ...state, ...next };
    if (state.status !== before.status || (state.error && state.error !== before.error))
      log(`${state.status}${state.version ? ` ${state.version}` : ""}${state.error ? `: ${state.error}` : ""}`);
    publish(state);
    return state;
  };
  const reason = (error) => (error instanceof Error ? error.message : String(error));
  // The host is stopped and the app did not quit to install: start Milagre again, with its host, rather than leave it.
  let gaveUp = false;
  const giveUp = (error) => {
    if (gaveUp) return;
    gaveUp = true;
    log(`install did not quit: ${reason(error)}. Starting Milagre again.`);
    update({ status: "downloaded", error: "Could not restart Milagre to install the update. Try again." });
    relaunch();
  };
  const failed = (error) => {
    if (error !== undefined) log(`updater error: ${reason(error)}`);
    if (state.status === "installing") {
      // Before the quit, the install step that failed reports it; after, nothing else will.
      if (phase === "quitting") giveUp(error ?? new Error("updater error"));
      return state;
    }
    // A failed metadata check leaves the existing installer usable. Once a newer download starts,
    // electron-updater owns/replaces the cache, so a download failure must be retried instead.
    if (state.status === "downloaded") return state;
    return update({
      status: "error",
      error: state.status === "downloading" ? "Could not download the update. Try again." : "Could not check for updates. Try again.",
    });
  };
  updater.autoDownload = false;
  // A normal quit must leave the shared host running; installation explicitly stops it.
  updater.autoInstallOnAppQuit = false;
  const needsDownload = (info) => state.status !== "downloaded" || isNewerRelease(info.version, state.version);
  updater.on("update-available", (info) => {
    if (needsDownload(info)) update({ status: "downloading", version: info.version, progress: 0, error: undefined });
  });
  const noUpdate = () => (state.status === "downloaded" ? state : update({ status: "up-to-date", version: null, error: undefined }));
  updater.on("update-not-available", noUpdate);
  updater.on("download-progress", (progress) => update({ status: "downloading", progress: Math.max(0, Math.min(100, progress.percent)) }));
  updater.on("update-downloaded", (info) => update({ status: "downloaded", version: info.version, progress: 100, error: undefined }));
  updater.on("error", failed);
  function check(force = false) {
    if (!enabled) return Promise.resolve(update({ status: "unavailable" }));
    if (checking) return checking;
    if (["downloading", "installing"].includes(state.status)) return Promise.resolve(state);
    if (!force && now() - lastCheck < 60000) return Promise.resolve(state);
    lastCheck = now();
    if (state.status !== "downloaded") update({ status: "checking", progress: 0, error: undefined });
    checking = Promise.resolve()
      .then(prepare)
      .then(() => updater.checkForUpdates())
      .then(async (result) => {
        if (result?.isUpdateAvailable && needsDownload(result.updateInfo)) await updater.downloadUpdate();
      })
      .then(
        () => (state.status === "checking" ? update({ status: "up-to-date", version: null }) : state),
        (error) => {
          if (isChannelNotPublished(error)) return noUpdate();
          // electron-updater also emits an error event; preserve its download-specific explanation.
          return state.status === "error" ? state : failed(error);
        },
      )
      .finally(() => {
        checking = null;
      });
    return checking;
  }
  function install() {
    if (installing) return installing;
    if (state.status !== "downloaded") return Promise.resolve();
    installing = Promise.resolve()
      .then(async () => {
        // Finish a concurrent refresh before choosing which installer to apply.
        if (checking) await checking;
        if (state.status !== "downloaded") return;
        update({ status: "installing", error: undefined });
        gaveUp = false;
        phase = "staging";
        try {
          await stage();
        } catch (error) {
          log(`install: preparing the update failed: ${reason(error)}`);
          update({ status: "downloaded", error: "Could not prepare the update. Try again." });
          return;
        }
        phase = "stopping";
        try {
          await stopHost();
        } catch (error) {
          log(`install: stopping the host failed: ${reason(error)}`);
          await resumeHost().then(
            () => log("install: host started again"),
            (cause) => log(`install: starting the host again failed: ${reason(cause)}`),
          );
          update({ status: "downloaded", error: "Could not stop Milagre's background host. Try again." });
          return;
        }
        phase = "quitting";
        log("install: host stopped, quitting to install");
        try {
          await prepareQuit();
          updater.quitAndInstall();
        } catch (error) {
          giveUp(error);
          return;
        }
        setTimer(() => giveUp(new Error(`Milagre was still open ${QUIT_TIMEOUT_MS / 1000} s after quitting to install`)), QUIT_TIMEOUT_MS);
      })
      .finally(() => {
        if (phase !== "quitting") phase = "";
        installing = null;
      });
    return installing;
  }
  // The Auto update switch, which the host keeps (app-auto-update.cjs): shown on the notice, read by createAutoInstall.
  const setAuto = (auto) => (state.auto === (auto === true) ? state : update({ auto: auto === true }));
  return { get: () => state, check, install, setAuto };
}

// No keyboard or mouse input for this long before an auto update restarts Milagre, so it never restarts under someone at
// the Mac. A server nobody sits at is always past it.
const INPUT_IDLE_SECONDS = 5 * 60;
// Quiet checks in a row, a minute apart, before installing: a Chat between two turns (a queued message, a Delegation's
// report) looks idle for a moment.
const QUIET_CHECKS = 2;

/**
 * Installs a downloaded update by itself while Auto update is on, once the host says no Chat or Routine runs
 * (`activity`, app-update:activity) and nobody has used the Mac for INPUT_IDLE_SECONDS. A host that can't answer counts
 * as busy. An install that fails is not tried again for that version; the notice offers Install & restart.
 */
function createAutoInstall(controller, { activity, inputIdleSeconds }) {
  let quiet = 0;
  let failedVersion = null;
  let ticking = null;
  async function step() {
    const state = controller.get();
    if (!state.auto || state.status !== "downloaded" || state.version === failedVersion || inputIdleSeconds() < INPUT_IDLE_SECONDS) {
      quiet = 0;
      return false;
    }
    const busy = await activity().then(
      (now) => !now || now.chats > 0 || now.routines > 0,
      () => true,
    );
    quiet = busy ? 0 : quiet + 1;
    if (quiet < QUIET_CHECKS) return false;
    quiet = 0;
    await controller.install();
    if (controller.get().status === "downloaded") failedVersion = state.version;
    return true;
  }
  return {
    /** One check; resolves true when it tried to install. */
    tick() {
      ticking ??= step().finally(() => {
        ticking = null;
      });
      return ticking;
    },
  };
}

function watchAppUpdates(
  controller,
  {
    app,
    powerMonitor,
    autoInstall = /** @type {{ tick(): Promise<boolean> } | null} */ (null),
    schedule = (callback, ms) => {
      const timer = setInterval(callback, ms);
      timer.unref();
      return () => clearInterval(timer);
    },
  },
) {
  const refresh = () => {
    void controller.check();
  };
  app.on("browser-window-focus", refresh);
  powerMonitor.on("resume", refresh);
  const cancel = schedule(refresh, 5 * 60000);
  const cancelAuto = autoInstall ? schedule(() => void autoInstall.tick(), 60000) : () => {};
  app.once("will-quit", () => {
    cancel();
    cancelAuto();
    app.removeListener("browser-window-focus", refresh);
    powerMonitor.removeListener("resume", refresh);
  });
  refresh();
}
module.exports = { deferUpdater, createAppUpdates, createAutoInstall, stageNativeUpdate, watchAppUpdates, INPUT_IDLE_SECONDS, QUIT_TIMEOUT_MS };
