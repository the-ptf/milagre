function registerQuitFlow({ app, dialog, BrowserWindow, ipcMain, runtime, notifier, floating, createQuitHandler, computersLane, setQuitting }) {
  let confirmingQuit = false;
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin" || quitReady) app.quit();
  });

  /** @type {Promise<void> | null} */
  let quitPrepared = null;
  function prepareQuit() {
    setQuitting(true);
    quitPrepared ??= (async () => {
      notifier.closeAll();
      floating.dispose();
      await runtime.close();
      computersLane()?.close();
    })().catch((error) => {
      quitPrepared = null;
      setQuitting(false);
      throw error;
    });
    return quitPrepared;
  }

  let quitReady = false;
  const attemptQuit = createQuitHandler({
    prepare: prepareQuit,
    quit: () => {
      quitReady = true;
      app.quit();
    },
    failed: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.show();
          window.webContents.send("app:quit-failed", message);
        }
      }
    },
  });
  /** @param {Electron.BrowserWindow} window */
  async function confirmQuit(window) {
    if (confirmingQuit) return;
    confirmingQuit = true;
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: "question",
        message: "Quit Milagre?",
        detail: "Agents keep running in the background.",
        buttons: ["Quit", "Cancel"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) app.quit();
    } finally {
      confirmingQuit = false;
    }
  }
  ipcMain.handle("app:retry-quit", () => {
    app.quit();
  });
  app.on("before-quit", (event) => {
    setQuitting(true);
    if (quitReady) return;
    event.preventDefault();
    void attemptQuit();
  });
  return { prepareQuit, confirmQuit };
}

module.exports = { registerQuitFlow };
