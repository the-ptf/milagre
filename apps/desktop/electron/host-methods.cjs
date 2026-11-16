function createHostMethods({
  runtime,
  ipcMain: electronIpcMain,
  invokeHost,
  registered,
  computerUnlock,
  linearSignIn,
  linearSignInState,
  background,
  BrowserWindow,
}) {
  function register() {
    for (const method of runtime.methods) {
      if (registered.has(method)) continue;
      registered.add(method);
      electronIpcMain.handle(method, async (event, ...args) => {
        if (method === "computers:add") {
          try {
            await computerUnlock().prepare();
          } catch (error) {
            return { ok: false, code: "keys", message: error instanceof Error ? error.message : String(error) };
          }
        }
        if (method === "computers:set-enabled" && args[0] === true)
          void computerUnlock()
            .prepare()
            .catch((error) => console.warn("Computer credentials:", error.message));
        if (method === "linear:connect") {
          linearSignIn.close();
          linearSignInState.requested = args[0]?.window === true;
          linearSignInState.attempt++;
        }
        const answer = invokeHost(method, args);
        if (method === "linear:connect") {
          const attempt = linearSignInState.attempt;
          const newest = () => attempt === linearSignInState.attempt;
          void answer.then(
            () => {
              if (newest()) linearSignIn.finish();
              bringBack(event.sender);
            },
            () => {
              if (newest()) linearSignIn.close();
            },
          );
        }
        return answer;
      });
    }
  }
  function bringBack(contents) {
    const window = BrowserWindow.fromWebContents(contents);
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    background.focusApp();
    window.focus();
  }
  return { register };
}

module.exports = { createHostMethods };
