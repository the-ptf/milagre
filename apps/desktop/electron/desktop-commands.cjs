/** Capture native IPC definitions once, so the CLI calls the same handlers as the desktop window. */
function createDesktopCommandAdapter({ ipcMain, runtime, event, onError = console.error }) {
  const handlers = new Map();
  let queued = false;
  const publish = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      const host = runtime();
      if (host) void host.invoke("desktop:register", [{ methods: [...handlers.keys()] }]).catch(onError);
    });
  };
  return {
    ipcMain: {
      /** @param {string} name @param {(event: any, ...args: any[]) => any} handler */
      handle(name, handler) {
        ipcMain.handle(name, handler);
        handlers.set(name, handler);
        publish();
      },
      on: (...args) => ipcMain.on(...args),
      removeHandler(name) {
        handlers.delete(name);
        ipcMain.removeHandler(name);
        publish();
      },
    },
    publish,
    async receive(request) {
      const host = runtime();
      if (!host) return;
      let answer;
      try {
        const handler = handlers.get(request.method);
        if (!handler) throw new Error(`Desktop command unavailable: ${request.method}`);
        answer = { id: request.id, result: await handler(event(), ...request.args) };
      } catch (error) {
        answer = {
          id: request.id,
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: error instanceof Error && "code" in error ? error.code : "COMMAND_FAILED",
          },
        };
      }
      // A lost response never repeats the native action.
      try {
        await host.invoke("desktop:respond", [answer]);
      } catch (error) {
        onError(error);
      }
    },
  };
}

module.exports = { createDesktopCommandAdapter };
