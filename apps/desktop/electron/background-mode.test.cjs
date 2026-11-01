const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createBackgroundMode, hiddenWindowOptions, hiddenWindows, isBackground } = require("./background-mode.cjs");

test("MILAGRE_BACKGROUND turns background on only for 1, true or yes", () => {
  for (const value of ["1", "true", "TRUE", "yes", " 1 "]) assert.equal(isBackground({ MILAGRE_BACKGROUND: value }), true, value);
  for (const value of [undefined, "", "0", "false", "no", "2"]) assert.equal(isBackground({ MILAGRE_BACKGROUND: value }), false, String(value));
});

test("hidden windows are created hidden, paint while hidden and never throttle, keeping their other options", () => {
  assert.deepEqual(hiddenWindowOptions({ width: 800, show: true, webPreferences: { preload: "p.cjs", backgroundThrottling: true } }), {
    width: 800,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { preload: "p.cjs", backgroundThrottling: false },
  });
  assert.deepEqual(hiddenWindowOptions({}).webPreferences, { backgroundThrottling: false });
});

test("a hidden window ignores every show and focus call", () => {
  const calls = [];
  const created = [];
  class FakeWindow {
    constructor(options) {
      this.options = options;
      created.push(this);
    }
    show() {
      calls.push("show");
    }
    showInactive() {
      calls.push("showInactive");
    }
    focus() {
      calls.push("focus");
    }
    moveTop() {
      calls.push("moveTop");
    }
    hide() {
      calls.push("hide");
    }
    // Like Electron's, which leaves out instances of a subclass.
    static getAllWindows() {
      return created.filter((window) => Object.getPrototypeOf(window) === FakeWindow.prototype);
    }
  }
  const Hidden = hiddenWindows(/** @type {any} */ (FakeWindow));
  const window = /** @type {any} */ (new Hidden({ show: true, alwaysOnTop: true }));
  assert.equal(window instanceof FakeWindow, true);
  assert.equal(window.options.show, false);
  assert.equal(window.options.alwaysOnTop, true);
  window.show();
  window.showInactive();
  window.focus();
  window.moveTop();
  window.hide();
  assert.deepEqual(calls, ["hide"]);
  assert.deepEqual(FakeWindow.getAllWindows(), [window], "Electron's window list includes it, so the host's events reach it");
  assert.deepEqual(/** @type {any} */ (Hidden).getAllWindows(), [window], "statics stay Electron's");
});

function fakes() {
  const calls = [];
  const record =
    (name, result) =>
    (...args) => {
      calls.push([name, ...args]);
      return result;
    };
  function Window() {}
  return {
    calls,
    Window,
    options: {
      app: {
        setActivationPolicy: record("setActivationPolicy"),
        focus: record("focus"),
        dock: { hide: record("dock.hide"), setBadge: record("setBadge"), setIcon: record("setIcon") },
      },
      BrowserWindow: /** @type {any} */ (Window),
      shell: {
        openExternal: record("openExternal", Promise.resolve()),
        openPath: record("openPath", Promise.resolve("")),
        showItemInFolder: record("showItemInFolder"),
      },
      dialog: {
        showErrorBox: record("showErrorBox"),
        showMessageBox: record("showMessageBox", Promise.resolve({ response: 0, checkboxChecked: false })),
        showOpenDialog: record("showOpenDialog", Promise.resolve({ canceled: false, filePaths: ["/picked"] })),
        showSaveDialog: record("showSaveDialog", Promise.resolve({ canceled: false, filePath: "/saved" })),
      },
      log: record("log"),
    },
  };
}

test("outside background every Electron surface passes through untouched", async () => {
  const { calls, Window, options } = fakes();
  const mode = createBackgroundMode({ ...options, enabled: false, platform: "darwin" });
  mode.start();
  assert.equal(mode.BrowserWindow, Window);
  assert.equal(mode.shell, options.shell);
  assert.equal(mode.dialog, options.dialog);
  mode.focusApp();
  mode.setBadge("2");
  mode.setDockIcon("icon");
  assert.equal(mode.notifications(true), true);
  assert.equal(mode.notifications(false), false);
  assert.equal(mode.menus, true);
  const open = async () => "opened";
  assert.equal(mode.editorOpener(open), open);
  assert.deepEqual(calls, [
    ["focus", { steal: true }],
    ["setBadge", "2"],
    ["setIcon", "icon"],
  ]);
  createBackgroundMode({ ...options, enabled: false, platform: "linux" }).focusApp();
  assert.equal(calls.length, 3, "only macOS steals focus for the app");
});

test("in background nothing reaches the screen: no Dock, focus, badge, notification, menu, dialog, browser or editor", async () => {
  const { calls, Window, options } = fakes();
  const mode = createBackgroundMode({ ...options, enabled: true, platform: "darwin" });
  mode.start();
  assert.deepEqual(calls.splice(0), [["setActivationPolicy", "accessory"], ["dock.hide"]]);
  assert.notEqual(mode.BrowserWindow, Window);
  assert.equal(new mode.BrowserWindow({}) instanceof Window, true);
  mode.focusApp();
  mode.setBadge("2");
  mode.setDockIcon("icon");
  assert.equal(mode.notifications(true), false);
  assert.equal(mode.menus, false);
  await mode.shell.openExternal("https://example.com");
  assert.equal(await mode.shell.openPath("/tmp/file"), "");
  mode.shell.showItemInFolder("/tmp/file");
  assert.deepEqual(await mode.dialog.showMessageBox(/** @type {any} */ ({}), { message: "Quit Milagre?", buttons: ["Quit", "Cancel"], cancelId: 1 }), {
    response: 1,
    checkboxChecked: false,
  });
  assert.deepEqual(await mode.dialog.showOpenDialog({ properties: ["openDirectory"] }), { canceled: true, filePaths: [] });
  assert.deepEqual(await mode.dialog.showSaveDialog({}), { canceled: true, filePath: "" });
  assert.equal(await mode.editorOpener(async () => "opened")({ root: "/project", path: "a.ts" }, {}), null);
  assert.deepEqual(
    calls.map(([name]) => name),
    ["log", "log", "log", "log", "log"],
    "every skipped surface is logged and none reaches Electron",
  );
  assert.match(calls[0][1], /^MILAGRE_BACKGROUND: skipped opening https:\/\/example\.com$/);
});

test("background off macOS keeps the Dock calls out", () => {
  const { calls, options } = fakes();
  createBackgroundMode({ ...options, enabled: true, platform: "linux" }).start();
  assert.deepEqual(calls, []);
});
