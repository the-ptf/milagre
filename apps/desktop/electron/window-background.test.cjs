const assert = require("node:assert/strict");
const test = require("node:test");
const { applyWindowBackground, OPAQUE_BACKGROUND } = require("./window-background.cjs");

function fakeWindow() {
  return {
    calls: [],
    overlays: [],
    setBackgroundColor(color) {
      this.calls.push(color);
    },
    setTitleBarOverlay(options) {
      this.overlays.push(options);
    },
  };
}

test("the window takes the theme's page color", () => {
  const window = fakeWindow();
  applyWindowBackground(window, "#1e1e2e");
  assert.deepEqual(window.calls, ["#1e1e2e"]);
});

test("Windows controls stay transparent and legible when the theme changes", () => {
  const window = fakeWindow();
  applyWindowBackground(window, "#1e1e2e", "win32");
  applyWindowBackground(window, "#f4f9fe", "win32");
  assert.deepEqual(window.overlays, [
    { color: "#00000000", symbolColor: "#ffffff" },
    { color: "#00000000", symbolColor: "#000000" },
  ]);
});

test("other platforms keep their existing native control colors", () => {
  for (const platform of ["darwin", "linux"]) {
    const window = fakeWindow();
    applyWindowBackground(window, "#1e1e2e", platform);
    assert.deepEqual(window.overlays, []);
  }
});

test("a missing or bad background keeps the default", () => {
  for (const background of [undefined, "red; drop", "#fff", "#00000000"]) {
    const window = fakeWindow();
    applyWindowBackground(window, background);
    assert.deepEqual(window.calls, [OPAQUE_BACKGROUND]);
  }
});
