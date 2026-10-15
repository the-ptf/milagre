const assert = require("node:assert/strict");
const test = require("node:test");
const { applyWindowBackground, OPAQUE_BACKGROUND } = require("./window-background.cjs");

function fakeWindow() {
  return {
    calls: [],
    setBackgroundColor(color) {
      this.calls.push(color);
    },
  };
}

test("the window takes the theme's page color", () => {
  const window = fakeWindow();
  applyWindowBackground(window, "#1e1e2e");
  assert.deepEqual(window.calls, ["#1e1e2e"]);
});

test("a missing or bad background keeps the default", () => {
  for (const background of [undefined, "red; drop", "#fff", "#00000000"]) {
    const window = fakeWindow();
    applyWindowBackground(window, background);
    assert.deepEqual(window.calls, [OPAQUE_BACKGROUND]);
  }
});
