// Links in agent replies open in the user's browser. The app window itself never navigates away from Milagre.
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function externalUrl(url) {
  try {
    const parsed = new URL(url);
    return EXTERNAL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

// The dev server is matched by origin; a packaged build loads one file, matched by path.
function isAppUrl(url, appUrl) {
  try {
    const target = new URL(url);
    const app = new URL(appUrl);
    return app.protocol === "file:" ? target.protocol === "file:" && target.pathname === app.pathname : target.origin === app.origin;
  } catch {
    return false;
  }
}

function guardNavigation(webContents, { appUrl, openExternal }) {
  const leave = (url) => {
    const target = externalUrl(url);
    if (target) openExternal(target);
  };
  webContents.setWindowOpenHandler(({ url }) => {
    leave(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url, appUrl)) return;
    event.preventDefault();
    leave(url);
  });
  // will-navigate is the main frame's alone. An embedded frame (a design, the simulator viewer) stays on the document
  // the app gave it: a design that sets location to a remote page would show that page inside the app, without the
  // policy its srcdoc carried.
  webContents.on("will-frame-navigate", (event) => {
    if (/^milagre-artifact:\/\/preview\/[a-f0-9]{48}$/.test(event.url)) return;
    if (event.isMainFrame || isAppUrl(event.url, appUrl) || /^about:(srcdoc|blank)$/.test(event.url)) return;
    event.preventDefault();
  });
}

module.exports = { externalUrl, guardNavigation };
