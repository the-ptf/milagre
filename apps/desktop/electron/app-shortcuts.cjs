// @ts-check
// The app's ⌘⇧ shortcuts, caught before any frame gets the key. With focus inside an embedded frame (a design on the
// canvas, the simulator viewer) the key goes to that frame and the window's own listeners never see it, so these are
// sent on to the renderer, which handles them as if pressed there. Every other key reaches the focused frame as usual.
const APP_SHORTCUT_KEYS = new Set(["d", "e", "l", "m", "s", "t"]);

/**
 * Whether this key is one of the app's ⌘⇧ shortcuts (Ctrl+Shift off macOS).
 * @param {{ type: string; key: string; meta: boolean; control: boolean; shift: boolean; alt: boolean }} input
 * @param {NodeJS.Platform} platform
 */
function isAppShortcut(input, platform) {
  const command = platform === "darwin" ? input.meta : input.control;
  return input.type === "keyDown" && command && input.shift && !input.alt && APP_SHORTCUT_KEYS.has(input.key.toLowerCase());
}

/**
 * Whether this key is ⌘W (Ctrl+W off macOS), which the window menu would take to close the window.
 * @param {{ type: string; key: string; meta: boolean; control: boolean; shift: boolean; alt: boolean }} input
 * @param {NodeJS.Platform} platform
 */
function isCloseKey(input, platform) {
  const command = platform === "darwin" ? input.meta : input.control;
  return input.type === "keyDown" && command && !input.shift && !input.alt && input.key.toLowerCase() === "w";
}

/**
 * Forwards the app's shortcuts from any frame of the window to its renderer, on "app:shortcut". While a Terminal has
 * focus (the renderer says so on "app:terminal-focused"), ⌘W closes that Terminal instead of the window.
 * @param {Electron.WebContents} contents
 * @param {NodeJS.Platform} [platform]
 * @param {Pick<Electron.IpcMain, "on" | "removeListener">} [ipc]
 */
function forwardAppShortcuts(contents, platform = process.platform, ipc = require("electron").ipcMain) {
  let terminalFocused = false;
  /** @param {Electron.IpcMainEvent} event @param {unknown} focused */
  const onFocus = (event, focused) => {
    if (event.sender === contents) terminalFocused = focused === true;
  };
  ipc.on("app:terminal-focused", onFocus);
  contents.once("destroyed", () => ipc.removeListener("app:terminal-focused", onFocus));
  contents.on("before-input-event", (event, input) => {
    if (terminalFocused && isCloseKey(input, platform)) {
      event.preventDefault();
      contents.send("app:close-focused-terminal");
      return;
    }
    if (!isAppShortcut(input, platform)) return;
    event.preventDefault();
    contents.send("app:shortcut", input.key.toLowerCase());
  });
}

module.exports = { forwardAppShortcuts, isAppShortcut, isCloseKey };
