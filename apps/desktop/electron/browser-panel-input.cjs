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
 * Runs in a frame of the page: the focused element's document, past same-origin frames and shadow roots, does
 * `commands`, then inserts `text` as typing would (one input event of type insertText, so React and other frameworks see
 * it). "frame" when the focus is in a cross-origin frame this document can't reach, "none" when nothing editable took
 * the text. A read-only or disabled field takes nothing, as it wouldn't from a person.
 */
const IN_FRAME = `function (text, commands) {
  let doc = document;
  let element = doc.activeElement;
  for (;;) {
    if (element && element.shadowRoot && element.shadowRoot.activeElement) element = element.shadowRoot.activeElement;
    else if (element && (element.tagName === "IFRAME" || element.tagName === "FRAME")) {
      let inner = null;
      try { inner = element.contentDocument; } catch {}
      if (!inner) return "frame";
      doc = inner;
      element = doc.activeElement;
    } else break;
  }
  for (const command of commands) doc.execCommand(command);
  if (!text) return "done";
  if (element && (element.readOnly || element.disabled) && !element.isContentEditable) return "done";
  if (doc.execCommand("insertText", false, text)) return "done";
  if (element && typeof element.setRangeText === "function" && element.selectionStart !== null) {
    element.setRangeText(text, element.selectionStart, element.selectionEnd, "end");
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return "done";
  }
  return "none";
}`;
// Whether a frame's own document has a field focused (not its body, not a frame inside it): the frame the focus is in.
const FOCUSED_HERE = `(() => { const element = document.activeElement; return !!element && element !== document.body && element.tagName !== "IFRAME" && element.tagName !== "FRAME"; })()`;

/**
 * Runs IN_FRAME where the page's focus is: from the top frame, or in the one cross-origin frame that holds the focus
 * (webContents.focusedFrame can't tell while Milagre's window has the focus).
 * @param {Pick<Electron.WebContents, "mainFrame">} guest
 * @param {string} text
 * @param {string[]} commands
 * @returns {Promise<"done" | "frame" | "none">}
 */
async function inFocusedFrame(guest, text, commands) {
  const script = `(${IN_FRAME})(${JSON.stringify(text)}, ${JSON.stringify(commands)})`;
  const top = guest.mainFrame;
  const outcome = /** @type {"done" | "frame" | "none"} */ (await top.executeJavaScript(script));
  if (outcome !== "frame") return outcome;
  const frames = top.framesInSubtree.filter((frame) => frame !== top);
  const focused = await Promise.all(frames.map((frame) => frame.executeJavaScript(FOCUSED_HERE).catch(() => false)));
  const holders = frames.filter((_, index) => focused[index] === true);
  const [holder] = holders;
  return holders.length === 1 && holder ? /** @type {"done" | "frame" | "none"} */ (await holder.executeJavaScript(script)) : "frame";
}

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
 * @param {Pick<Electron.WebContents, "isDestroyed" | "sendInputEvent" | "mainFrame">} guest
 * @param {string} method
 * @param {any} params
 */
function pageInput(guest, method, params) {
  if (method !== "Input.insertText" && method !== "Input.dispatchKeyEvent") return null;
  return (async () => {
    if (guest.isDestroyed()) throw new Error("The page is gone.");
    if (method === "Input.insertText") {
      const text = typeof params?.text === "string" ? params.text : "";
      if (!text || (await inFocusedFrame(guest, text, [])) === "done") return {};
      // No document took it: the page's widget sends characters to whatever is focused inside it, as typing would.
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
    if (commands.length && (await inFocusedFrame(guest, "", commands)) !== "done")
      throw new Error(`The page's focused field couldn't be reached to run ${commands.join(", ")}.`);
    return {};
  })();
}

module.exports = { pageInput, keyEvents };
