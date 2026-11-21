/** A W3C KeyboardEvent.code as a USB HID keyboard usage, or 0. Command keys stay with the app showing the viewer. */
export function simulatorKeyUsage(code) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) - 61;
  if (/^Digit[0-9]$/.test(code)) return code === "Digit0" ? 39 : code.charCodeAt(5) - 19;
  const keys = {
    Enter: 40,
    NumpadEnter: 40,
    Escape: 41,
    Backspace: 42,
    Tab: 43,
    Space: 44,
    Minus: 45,
    Equal: 46,
    BracketLeft: 47,
    BracketRight: 48,
    Backslash: 49,
    Semicolon: 51,
    Quote: 52,
    Backquote: 53,
    Comma: 54,
    Period: 55,
    Slash: 56,
    Home: 74,
    PageUp: 75,
    Delete: 76,
    End: 77,
    PageDown: 78,
    ArrowRight: 79,
    ArrowLeft: 80,
    ArrowDown: 81,
    ArrowUp: 82,
    ControlLeft: 224,
    ShiftLeft: 225,
    AltLeft: 226,
    ControlRight: 228,
    ShiftRight: 229,
    AltRight: 230,
  };
  return Object.hasOwn(keys, code) ? keys[code] : 0;
}

/**
 * Keyboard passthrough, Type and paste, and clipboard sync for the receiver page. Serialized into the receiver, so it
 * must not close over module state. `host.viewer().status` is the status while the display takes input, else null.
 */
export function simulatorTyping(host) {
  const { usageFor } = host;
  const element = (id) => document.getElementById(id);
  const stage = element("stage");
  const live = () => host.viewer().status;
  const keyboard = element("keyboard"),
    typing = element("typing"),
    typeText = element("type-text"),
    typeSend = element("type-send"),
    pasteButton = element("paste"),
    copyButton = element("copy"),
    typingNote = element("typing-note"),
    keysHint = element("keys-hint"),
    toast = element("toast");
  const heldKeys = new Map();
  let sawKey = false,
    texting = false,
    clipboardRead = null,
    toastTimer = null;
  typing.hidden = toast.hidden = true;
  const typable = () => {
    const status = live();
    return !!(status?.controlling && status.keyboard);
  };
  const capturing = () => document.activeElement === stage && typable();
  const release = () => {
    for (const usage of heldKeys.values()) host.input({ kind: "key", phase: "up", usage });
    heldKeys.clear();
  };
  const closePanel = () => {
    typing.hidden = true;
    typingNote.textContent = "";
    keyboard.setAttribute("aria-expanded", "false");
  };
  const note = (text) => {
    typingNote.textContent = text;
    clearTimeout(toastTimer);
    toast.textContent = text;
    toast.hidden = !typing.hidden || !text;
    toastTimer = setTimeout(() => {
      toast.hidden = true;
      host.render();
    }, 4000);
    host.render();
  };
  const sendText = async (event, done) => {
    if (texting || !typable()) return;
    if (event.kind !== "copy") {
      event = { ...event, text: event.text.replace(/\r\n?/g, "\n") };
      if (!event.text) return note("The clipboard has no text to paste.");
      if (event.text.length > (event.kind === "text" ? 2000 : 65536))
        return note(event.kind === "text" ? "Type up to 2,000 characters at a time." : "Paste up to 64 KB of text at a time.");
    }
    const epoch = host.viewer().epoch;
    texting = true;
    note(event.kind === "copy" ? "Copying from the simulator..." : "Sending to the simulator...");
    try {
      const result = await host.input(event, true);
      if (epoch !== host.viewer().epoch) return;
      if (!result.accepted) note("The simulator changed before the text arrived. Try again.");
      else done(result);
    } catch (error) {
      if (epoch === host.viewer().epoch) note(error?.message || "The simulator did not take the text.");
    } finally {
      texting = false;
      host.render();
    }
  };
  const copyFromDevice = (press) =>
    sendText({ kind: "copy", press }, (result) => {
      if (!result.text) return note("The simulator clipboard is empty.");
      host.post({ channel: "milagre-simulator", event: "clipboard", action: "write", text: result.text });
      note("Copied from the simulator.");
    });
  window.simulatorClipboard = (text) => {
    const read = clipboardRead;
    clipboardRead = null;
    read?.(typeof text === "string" ? text : null);
  };
  window.addEventListener("message", (event) => {
    if (event.source === window.parent && event.data?.channel === "milagre-simulator-clipboard") window.simulatorClipboard(event.data.text);
  });
  window.addEventListener("blur", release);
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const extras = element("extras"),
      more = element("more");
    if (!typing.hidden) {
      closePanel();
      keyboard.focus?.();
      host.render();
    } else if (!extras.hidden) {
      extras.hidden = true;
      more.setAttribute("aria-expanded", "false");
      more.focus?.();
    } else host.post({ channel: "milagre-simulator", event: "close" });
  });
  stage.addEventListener("pointerdown", () => {
    if (live()?.keyboard && document.activeElement !== stage) stage.focus({ preventScroll: true });
  });
  stage.addEventListener("focus", () => host.render());
  stage.addEventListener("blur", () => {
    release();
    host.render();
  });
  stage.addEventListener("keydown", (event) => {
    if (!capturing() || event.metaKey || event.isComposing) return;
    const usage = usageFor(event.code);
    if (!usage) return;
    event.preventDefault();
    event.stopPropagation();
    if (!sawKey) {
      sawKey = true;
      host.render();
    }
    if (event.repeat || heldKeys.has(event.code)) return;
    heldKeys.set(event.code, usage);
    host.input({ kind: "key", phase: "down", usage, ...(event.key.length === 1 ? { key: event.key, shifted: event.shiftKey } : {}) });
  });
  stage.addEventListener("keyup", (event) => {
    const usage = heldKeys.get(event.code);
    if (usage === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    heldKeys.delete(event.code);
    host.input({ kind: "key", phase: "up", usage });
  });
  document.addEventListener("paste", (event) => {
    if (!capturing()) return;
    event.preventDefault();
    void sendText({ kind: "paste", text: event.clipboardData?.getData("text/plain") || "" }, () =>
      note("Pasted. If the text doesn't appear, long-press the field and choose Paste."),
    );
  });
  document.addEventListener("copy", (event) => {
    if (!capturing() || !live().copy) return;
    event.preventDefault();
    void copyFromDevice(true);
  });
  keyboard.addEventListener("click", () => {
    if (typing.hidden) {
      typing.hidden = false;
      toast.hidden = true;
      keyboard.setAttribute("aria-expanded", "true");
      typeText.focus();
    } else closePanel();
    host.render();
  });
  const submitText = () => {
    if (!typeText.value) return;
    void sendText({ kind: "text", text: typeText.value }, () => {
      typeText.value = "";
      note("Sent to the simulator.");
    });
  };
  typeSend.addEventListener("click", submitText);
  typeText.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitText();
    }
  });
  pasteButton.addEventListener("click", () => {
    if (texting || !typable()) return;
    void new Promise((resolve) => {
      clipboardRead?.(null);
      clipboardRead = resolve;
      host.post({ channel: "milagre-simulator", event: "clipboard", action: "read" });
      setTimeout(() => {
        if (clipboardRead === resolve) window.simulatorClipboard(null);
      }, 15000);
    }).then((text) => {
      if (text === null) note("Couldn't read the clipboard. Allow Milagre to paste, then try again.");
      else void sendText({ kind: "paste", text }, () => note("Pasted. If the text doesn't appear, long-press the field and choose Paste."));
    });
  });
  copyButton.addEventListener("click", () => void copyFromDevice(false));
  let held = "";
  return {
    render(status, ready) {
      const lease = status ? status.generation + ":" + status.controlling : "";
      if (lease !== held) heldKeys.clear();
      held = lease;
      const canType = !!(ready && status.controlling && status.keyboard);
      keyboard.hidden = !status?.keyboard;
      if (status && !status.keyboard && !typing.hidden) closePanel();
      typeText.disabled = !canType;
      typeSend.disabled = pasteButton.disabled = copyButton.disabled = !canType || texting;
      copyButton.hidden = !status?.copy;
      if (!typing.hidden && !texting && ready && !status.controlling) typingNote.textContent = "Take control to type into the simulator.";
      const keys = canType && document.activeElement === stage && (document.documentElement.dataset.touchControls !== "true" || sawKey);
      stage.dataset.keys = String(keys);
      keysHint.hidden = !keys || !toast.hidden;
    },
  };
}

