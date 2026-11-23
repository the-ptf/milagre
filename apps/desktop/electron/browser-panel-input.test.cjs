const test = require("node:test");
const assert = require("node:assert/strict");
const { keyEvents, pageInput } = require("./browser-panel-input.cjs");

test("a DevTools key becomes the guest's own key events, with the editing commands it carries", () => {
  assert.deepEqual(keyEvents({ type: "keyDown", key: "a", code: "KeyA", text: "a" }).events, [
    { type: "keyDown", keyCode: "a", modifiers: [] },
    { type: "char", keyCode: "a", modifiers: [] },
  ]);
  assert.deepEqual(keyEvents({ type: "rawKeyDown", key: "ArrowLeft", code: "ArrowLeft", modifiers: 8 }).events, [
    { type: "keyDown", keyCode: "Left", modifiers: ["shift"] },
  ]);
  assert.deepEqual(keyEvents({ type: "keyUp", key: " ", code: "Space" }).events, [{ type: "keyUp", keyCode: "Space", modifiers: [] }]);
  assert.deepEqual(keyEvents({ type: "char", text: "é" }).events, [{ type: "char", keyCode: "é", modifiers: [] }]);
  // A viewer's ⌘A: the key, then the page selects all itself; an unknown command is dropped.
  assert.deepEqual(keyEvents({ type: "rawKeyDown", key: "a", code: "KeyA", modifiers: 4, commands: ["selectAll", "frobnicate"] }), {
    events: [{ type: "keyDown", keyCode: "a", modifiers: ["meta"] }],
    commands: ["selectAll"],
  });
  assert.deepEqual(keyEvents({ type: "keyUp", key: "a", modifiers: 6, commands: ["selectAll"] }).commands, []);
});

function fakes({ inserted = true } = {}) {
  const guest = { inputs: [], isDestroyed: () => false, sendInputEvent: (event) => guest.inputs.push(event) };
  const debug = {
    commands: [],
    sendCommand: async (method, params) => {
      debug.commands.push([method, params]);
      return { result: { value: inserted } };
    },
  };
  return { guest, debug };
}

test("text goes in through the page's own editing, and only other commands reach the debugger", async () => {
  const { guest, debug } = fakes();
  assert.equal(pageInput(guest, debug, "Runtime.evaluate", {}), null);
  assert.deepEqual(await pageInput(guest, debug, "Input.insertText", { text: 'say "hi"' }), {});
  assert.equal(debug.commands.length, 1);
  assert.equal(debug.commands[0][0], "Runtime.evaluate");
  assert.match(debug.commands[0][1].expression, /\("say \\"hi\\"", \[\]\)$/);
  assert.deepEqual(guest.inputs, []);
});

test("text the page's document can't take (a cross-origin frame has the focus) goes as characters to the guest", async () => {
  const { guest, debug } = fakes({ inserted: false });
  await pageInput(guest, debug, "Input.insertText", { text: "ok😀" });
  assert.deepEqual(
    guest.inputs.map((event) => event.keyCode),
    ["o", "k", "😀"],
  );
});

test("keys go to the guest's widget, and a page that is gone refuses them", async () => {
  const { guest, debug } = fakes();
  await pageInput(guest, debug, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", modifiers: 4, commands: ["selectAll"] });
  assert.deepEqual(guest.inputs, [{ type: "keyDown", keyCode: "a", modifiers: ["meta"] }]);
  assert.match(debug.commands[0][1].expression, /\("", \["selectAll"\]\)$/);
  guest.isDestroyed = () => true;
  await assert.rejects(pageInput(guest, debug, "Input.insertText", { text: "x" }), /The page is gone/);
});
