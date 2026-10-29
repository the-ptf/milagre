const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { forwardAppShortcuts, isAppShortcut, isCloseKey, setForwardedRules } = require("./app-shortcuts.cjs");
const { defaultKeybindings } = require("@milagre/shared/keybindings");

const key = (key, extra = {}) => ({ type: "keyDown", key, meta: true, control: false, shift: true, alt: false, ...extra });

test("only the app's ⌘⇧ shortcuts are forwarded; other keys reach the focused frame", () => {
  assert.equal(isAppShortcut(key("E"), "darwin"), true);
  assert.equal(isAppShortcut(key("s"), "darwin"), true);
  assert.equal(isAppShortcut(key("z"), "darwin"), false, "⌘⇧Z stays redo in the focused frame");
  assert.equal(isAppShortcut(key("E", { shift: false }), "darwin"), false);
  assert.equal(isAppShortcut(key("E", { type: "keyUp" }), "darwin"), false);
  assert.equal(isAppShortcut(key("E", { meta: false, control: true }), "linux"), true);
  assert.equal(isAppShortcut(key("E"), "linux"), false, "⌘ is no shortcut off macOS");
});

test("a forwarded shortcut is kept from the frame and sent to the renderer with its modifiers", () => {
  const contents = new EventEmitter();
  const sent = [];
  contents.send = (...args) => sent.push(args);
  forwardAppShortcuts(contents, "darwin", new EventEmitter());
  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  contents.emit("before-input-event", event, key("E", { code: "KeyE" }));
  contents.emit("before-input-event", event, key("a", { shift: false }));
  assert.equal(prevented, 1);
  assert.deepEqual(sent, [["app:shortcut", { key: "E", code: "KeyE", meta: true, control: false, alt: false, shift: true }]]);
});

test("⌘, reaches the renderer from any frame, so Settings opens with a design or HTML reply focused", () => {
  const contents = new EventEmitter();
  const sent = [];
  contents.send = (...args) => sent.push(args);
  forwardAppShortcuts(contents, "darwin", new EventEmitter());
  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  contents.emit("before-input-event", event, key(",", { shift: false }));
  contents.emit("before-input-event", event, key(",", { shift: false, type: "keyUp" }));
  contents.emit("before-input-event", event, key(",", { shift: false, alt: true }));
  assert.equal(prevented, 1);
  assert.equal(sent.length, 1);
  assert.equal(isAppShortcut(key(",", { shift: false, meta: false, control: true }), "linux"), true);
  assert.equal(isAppShortcut(key(","), "darwin"), false, "⌘⇧, is not ⌘,");
});

test("the caught keys follow keybindings.json", () => {
  try {
    setForwardedRules([
      ...defaultKeybindings().filter((rule) => rule.command !== "designs.toggle"),
      { key: "mod+alt+g", command: "designs.toggle" },
      { key: "mod+shift+g", command: "chat.new" },
    ]);
    assert.equal(isAppShortcut(key("E"), "darwin"), false, "⌘⇧E moved away");
    assert.equal(isAppShortcut(key("©", { code: "KeyG", shift: false, alt: true }), "darwin"), true, "⌥ letters match by physical key");
    assert.equal(isAppShortcut(key("G"), "darwin"), false, "chat.new isn't caught from frames");
  } finally {
    setForwardedRules(defaultKeybindings());
  }
});

test("⌘W closes the focused Terminal and is swallowed otherwise", () => {
  const contents = new EventEmitter();
  const ipc = new EventEmitter();
  const sent = [];
  contents.send = (...args) => sent.push(args);
  forwardAppShortcuts(contents, "darwin", ipc);
  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  const close = key("w", { shift: false });
  contents.emit("before-input-event", event, close);
  assert.equal(prevented, 1, "the window menu never sees ⌘W");
  assert.deepEqual(sent, []);
  ipc.emit("app:terminal-focused", { sender: contents }, true);
  ipc.emit("app:terminal-focused", { sender: new EventEmitter() }, false);
  contents.emit("before-input-event", event, close);
  assert.equal(prevented, 2);
  assert.deepEqual(sent, [["app:close-focused-terminal"]]);
  ipc.emit("app:terminal-focused", { sender: contents }, false);
  contents.emit("before-input-event", event, close);
  assert.equal(prevented, 3);
  assert.deepEqual(sent, [["app:close-focused-terminal"]]);
  assert.equal(isCloseKey(key("w", { shift: false, meta: false, control: true }), "win32"), true);
  assert.equal(isCloseKey(key("w"), "darwin"), false, "⌘⇧W is not ⌘W");
  contents.emit("destroyed");
  assert.equal(ipc.listenerCount("app:terminal-focused"), 0);
});

test("⌘Q asks through onQuitKey instead of the menu", () => {
  const contents = new EventEmitter();
  contents.send = () => {};
  let asked = 0;
  forwardAppShortcuts(contents, "darwin", new EventEmitter(), () => asked++);
  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  contents.emit("before-input-event", event, key("q", { shift: false }));
  contents.emit("before-input-event", event, key("q", { shift: false, type: "keyUp" }));
  assert.equal(asked, 1);
  assert.equal(prevented, 1);
});
