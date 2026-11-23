// @ts-check
// Typing on a Browser panel page. Chromium sends a webview debugger's Input.insertText and Input.dispatchKeyEvent to
// whatever has the keyboard focus in the window that holds the webview (DevTools' InputHandler asks the outermost
// WebContents for its focused widget). While the person types in Milagre, that is the Chat composer on screen, in any
// Chat or Project: the agent's browser_fill landed there, and its Enter could send the person's draft. So the text and
// keys go to the page itself instead: text through the page's own editing (document.execCommand), keys through the
// guest's own widget (webContents.sendInputEvent), whatever Milagre's window has focused.

// DevTools' modifier bits, as Electron names them.
const MODIFIERS = /** @type {const} */ ([
  [1, "alt"],
  [2, "control"],
  [4, "meta"],
  [8, "shift"],
]);
// DOM key names Electron's accelerator codes spell differently.
const KEY_NAMES = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "Space", Spacebar: "Space" };
// The editing commands a key may carry (a viewer's ⌘A), run by the page's own editing: sendInputEvent has no native
// event behind it, so macOS never turns the key into the command.
const COMMANDS = {
  selectAll: "selectAll",
  undo: "undo",
  redo: "redo",
  cut: "cut",
  copy: "copy",
  paste: "paste",
  deleteBackward: "delete",
  deleteForward: "forwardDelete",
};

/**
 * Runs in the page: the focused element's document, past same-origin frames and shadow roots, does `commands`, then
 * inserts `text` as typing would (one input event of type insertText, so React and other frameworks see it). False when
 * the text couldn't go in there (a cross-origin frame has the focus, or nothing editable does).
 */
const IN_PAGE = `function (text, commands) {
  let doc = document;
  let element = doc.activeElement;
  for (;;) {
    if (element && element.shadowRoot && element.shadowRoot.activeElement) element = element.shadowRoot.activeElement;
    else if (element && (element.tagName === "IFRAME" || element.tagName === "FRAME")) {
      let inner = null;
      try { inner = element.contentDocument; } catch {}
      if (!inner) return false;
      doc = inner;
      element = doc.activeElement;
    } else break;
  }
  for (const command of commands) doc.execCommand(command);
  if (!text) return true;
  if (doc.execCommand("insertText", false, text)) return true;
  if (element && typeof element.setRangeText === "function" && element.selectionStart !== null) {
    element.setRangeText(text, element.selectionStart, element.selectionEnd, "end");
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return true;
  }
  return false;
}`;

/** @param {unknown} bits */
function modifiers(bits) {
  const value = Number(bits) || 0;
  return MODIFIERS.filter(([bit]) => value & bit).map(([, name]) => name);
}

/**
 * The guest's own key events for one Input.dispatchKeyEvent, and the editing commands that come with it.
 * @param {any} params
 * @returns {{ events: { type: "keyDown" | "keyUp" | "char"; keyCode: string; modifiers: string[] }[]; commands: string[] }}
 */
function keyEvents(params) {
  const { type, key, code, text } = params ?? {};
  const held = modifiers(params?.modifiers);
  const name =
    typeof key === "string" && key
      ? (KEY_NAMES[/** @type {keyof typeof KEY_NAMES} */ (key)] ?? key)
      : typeof code === "string"
        ? code.replace(/^(Key|Digit)/, "")
        : "";
  const typed = typeof text === "string" && text ? text : "";
  const commands = Array.isArray(params?.commands)
    ? params.commands.flatMap((/** @type {unknown} */ command) => {
        const known = typeof command === "string" && Object.hasOwn(COMMANDS, command) ? COMMANDS[/** @type {keyof typeof COMMANDS} */ (command)] : null;
        return known ? [known] : [];
      })
    : [];
  /** @type {{ type: "keyDown" | "keyUp" | "char"; keyCode: string; modifiers: string[] }[]} */
  const events = [];
  if ((type === "keyDown" || type === "rawKeyDown") && name) events.push({ type: "keyDown", keyCode: name, modifiers: held });
  if ((type === "keyDown" || type === "char") && typed) events.push({ type: "char", keyCode: typed, modifiers: held });
  if (type === "keyUp" && name) events.push({ type: "keyUp", keyCode: name, modifiers: held });
  return { events, commands: type === "keyUp" ? [] : commands };
}

/**
 * Handles a page's Input.insertText and Input.dispatchKeyEvent, or answers null for any other command.
 * @param {Pick<Electron.WebContents, "isDestroyed" | "sendInputEvent">} guest
 * @param {{ sendCommand(method: string, params?: object): Promise<any> }} debug
 * @param {string} method
 * @param {any} params
 */
function pageInput(guest, debug, method, params) {
  if (method !== "Input.insertText" && method !== "Input.dispatchKeyEvent") return null;
  return (async () => {
    if (guest.isDestroyed()) throw new Error("The page is gone.");
    const inPage = async (/** @type {string} */ text, /** @type {string[]} */ commands) => {
      const { result, exceptionDetails } = await debug.sendCommand("Runtime.evaluate", {
        expression: `(${IN_PAGE})(${JSON.stringify(text)}, ${JSON.stringify(commands)})`,
        returnByValue: true,
      });
      return !exceptionDetails && result?.value === true;
    };
    if (method === "Input.insertText") {
      const text = typeof params?.text === "string" ? params.text : "";
      if (!text || (await inPage(text, []))) return {};
      // A cross-origin frame has the focus: its own document can't be reached from here, but the page's widget sends
      // characters to whatever is focused inside it.
      for (const character of text) guest.sendInputEvent({ type: "char", keyCode: character });
      return {};
    }
    const { events, commands } = keyEvents(params);
    for (const event of events) {
      try {
        guest.sendInputEvent(/** @type {any} */ (event));
      } catch {
        // A key Electron has no code for: dropped, as a key the page doesn't know would be.
      }
    }
    if (commands.length) await inPage("", commands);
    return {};
  })();
}

module.exports = { pageInput, keyEvents };
