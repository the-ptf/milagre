// @ts-check

/**
 * Native decorations live outside the web content. An overlay owns its controls even on a Linux desktop
 * that does not draw server-side decorations; Chromium reports the remaining title-bar area to the renderer.
 * @param {NodeJS.Platform} platform
 * @param {boolean} overlay
 * @returns {{ controls: "leading" | "overlay" | "external", options: Electron.BrowserWindowConstructorOptions }}
 */
function windowChrome(platform, overlay = false) {
  if (platform === "darwin") {
    return {
      controls: "leading",
      options: { titleBarStyle: "hidden", titleBarOverlay: { height: 44 }, trafficLightPosition: { x: 16, y: 16 } },
    };
  }
  if (platform === "win32" || overlay) {
    return {
      controls: "overlay",
      options: {
        titleBarStyle: "hidden",
        titleBarOverlay: { height: 44, ...(platform === "win32" ? { color: "#00000000", symbolColor: "#000000" } : {}) },
        ...(platform === "win32" ? { autoHideMenuBar: true } : {}),
      },
    };
  }
  return { controls: "external", options: {} };
}

module.exports = { windowChrome };
