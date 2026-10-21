const assert = require("node:assert/strict");
const test = require("node:test");
const { windowChrome } = require("./window-chrome.cjs");

test("macOS keeps traffic lights aligned to the 22px toolbar center", () => {
  const chrome = windowChrome("darwin");
  assert.equal(chrome.controls, "leading");
  assert.equal(chrome.options.trafficLightPosition.y + 6, 22);
  assert.equal(chrome.options.titleBarOverlay.height, 44);
});

test("Linux keeps external decorations unless integrated controls are requested", () => {
  assert.deepEqual(windowChrome("linux"), { controls: "external", options: {} });
});

test("Windows integrates window controls and hides the native menu row by default", () => {
  const chrome = windowChrome("win32");
  assert.equal(chrome.controls, "overlay");
  assert.equal(chrome.options.titleBarStyle, "hidden");
  assert.equal(chrome.options.titleBarOverlay.height, 44);
  assert.equal(chrome.options.autoHideMenuBar, true);
});

test("the integrated mode supplies Electron controls on desktops without native decorations", () => {
  const chrome = windowChrome("linux", true);
  assert.equal(chrome.controls, "overlay");
  assert.equal(chrome.options.titleBarStyle, "hidden");
  assert.equal(chrome.options.titleBarOverlay.height, 44);
});
