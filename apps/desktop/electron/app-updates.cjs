// @ts-check
const { isChannelNotPublished, isNewerRelease } = require("./release-channel.cjs");

/** One updater owns downloads, background checks, and explicit host shutdown for installation. */
function createAppUpdates({ updater, enabled, prepare, stopHost, publish, now = Date.now }) {
  /** @type {import('../app/src/electron').UpdateState} */
  let state = { status: "idle", version: null, progress: 0, auto: false };
  /** @type {Promise<typeof state> | null} */
  let checking = null;
  /** @type {Promise<void> | null} */
  let installing = null;
  let lastCheck = -Infinity;
  /** @param {Partial<typeof state>} next */
  const update = (next) => {
    state = { ...state, ...next };
    publish(state);
    return state;
  };
  const failed = () => {
    if (state.status === "installing") return update({ status: "downloaded", error: "Could not restart Milagre. Try again." });
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
          return state.status === "error" ? state : failed();
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
        await stopHost();
        updater.quitAndInstall();
      })
      .catch(() => {
        update({ status: "downloaded", error: "Could not restart Milagre. Try again." });
      })
      .finally(() => {
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
module.exports = { createAppUpdates, createAutoInstall, watchAppUpdates, INPUT_IDLE_SECONDS };
