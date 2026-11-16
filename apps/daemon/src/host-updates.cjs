const APP_UPDATE_METHODS = Object.freeze(["app-update:state", "app-update:check", "app-update:install"]);

/** @param {{ invoke(method: string, args: unknown[]): Promise<any> }} desktop the host's desktop commands */
function createHostUpdates(desktop) {
  async function read() {
    try {
      const [state, current] = await Promise.all([desktop.invoke("update:state", []), desktop.invoke("app:version", [])]);
      return { ...state, current };
    } catch (error) {
      if (error?.code === "CAPABILITY_UNAVAILABLE") return null;
      throw error;
    }
  }
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
          const installing = () => ({ ...state, status: "installing" });
          return read().then((next) => next ?? installing(), installing);
        });
      return Promise.reject(new Error(`Unknown command: ${method}`));
    },
  };
}

module.exports = { APP_UPDATE_METHODS, createHostUpdates };
