const { randomUUID } = require("node:crypto");

const AUTHORIZE = "https://linear.app/oauth/authorize?";

function createLinearSignInWindow({ BrowserWindow, shell, cancel, setTimeoutImpl = setTimeout }) {
  let current = null;

  function open(url) {
    if (typeof url !== "string" || !url.startsWith(AUTHORIZE)) return false;
    close();
    const window = new BrowserWindow({
      width: 520,
      height: 720,
      title: "Sign in to Linear",
      webPreferences: { partition: `linear-sign-in-${randomUUID()}`, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      if (target.startsWith("https://")) void shell.openExternal(target);
      return { action: "deny" };
    });
    const entry = { window, ended: false };
    current = entry;
    const session = window.webContents.session;
    window.on("closed", () => {
      if (current === entry) current = null;
      void session.clearStorageData().catch(() => {});
      if (!entry.ended) cancel();
    });
    void window.loadURL(url).catch(() => {});
    return true;
  }

  function finish() {
    const entry = current;
    if (!entry) return;
    entry.ended = true;
    setTimeoutImpl(() => {
      if (!entry.window.isDestroyed()) entry.window.close();
    }, 1200);
  }

  function close() {
    const entry = current;
    if (!entry) return;
    entry.ended = true;
    current = null;
    if (!entry.window.isDestroyed()) entry.window.close();
  }

  return { open, finish, close, isOpen: () => current !== null };
}

module.exports = { createLinearSignInWindow };