export const SIMULATOR_TYPING_CSS = `#stage:focus{outline:none}
#stage[data-keys=true] #device{outline:2px solid var(--accent);outline-offset:3px}
#keys-hint,#toast{position:absolute;left:50%;bottom:2px;transform:translateX(-50%);max-width:calc(100% - 24px);padding:2px 10px;border-radius:999px;background:var(--accent);color:#fff;font-size:11px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
#toast{background:var(--ink);color:var(--surface)}
#keyboard[aria-expanded=true]{background:var(--hover);color:var(--accent)}
#typing{display:flex;flex-direction:column;gap:8px;flex-shrink:0;padding:8px 16px 12px;border-top:1px solid var(--line)}
#type-row{display:flex;gap:8px;align-items:flex-end}
#type-text{flex:1;min-width:0;min-height:35px;max-height:96px;resize:none;box-sizing:border-box;padding:7px 10px;font:inherit;font-size:13px;border:1px solid var(--line);border-radius:9px;background:var(--surface);color:var(--ink)}
#type-text:focus-visible{outline:2px solid var(--accent);outline-offset:-1px}
#type-send:not(:disabled){color:var(--accent)}
#typing .extra-actions button{width:auto;min-height:35px;padding:0 10px;border-color:var(--line);border-radius:9px;color:var(--ink)}
html[data-touch-controls=true] #typing .extra-actions button,html[data-touch-controls=true] #type-text{min-height:44px}
html[data-touch-controls=true] #type-text{font-size:16px}
#typing-note{margin:0;color:var(--ink2);line-height:1.4;text-align:center}#typing-note:empty{display:none}`;

export const SIMULATOR_TYPING_HTML = {
  button: `<button id="keyboard" type="button" aria-label="Type and paste" title="Type and paste" aria-expanded="false" aria-controls="typing" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M10 13h4M7 16h10"/></svg></button>`,
  stage: `<span id="keys-hint" title="Click outside the screen to type in Milagre again" hidden>Typing goes to the simulator</span><span id="toast" hidden></span>`,
  section: `<section id="typing" aria-label="Type into the simulator" hidden><div id="type-row"><textarea id="type-text" rows="1" maxlength="2000" enterkeyhint="send" placeholder="Type text to send" aria-label="Text to type into the simulator"></textarea><button id="type-send" type="button" aria-label="Send text" title="Send text"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></button></div><div class="extra-actions"><button id="paste" type="button">Paste clipboard</button><button id="copy" type="button" hidden>Copy from simulator</button></div><p id="typing-note" role="status" aria-live="polite"></p></section>`,
};
