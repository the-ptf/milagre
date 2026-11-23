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

/** A frame that runs scripts in a fake document: `outcome` answers the insert, `focusedHere` the focus probe. */
function fakeFrame({ outcome = "done", focusedHere = false } = {}) {
  const frame = {
    scripts: [],
    executeJavaScript: async (script) => {
      frame.scripts.push(script);
      return script.startsWith("(() =>") ? focusedHere : outcome;
    },
  };
  return frame;
}

function fakes(top = fakeFrame(), children = []) {
  top.framesInSubtree = [top, ...children];
  const guest = { inputs: [], mainFrame: top, isDestroyed: () => false, sendInputEvent: (event) => guest.inputs.push(event) };
  return guest;
}

test("text goes in through the page's own editing, and other commands are left to the debugger", async () => {
  const guest = fakes();
  assert.equal(pageInput(guest, "Runtime.evaluate", {}), null);
  assert.deepEqual(await pageInput(guest, "Input.insertText", { text: 'say "hi"' }), {});
  assert.equal(guest.mainFrame.scripts.length, 1);
  assert.match(guest.mainFrame.scripts[0], /\("say \\"hi\\"", \[\]\)$/);
  assert.deepEqual(guest.inputs, []);
});

test("a read-only or disabled field takes no text, and its value is never written directly", () => {
  // The script the page runs: it stops before execCommand and setRangeText for such a field.
  const guest = fakes();
  void pageInput(guest, "Input.insertText", { text: "x" });
  const script = guest.mainFrame.scripts[0];
  const readOnly = script.indexOf("element.readOnly || element.disabled");
  assert.ok(readOnly > 0 && readOnly < script.indexOf('execCommand("insertText"') && readOnly < script.indexOf("setRangeText("));
});

test("with the focus in a cross-origin frame, the text and the commands run in that frame", async () => {
  const holder = fakeFrame({ focusedHere: true });
  const idle = fakeFrame();
  const guest = fakes(fakeFrame({ outcome: "frame" }), [idle, holder]);
  await pageInput(guest, "Input.insertText", { text: "novo" });
  assert.match(holder.scripts.at(-1), /\("novo", \[\]\)$/);
  assert.equal(idle.scripts.filter((script) => !script.startsWith("(() =>")).length, 0);
  await pageInput(guest, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", modifiers: 4, commands: ["selectAll"] });
  assert.match(holder.scripts.at(-1), /\("", \["selectAll"\]\)$/);
  assert.deepEqual(guest.inputs, [{ type: "keyDown", keyCode: "a", modifiers: ["meta"] }]);
});

test("a command the page's focused field can't be reached for is reported, not claimed done", async () => {
  // Two frames claim the focus: neither is picked.
  const guest = fakes(fakeFrame({ outcome: "frame" }), [fakeFrame({ focusedHere: true }), fakeFrame({ focusedHere: true })]);
  await assert.rejects(
    pageInput(guest, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", modifiers: 4, commands: ["selectAll"] }),
    /couldn't be reached to run selectAll/,
  );
  // Text no document took goes as characters to the guest's widget, which types into whatever it has focused.
  await pageInput(guest, "Input.insertText", { text: "ok😀" });
  assert.deepEqual(
    guest.inputs.slice(1).map((event) => event.keyCode),
    ["o", "k", "😀"],
  );
});

test("a page that is gone refuses text and keys", async () => {
  const guest = fakes();
  guest.isDestroyed = () => true;
  await assert.rejects(pageInput(guest, "Input.insertText", { text: "x" }), /The page is gone/);
});
