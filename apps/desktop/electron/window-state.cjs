const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

function getWindowState() {
  const statePath = path.join(app.getPath("userData"), "window-state.json");
  /** @type {{ width: number, height: number, x?: number, y?: number, minWidth: number, minHeight: number }} */
  const defaultState = {
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 680,
  };

  let state = { ...defaultState };

  try {
    if (fs.existsSync(statePath)) {
      const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
      state = { ...defaultState, ...stored };
    }
  } catch {}

  return { state, statePath };
}

function manageWindowState(window, statePath) {
  let saveTimeout;

  function saveState() {
    try {
      const bounds = window.getBounds();
      fs.writeFileSync(statePath, JSON.stringify(bounds));
    } catch {}
  }

  function scheduleSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveState, 500);
  }

  window.on("resize", scheduleSave);
  window.on("move", scheduleSave);
  window.on("close", saveState);
}

module.exports = { getWindowState, manageWindowState };
