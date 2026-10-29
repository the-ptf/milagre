// @ts-check
const { KEYBINDING_COMMANDS, compileRules, defaultKeybindings, eventMatches } = require("@milagre/shared/keybindings");

// The app's frame-wide keys (Settings, the theme, the canvas, the grid and the side panels: the `forward` commands of
// @milagre/shared/keybindings), caught before any frame gets the key. With focus inside an embedded frame (a design on
// the canvas, an HTML reply, the simulator viewer) the key goes to that frame and the window's own listeners never see
// it, so these are sent on to the renderer, which handles them as if pressed there. They follow this Mac's
// keybindings.json (`setForwardedRules`); every other key reaches the focused frame as usual.
const FORWARDED = new Set(KEYBINDING_COMMANDS.filter((command) => command.forward).map((command) => command.id));
/** @type {ReturnType<typeof compileRules>} */
let forwarded = [];

/**
 * Follows a keybindings.json: the keys its rules give the `forward` commands are the ones caught. Their `when` is the
 * renderer's to judge.
 * @param {ReadonlyArray<{ key: string; command: string; when?: string }>} rules
 */
function setForwardedRules(rules) {
  forwarded = compileRules(/** @type {any} */ (rules)).filter((rule) => FORWARDED.has(rule.command));
}
setForwardedRules(defaultKeybindings());

/** @param {{ key: string; code?: string; meta: boolean; control: boolean; shift: boolean; alt: boolean }} input */
const asEvent = (input) => ({ key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift });

/**
 * Whether this key is one the app catches from every frame.
 * @param {{ type: string; key: string; code?: string; meta: boolean; control: boolean; shift: boolean; alt: boolean }} input
 * @param {NodeJS.Platform} platform
 */
function isAppShortcut(input, platform) {
  if (input.type !== "keyDown") return false;
  const event = asEvent(input);
  return forwarded.some((rule) => eventMatches(event, rule.shortcut, platform === "darwin"));
}

/**
 * Whether this key is ⌘ plus `letter` alone (Ctrl off macOS).
 * @param {{ type: string; key: string; meta: boolean; control: boolean; shift: boolean; alt: boolean }} input
 * @param {NodeJS.Platform} platform
 * @param {string} letter
 */
function isCommandKey(input, platform, letter) {
  const command = platform === "darwin" ? input.meta : input.control;
  return input.type === "keyDown" && command && !input.shift && !input.alt && input.key.toLowerCase() === letter;
}

/**
 * Whether this key is ⌘W (Ctrl+W off macOS), which the window menu would take to close the window.
 * @param {{ type: string; key: string; meta: boolean; control: boolean; shift: boolean; alt: boolean }} input
 * @param {NodeJS.Platform} platform
 */
const isCloseKey = (input, platform) => isCommandKey(input, platform, "w");

/**
 * Forwards the app's shortcuts from any frame of the window to its renderer, on "app:shortcut" as the key and its modifiers. ⌘W closes the
 * focused Terminal (the renderer says so on "app:terminal-focused") and does nothing otherwise, so a stray press
 * never hides the window. ⌘Q goes to `onQuitKey`, which asks before quitting, instead of the menu.
 * @param {Electron.WebContents} contents
 * @param {NodeJS.Platform} [platform]
 * @param {Pick<Electron.IpcMain, "on" | "removeListener">} [ipc]
 * @param {() => void} [onQuitKey]
 */
function forwardAppShortcuts(contents, platform = process.platform, ipc = require("electron").ipcMain, onQuitKey) {
  let terminalFocused = false;
  /** @param {Electron.IpcMainEvent} event @param {unknown} focused */
  const onFocus = (event, focused) => {
    if (event.sender === contents) terminalFocused = focused === true;
  };
  ipc.on("app:terminal-focused", onFocus);
  contents.once("destroyed", () => ipc.removeListener("app:terminal-focused", onFocus));
  contents.on("before-input-event", (event, input) => {
    if (isCloseKey(input, platform)) {
      event.preventDefault();
      if (terminalFocused) contents.send("app:close-focused-terminal");
      return;
    }
    if (onQuitKey && isCommandKey(input, platform, "q")) {
      event.preventDefault();
      onQuitKey();
      return;
    }
    if (!isAppShortcut(input, platform)) return;
    event.preventDefault();
    contents.send("app:shortcut", { key: input.key, code: input.code, meta: input.meta, control: input.control, alt: input.alt, shift: input.shift });
  });
}

module.exports = { forwardAppShortcuts, isAppShortcut, isCloseKey, setForwardedRules };
