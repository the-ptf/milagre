// The desktop app's updates, read and started away from the Mac: from the phone (Settings › General) and a paired desktop
// (the Computer page). The desktop's own updater does the work (apps/desktop/electron/app-updates.cjs); these forward to
// the update:state, update:check, update:install and app:version it registers as desktop commands, and nothing else of
// that set.
const APP_UPDATE_METHODS = Object.freeze(["app-update:state", "app-update:check", "app-update:install"]);

/** @param {{ invoke(method: string, args: unknown[]): Promise<any> }} desktop the host's desktop commands */
function createHostUpdates(desktop) {
  // The updater's state and the version the app runs. With no desktop app open, null: there is no updater to ask.
  async function read() {
    try {
      const [state, current] = await Promise.all([desktop.invoke("update:state", []), desktop.invoke("app:version", [])]);
      return { ...state, current };
    } catch (error) {
      if (error?.code === "CAPABILITY_UNAVAILABLE") return null;
      throw error;
    }
  }
  // A check settles once its download finishes and an install once Milagre restarts, which stops this host; neither is
  // waited for. Each is sent before the read that answers, and the desktop takes them in order: the answer shows the
  // check or install begun ("checking", "installing"), and app-update:state follows it from there.
  const start = (method) => {
    desktop.invoke(method, []).catch(() => {});
  };
  return {
    invoke(method) {
      if (method === "app-update:state") return read();
      if (method === "app-update:check") {
        start("update:check");
        return read();
      }
      if (method === "app-update:install")
        return read().then((state) => {
          if (state?.status !== "downloaded") throw new Error("No update is ready to install. Check for updates first.");
          start("update:install");
          // The restart can close the desktop's connection before it answers, or before the read reaches it.
          const installing = () => ({ ...state, status: "installing" });
          return read().then((next) => next ?? installing(), installing);
        });
      return Promise.reject(new Error(`Unknown command: ${method}`));
    },
  };
}

module.exports = { APP_UPDATE_METHODS, createHostUpdates };
